const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Utility functions
const logger = {
  info: (msg, data = {}) => console.log(`[INFO] ${msg}`, data),
  error: (msg, data = {}) => console.error(`[ERROR] ${msg}`, data),
  debug: (msg, data = {}) => console.log(`[DEBUG] ${msg}`, data)
};

// Configuration
const config = {
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER || '+16508661851',
    webhookUrl: process.env.WEBHOOK_BASE_URL || 'https://bot-interview.onrender.com'
  },
  vapi: {
    apiKey: process.env.VAPI_API_KEY,
    interviewer: {
      phoneNumber: process.env.VAPI_INTERVIEWER_PHONE,
      assistantId: process.env.VAPI_INTERVIEWER_ASSISTANT_ID
    },
    candidate: {
      phoneNumber: process.env.VAPI_CANDIDATE_PHONE,
      assistantId: process.env.VAPI_CANDIDATE_ASSISTANT_ID
    }
  },
  testTimeout: 10 * 60 * 1000, // 10 minutes
  port: process.env.PORT || 3000
};

// Validate required environment variables
const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'VAPI_API_KEY',
  'VAPI_INTERVIEWER_PHONE',
  'VAPI_CANDIDATE_PHONE'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  logger.error('Missing required environment variables:', missingVars.join(', '));
  logger.error('Please check your environment variables on Render.');
  process.exit(1);
}

// Initialize Twilio client
let twilioClient;
try {
  twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  logger.info('Twilio client initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Twilio client:', error.message);
  process.exit(1);
}

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage
const storage = {
  testRuns: new Map(),
  transcripts: new Map(),
  events: new Map(),
  assistants: new Map() // Track created assistants for cleanup
};

// Personas for candidate agent
const personas = {
  nervous: {
    name: "Nervous Fresher",
    interviewerPrompt: `You are an experienced HR interviewer conducting a job interview. Be professional, ask standard interview questions like "Tell me about yourself", "What are your strengths and weaknesses?", "Why do you want this job?". Listen to responses and ask follow-up questions. Keep the interview flowing naturally for about 5-10 minutes.`,
    candidatePrompt: `You are a nervous recent graduate interviewing for your first job. You're eager to please but anxious. Tend to over-explain answers, say 'um' and 'like' frequently, and second-guess yourself. Be enthusiastic but show uncertainty. Answer questions but ask for clarification when nervous.`,
    voice: "alloy"
  },
  confident: {
    name: "Overconfident Candidate", 
    interviewerPrompt: `You are an experienced HR interviewer conducting a job interview. Be professional but don't let the candidate dominate. Ask standard interview questions and follow-ups. If they interrupt or seem overconfident, gently redirect. Maintain control of the interview pace.`,
    candidatePrompt: `You are an overconfident job candidate. Give brief, assertive answers. Show supreme confidence in your abilities, even when you might not know something. Be direct and slightly pushy. Sometimes try to steer the conversation to your achievements.`,
    voice: "echo"
  },
  experienced: {
    name: "Senior Professional",
    interviewerPrompt: `You are an experienced HR interviewer talking to a senior candidate. Ask more advanced questions about leadership, strategy, and past experiences. Be respectful of their experience while still conducting a thorough interview.`,
    candidatePrompt: `You are a seasoned professional with 10+ years of experience. Give thoughtful, detailed responses with specific examples from your career. Speak calmly and confidently. Ask clarifying questions when appropriate and show strategic thinking.`,
    voice: "fable"
  }
};

const generateRunId = () => `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Storage helpers
const saveEvent = (runId, eventType, data) => {
  if (!storage.events.has(runId)) {
    storage.events.set(runId, []);
  }
  storage.events.get(runId).push({
    timestamp: new Date().toISOString(),
    type: eventType,
    data
  });
};

const saveTranscript = (runId, participantType, text, isFinal = false) => {
  if (!storage.transcripts.has(runId)) {
    storage.transcripts.set(runId, []);
  }
  storage.transcripts.get(runId).push({
    timestamp: new Date().toISOString(),
    participant: participantType,
    text,
    final: isFinal
  });
};

// Vapi API helper functions
const createVapiAssistant = async (name, systemPrompt, voice = 'alloy') => {
  try {
    const response = await axios.post('https://api.vapi.ai/assistant', {
      name: name,
      model: {
        provider: 'openai',
        model: 'gpt-4',
        systemMessage: systemPrompt,
        temperature: 0.7
      },
      voice: {
        provider: 'openai',
        voiceId: voice
      },
      firstMessage: name.includes('Interviewer') ? 
        "Hello! Thank you for joining today's interview. Please introduce yourself and tell me a bit about your background." :
        "Hi! I'm ready for the interview. Thank you for this opportunity.",
      transcriber: {
        provider: 'deepgram',
        model: 'nova-2',
        language: 'en'
      },
      endCallMessage: "Thank you for the interview. Have a great day!",
      recordingEnabled: true
    }, {
      headers: {
        'Authorization': `Bearer ${config.vapi.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    logger.info(`Vapi assistant created: ${name}`, { id: response.data.id });
    return response.data;
  } catch (error) {
    logger.error(`Failed to create Vapi assistant ${name}:`, error.response?.data || error.message);
    throw error;
  }
};

// Create a direct Vapi-to-Vapi call
const createDirectVapiCall = async (fromAssistantId, toPhoneNumber, fromPhoneNumber) => {
  try {
    const response = await axios.post('https://api.vapi.ai/call', {
      type: 'outboundPhoneCall',
      assistantId: fromAssistantId,
      customer: {
        number: toPhoneNumber
      },
      phoneNumberId: fromPhoneNumber // Use phoneNumberId if you have Vapi phone number IDs
    }, {
      headers: {
        'Authorization': `Bearer ${config.vapi.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    logger.info(`Direct Vapi call created from ${fromPhoneNumber} to ${toPhoneNumber}:`, { id: response.data.id });
    return response.data;
  } catch (error) {
    logger.error(`Failed to create direct Vapi call:`, error.response?.data || error.message);
    throw error;
  }
};

// Alternative: Use Twilio to orchestrate the call
const createTwilioOrchestrationCall = async (runId, interviewerAssistant, candidateAssistant) => {
  try {
    logger.info('Creating Twilio-orchestrated call between Vapi agents...');
    
    // Step 1: Call the interviewer's Vapi number and set up conference
    const interviewerCall = await twilioClient.calls.create({
      to: config.vapi.interviewer.phoneNumber,
      from: config.twilio.fromNumber,
      twiml: `<Response>
        <Say>Connecting you to the interview candidate...</Say>
        <Pause length="2"/>
        <Dial>
          <Number statusCallback="${config.twilio.webhookUrl}/twilio/call-status" 
                  statusCallbackEvent="answered,completed,busy,no-answer" 
                  statusCallbackMethod="POST">
            ${config.vapi.candidate.phoneNumber}
          </Number>
        </Dial>
      </Response>`,
      statusCallback: `${config.twilio.webhookUrl}/twilio/call-status`,
      statusCallbackEvent: ['answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: 'record-from-start',
      recordingStatusCallback: `${config.twilio.webhookUrl}/twilio/recording-status`
    });

    logger.info(`Orchestration call created: ${interviewerCall.sid}`);
    return interviewerCall;

  } catch (error) {
    logger.error('Failed to create orchestration call:', error.message);
    throw error;
  }
};

// Clean up transient assistants
const deleteVapiAssistant = async (assistantId) => {
  try {
    await axios.delete(`https://api.vapi.ai/assistant/${assistantId}`, {
      headers: {
        'Authorization': `Bearer ${config.vapi.apiKey}`
      }
    });
    logger.info(`Deleted transient assistant: ${assistantId}`);
  } catch (error) {
    logger.error(`Failed to delete assistant ${assistantId}:`, error.message);
  }
};

// Main test start function
const startTest = async (req, res) => {
  const { persona = 'nervous', scenarioId = 'default', duration = 600 } = req.body;
  const runId = generateRunId();
  
  try {
    logger.info(`Starting test run ${runId} with persona: ${persona}`);
    
    const selectedPersona = personas[persona];
    if (!selectedPersona) {
      throw new Error(`Invalid persona: ${persona}`);
    }

    // Store test run
    storage.testRuns.set(runId, {
      runId,
      scenarioId,
      persona,
      status: 'creating_assistants',
      startTime: new Date().toISOString(),
      duration: duration,
      assistants: {},
      calls: {}
    });

    saveEvent(runId, 'test_started', { persona, scenarioId, duration });

    // Create temporary assistants for this test
    logger.info('Creating interviewer assistant...');
    const interviewerAssistant = await createVapiAssistant(
      `Interviewer_${runId}`,
      selectedPersona.interviewerPrompt,
      'alloy'
    );

    logger.info('Creating candidate assistant...');
    const candidateAssistant = await createVapiAssistant(
      `Candidate_${runId}`,
      selectedPersona.candidatePrompt,
      selectedPersona.voice
    );

    // Store assistant IDs for cleanup
    const testRun = storage.testRuns.get(runId);
    testRun.assistants = {
      interviewer: interviewerAssistant.id,
      candidate: candidateAssistant.id
    };
    
    // Also store in global assistants map for cleanup
    storage.assistants.set(interviewerAssistant.id, { runId, role: 'interviewer' });
    storage.assistants.set(candidateAssistant.id, { runId, role: 'candidate' });

    saveEvent(runId, 'assistants_created', testRun.assistants);

    // Method 1: Try direct Vapi-to-Vapi call (if supported)
    try {
      logger.info('Attempting direct Vapi call...');
      
      // Update the interviewer assistant to call the candidate
      await axios.patch(`https://api.vapi.ai/assistant/${interviewerAssistant.id}`, {
        firstMessage: `Hello! I'm calling to conduct your job interview. Are you ready to begin? Please start by telling me about yourself.`
      }, {
        headers: {
          'Authorization': `Bearer ${config.vapi.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      const directCall = await createDirectVapiCall(
        interviewerAssistant.id,
        config.vapi.candidate.phoneNumber,
        config.vapi.interviewer.phoneNumber
      );

      testRun.calls = {
        method: 'direct_vapi',
        directCallId: directCall.id,
        status: 'connecting'
      };
      testRun.status = 'connecting';

      saveEvent(runId, 'direct_call_created', { callId: directCall.id });

      // Set up timeout to end the test
      setTimeout(() => {
        stopTest(runId);
      }, duration * 1000);

      res.json({
        success: true,
        runId,
        status: 'connecting',
        message: 'Direct Vapi call initiated. Interviewer calling candidate...',
        method: 'direct_vapi',
        callId: directCall.id
      });

    } catch (directCallError) {
      logger.error('Direct Vapi call failed, using Twilio orchestration:', directCallError.message);
      
      // Method 2: Fallback to Twilio orchestration
      const orchestrationCall = await createTwilioOrchestrationCall(
        runId,
        interviewerAssistant,
        candidateAssistant
      );

      testRun.calls = {
        method: 'twilio_orchestration',
        orchestrationCallSid: orchestrationCall.sid,
        status: 'connecting'
      };
      testRun.status = 'connecting';

      saveEvent(runId, 'orchestration_call_created', { callSid: orchestrationCall.sid });

      // Set up timeout to end the test
      setTimeout(() => {
        stopTest(runId);
      }, duration * 1000);

      res.json({
        success: true,
        runId,
        status: 'connecting',
        message: 'Twilio orchestration call initiated. Connecting interviewer to candidate...',
        method: 'twilio_orchestration',
        callSid: orchestrationCall.sid
      });
    }

  } catch (error) {
    logger.error(`Failed to start test ${runId}:`, error.message);
    
    // Cleanup on failure
    const testRun = storage.testRuns.get(runId);
    if (testRun?.assistants) {
      if (testRun.assistants.interviewer) {
        await deleteVapiAssistant(testRun.assistants.interviewer);
      }
      if (testRun.assistants.candidate) {
        await deleteVapiAssistant(testRun.assistants.candidate);
      }
    }

    res.status(500).json({
      success: false,
      error: error.message,
      runId
    });
  }
};

// Enhanced stop test function
const stopTest = async (runId) => {
  try {
    const testRun = storage.testRuns.get(runId);
    if (!testRun || testRun.status === 'completed') {
      return;
    }

    logger.info(`Stopping test run ${runId}`);

    // End Twilio calls if using orchestration method
    if (testRun.calls?.orchestrationCallSid) {
      try {
        await twilioClient.calls(testRun.calls.orchestrationCallSid)
          .update({ status: 'completed' });
        logger.info(`Ended orchestration call: ${testRun.calls.orchestrationCallSid}`);
      } catch (error) {
        logger.error(`Failed to end orchestration call: ${error.message}`);
      }
    }

    // End Vapi calls if using direct method
    if (testRun.calls?.directCallId) {
      try {
        await axios.patch(`https://api.vapi.ai/call/${testRun.calls.directCallId}`, 
          { status: 'ended' },
          { headers: { 'Authorization': `Bearer ${config.vapi.apiKey}` } }
        );
        logger.info(`Ended direct Vapi call: ${testRun.calls.directCallId}`);
      } catch (error) {
        logger.error(`Failed to end direct Vapi call: ${error.message}`);
      }
    }

    // Clean up transient assistants
    if (testRun.assistants) {
      if (testRun.assistants.interviewer) {
        await deleteVapiAssistant(testRun.assistants.interviewer);
        storage.assistants.delete(testRun.assistants.interviewer);
      }
      if (testRun.assistants.candidate) {
        await deleteVapiAssistant(testRun.assistants.candidate);
        storage.assistants.delete(testRun.assistants.candidate);
      }
      saveEvent(runId, 'assistants_deleted', testRun.assistants);
    }

    // Update status
    testRun.status = 'completed';
    testRun.endTime = new Date().toISOString();
    
    const duration = new Date(testRun.endTime) - new Date(testRun.startTime);
    saveEvent(runId, 'test_completed', { duration });

    logger.info(`Test run ${runId} completed and cleaned up`);

  } catch (error) {
    logger.error(`Failed to stop test ${runId}:`, error.message);
  }
};

// API Endpoints
app.post('/tests/start', startTest);

app.post('/tests/:runId/stop', async (req, res) => {
  const { runId } = req.params;
  
  try {
    await stopTest(runId);
    res.json({ success: true, message: `Test ${runId} stopped` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/tests/:runId', (req, res) => {
  const { runId } = req.params;
  const testRun = storage.testRuns.get(runId);
  
  if (!testRun) {
    return res.status(404).json({ success: false, error: 'Test run not found' });
  }

  const events = storage.events.get(runId) || [];
  const transcripts = storage.transcripts.get(runId) || [];

  res.json({
    success: true,
    testRun,
    events,
    transcripts
  });
});

app.get('/tests', (req, res) => {
  const tests = Array.from(storage.testRuns.values());
  res.json({ success: true, tests });
});

// Twilio webhooks
app.post('/twilio/voice', (req, res) => {
  const { CallSid, From, To } = req.body;
  logger.info('Voice webhook received', { CallSid, From, To });
  
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Connecting to interview...');
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/twilio/call-status', (req, res) => {
  const { CallSid, CallStatus, From, To } = req.body;
  logger.info('Call status update', { CallSid, CallStatus, From, To });
  
  // Find test run by orchestration call SID
  const testRun = Array.from(storage.testRuns.values())
    .find(run => run.calls?.orchestrationCallSid === CallSid);
  
  if (testRun) {
    testRun.calls.status = CallStatus;
    
    if (CallStatus === 'in-progress') {
      testRun.status = 'active';
      testRun.calls.connectTime = new Date().toISOString();
    } else if (CallStatus === 'completed') {
      testRun.status = 'completed';
      testRun.calls.disconnectTime = new Date().toISOString();
      if (!testRun.endTime) {
        testRun.endTime = new Date().toISOString();
      }
    }
    
    saveEvent(testRun.runId, 'call_status', { 
      callSid: CallSid,
      status: CallStatus,
      method: 'twilio_orchestration'
    });
  }
  
  res.sendStatus(200);
});

app.post('/twilio/recording-status', (req, res) => {
  const { RecordingSid, RecordingStatus, RecordingUrl, CallSid } = req.body;
  logger.info('Recording status update', { RecordingSid, RecordingStatus, RecordingUrl });
  
  // Find test run and save recording info
  const testRun = Array.from(storage.testRuns.values())
    .find(run => run.calls?.orchestrationCallSid === CallSid);
  
  if (testRun && RecordingStatus === 'completed') {
    if (!testRun.recordings) testRun.recordings = [];
    testRun.recordings.push({
      sid: RecordingSid,
      url: RecordingUrl,
      callSid: CallSid,
      timestamp: new Date().toISOString()
    });
    
    saveEvent(testRun.runId, 'recording_completed', { 
      recordingSid: RecordingSid,
      recordingUrl: RecordingUrl 
    });
  }
  
  res.sendStatus(200);
});

// Vapi webhook for transcripts and call events
app.post('/vapi/webhook', (req, res) => {
  const { type, call, transcript, assistantId } = req.body;
  
  logger.info('Vapi webhook received', { type, callId: call?.id, assistantId });
  
  // Find test run by assistant ID or call ID
  let testRun = null;
  
  if (assistantId && storage.assistants.has(assistantId)) {
    const assistantInfo = storage.assistants.get(assistantId);
    testRun = storage.testRuns.get(assistantInfo.runId);
  }
  
  if (!testRun && call?.id) {
    testRun = Array.from(storage.testRuns.values())
      .find(run => run.calls?.directCallId === call?.id);
  }
  
  if (testRun) {
    // Handle different webhook types
    switch (type) {
      case 'call-started':
        testRun.status = 'active';
        testRun.calls.status = 'active';
        testRun.calls.startTime = new Date().toISOString();
        saveEvent(testRun.runId, 'vapi_call_started', { callId: call?.id });
        break;
        
      case 'call-ended':
        if (testRun.status !== 'completed') {
          testRun.status = 'completed';
          testRun.endTime = new Date().toISOString();
        }
        testRun.calls.status = 'completed';
        testRun.calls.endTime = new Date().toISOString();
        saveEvent(testRun.runId, 'vapi_call_ended', { callId: call?.id });
        break;
        
      case 'transcript':
        if (transcript) {
          const participantType = storage.assistants.get(assistantId)?.role || 'unknown';
          saveTranscript(testRun.runId, participantType, transcript.text, transcript.isFinal);
          saveEvent(testRun.runId, 'transcript', {
            participant: participantType,
            text: transcript.text,
            isFinal: transcript.isFinal
          });
        }
        break;
        
      default:
        logger.debug(`Unhandled Vapi webhook type: ${type}`);
    }
  }
  
  res.sendStatus(200);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeTests: Array.from(storage.testRuns.values()).filter(t => ['connecting', 'active'].includes(t.status)).length,
    totalTests: storage.testRuns.size,
    config: {
      twilioConfigured: !!(config.twilio.accountSid && config.twilio.authToken),
      vapiApiConfigured: !!config.vapi.apiKey,
      interviewerPhoneConfigured: !!config.vapi.interviewer.phoneNumber,
      candidatePhoneConfigured: !!config.vapi.candidate.phoneNumber
    }
  });
});

// Debug endpoint
app.get('/debug', async (req, res) => {
  try {
    const account = await twilioClient.api.accounts(config.twilio.accountSid).fetch();
    
    res.json({
      success: true,
      account: account.friendlyName,
      config: {
        webhookUrl: config.twilio.webhookUrl,
        fromNumber: config.twilio.fromNumber,
        interviewerPhone: config.vapi.interviewer.phoneNumber,
        candidatePhone: config.vapi.candidate.phoneNumber,
        hasVapiApiKey: !!config.vapi.apiKey
      },
      activeTests: Array.from(storage.testRuns.values()).filter(t => ['connecting', 'active'].includes(t.status)),
      activeAssistants: Array.from(storage.assistants.keys()).length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Enhanced web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>AI Interview Test System - Fixed</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
            .container { max-width: 1000px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .form-group { margin: 20px 0; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            select, input, button { padding: 12px; margin: 5px 0; border-radius: 5px; border: 1px solid #ddd; }
            button { background: #007bff; color: white; border: none; cursor: pointer; font-weight: bold; }
            button:hover { background: #0056b3; }
            .status { margin: 20px 0; padding: 15px; border-radius: 5px; }
            .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
            .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
            .info { background: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460; }
            .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
            .test-list { margin-top: 30px; }
            .test-item { padding: 15px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; background: #f8f9fa; }
            pre { background: #f8f9fa; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
            .header { text-align: center; margin-bottom: 30px; }
            .config-info { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 20px 0; font-size: 14px; }
            .form-row { display: flex; gap: 20px; align-items: end; }
            .form-row .form-group { flex: 1; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>AI Interview Test System</h1>
                <p>Direct Call Implementation - Fixed</p>
            </div>

            <div class="config-info">
                <strong>How it works:</strong><br>
                1. Creates temporary interviewer and candidate assistants<br>
                2. Tries direct Vapi-to-Vapi call (interviewer calls candidate)<br>
                3. Falls back to Twilio orchestration if direct call fails<br>
                4. Cleans up assistants after test completion<br><br>
                <strong>Required:</strong> VAPI_INTERVIEWER_PHONE, VAPI_CANDIDATE_PHONE, VAPI_API_KEY
            </div>
            
            <div class="form-row">
                <div class="form-group">
                    <label for="persona">Candidate Persona:</label>
                    <select id="persona">
                        <option value="nervous">Nervous Fresher - Anxious recent graduate</option>
                        <option value="confident">Overconfident Candidate - Assertive and direct</option>
                        <option value="experienced">Senior Professional - Calm and experienced</option>
                    </select>
                </div>
                
                <div class="form-group">
                    <label for="duration">Test Duration (seconds):</label>
                    <input type="number" id="duration" value="300" min="60" max="1800">
                </div>
            </div>

            <div class="form-group">
                <button onclick="startTest()" style="width: 200px; margin-right: 10px;">Start Interview Test</button>
                <button onclick="loadTests()" style="width: 150px; background: #28a745;">Refresh</button>
                <button onclick="checkHealth()" style="width: 150px; background: #6c757d;">Health Check</button>
                <button onclick="checkDebug()" style="width: 150px; background: #17a2b8;">Debug Info</button>
            </div>

            <div id="status"></div>
            <div id="testList" class="test-list"></div>
        </div>

        <script>
            let currentRunId = null;
            let refreshInterval = null;

            async function startTest() {
                const persona = document.getElementById('persona').value;
                const duration = parseInt(document.getElementById('duration').value);
                const statusDiv = document.getElementById('status');
                
                try {
                    statusDiv.innerHTML = '<div class="status info">Creating assistants and starting interview test...</div>';
                    
                    const response = await fetch('/tests/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ persona, duration })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        currentRunId = result.runId;
                        statusDiv.innerHTML = \`
                            <div class="status success">
                                Interview Test Started Successfully!<br><br>
                                <strong>Run ID:</strong> \${result.runId}<br>
                                <strong>Status:</strong> \${result.status}<br>
                                <strong>Method:</strong> \${result.method}<br>
                                <strong>Message:</strong> \${result.message}<br>
                                \${result.callId ? \`<strong>Call ID:</strong> \${result.callId}<br>\` : ''}
                                \${result.callSid ? \`<strong>Call SID:</strong> \${result.callSid}<br>\` : ''}
                                <br><em>The interviewer will call the candidate. Test will auto-stop after \${duration} seconds.</em>
                            </div>
                        \`;
                        
                        // Start auto-refresh
                        if (refreshInterval) clearInterval(refreshInterval);
                        refreshInterval = setInterval(loadTests, 3000);
                        
                        loadTests();
                    } else {
                        statusDiv.innerHTML = \`
                            <div class="status error">
                                <strong>Error:</strong> \${result.error}
                            </div>
                        \`;
                    }
                } catch (error) {
                    statusDiv.innerHTML = \`<div class="status error"><strong>Request failed:</strong> \${error.message}</div>\`;
                }
            }

            async function checkHealth() {
                const statusDiv = document.getElementById('status');
                try {
                    const response = await fetch('/health');
                    const result = await response.json();
                    
                    const configStatus = \`
                        <strong>Twilio:</strong> \${result.config.twilioConfigured ? '✅' : '❌'}<br>
                        <strong>Vapi API:</strong> \${result.config.vapiApiConfigured ? '✅' : '❌'}<br>
                        <strong>Interviewer Phone:</strong> \${result.config.interviewerPhoneConfigured ? '✅' : '❌'}<br>
                        <strong>Candidate Phone:</strong> \${result.config.candidatePhoneConfigured ? '✅' : '❌'}
                    \`;
                    
                    const allConfigured = Object.values(result.config).every(v => v);
                    const statusClass = allConfigured ? 'success' : 'warning';
                    
                    statusDiv.innerHTML = \`
                        <div class="status \${statusClass}">
                            <strong>System Health Check</strong><br><br>
                            <strong>Status:</strong> \${result.status}<br>
                            <strong>Active Tests:</strong> \${result.activeTests}<br>
                            <strong>Total Tests:</strong> \${result.totalTests}<br>
                            <strong>Timestamp:</strong> \${new Date(result.timestamp).toLocaleString()}<br><br>
                            <strong>Configuration:</strong><br>
                            \${configStatus}
                        </div>
                    \`;
                } catch (error) {
                    statusDiv.innerHTML = \`<div class="status error">Health check failed: \${error.message}</div>\`;
                }
            }

            async function checkDebug() {
                const statusDiv = document.getElementById('status');
                try {
                    const response = await fetch('/debug');
                    const result = await response.json();
                    
                    if (result.success) {
                        statusDiv.innerHTML = \`
                            <div class="status info">
                                <strong>Debug Information</strong><br><br>
                                <strong>Twilio Account:</strong> \${result.account}<br>
                                <strong>Webhook URL:</strong> \${result.config.webhookUrl}<br>
                                <strong>From Number:</strong> \${result.config.fromNumber}<br>
                                <strong>Interviewer Phone:</strong> \${result.config.interviewerPhone}<br>
                                <strong>Candidate Phone:</strong> \${result.config.candidatePhone}<br>
                                <strong>Vapi API Key:</strong> \${result.config.hasVapiApiKey ? 'Configured' : 'Not configured'}<br><br>
                                <strong>Active Tests:</strong> \${result.activeTests.length}<br>
                                <strong>Active Assistants:</strong> \${result.activeAssistants}<br><br>
                                \${result.activeTests.length > 0 ? 
                                    \`<strong>Current Tests:</strong><br>\${result.activeTests.map(t => 
                                        \`• \${t.runId} (\${t.status}) - \${t.persona}\`
                                    ).join('<br>')}\` : 
                                    '<em>No active tests</em>'
                                }
                            </div>
                        \`;
                    } else {
                        statusDiv.innerHTML = \`<div class="status error">Debug check failed: \${result.error}</div>\`;
                    }
                } catch (error) {
                    statusDiv.innerHTML = \`<div class="status error">Debug request failed: \${error.message}</div>\`;
                }
            }

            async function loadTests() {
                try {
                    const response = await fetch('/tests');
                    const result = await response.json();
                    
                    if (result.success) {
                        const testListDiv = document.getElementById('testList');
                        
                        if (result.tests.length === 0) {
                            testListDiv.innerHTML = '<div class="info"><strong>No tests yet.</strong> Start your first interview test above!</div>';
                            return;
                        }
                        
                        const testItems = result.tests
                            .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
                            .map(test => \`
                            <div class="test-item">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <strong>\${test.runId}</strong>
                                    <span style="padding: 3px 8px; border-radius: 3px; font-size: 12px; background: \${getStatusColor(test.status)}; color: white;">
                                        \${test.status.toUpperCase()}
                                    </span>
                                </div>
                                
                                <div style="font-size: 14px; color: #666;">
                                    <strong>Persona:</strong> \${test.persona} | 
                                    <strong>Started:</strong> \${new Date(test.startTime).toLocaleString()}<br>
                                    \${test.endTime ? \`<strong>Ended:</strong> \${new Date(test.endTime).toLocaleString()} | \` : ''}
                                    \${test.duration ? \`<strong>Duration:</strong> \${test.duration}s<br>\` : ''}
                                    
                                    \${test.calls ? \`
                                        <strong>Method:</strong> \${test.calls.method}<br>
                                        \${test.calls.directCallId ? \`<strong>Direct Call:</strong> \${test.calls.directCallId}<br>\` : ''}
                                        \${test.calls.orchestrationCallSid ? \`<strong>Orchestration:</strong> \${test.calls.orchestrationCallSid}<br>\` : ''}
                                    \` : ''}
                                    
                                    \${test.assistants ? \`
                                        <strong>Assistants:</strong> 
                                        Interviewer: \${test.assistants.interviewer?.substring(0, 20)}..., 
                                        Candidate: \${test.assistants.candidate?.substring(0, 20)}...<br>
                                    \` : ''}
                                </div>
                                
                                <div style="margin-top: 10px;">
                                    <button onclick="viewDetails('\${test.runId}')" style="font-size: 12px; padding: 5px 10px; margin-right: 5px;">View Details</button>
                                    \${!['completed'].includes(test.status) ? 
                                        \`<button onclick="stopTest('\${test.runId}')" style="font-size: 12px; padding: 5px 10px; background: #dc3545;">Stop Test</button>\` : 
                                        ''
                                    }
                                </div>
                            </div>
                        \`).join('');
                        
                        testListDiv.innerHTML = \`
                            <h3>Interview Tests (\${result.tests.length})</h3>
                            \${testItems}
                        \`;
                        
                        // Stop auto-refresh if no active tests
                        const activeTests = result.tests.filter(t => ['connecting', 'creating_assistants', 'active'].includes(t.status));
                        if (activeTests.length === 0 && refreshInterval) {
                            clearInterval(refreshInterval);
                            refreshInterval = null;
                        }
                    }
                } catch (error) {
                    console.error('Failed to load tests:', error);
                }
            }

            function getStatusColor(status) {
                switch(status) {
                    case 'completed': return '#28a745';
                    case 'active': return '#17a2b8';
                    case 'connecting': return '#007bff';
                    case 'creating_assistants': return '#ffc107';
                    case 'starting': return '#ffc107';
                    default: return '#6c757d';
                }
            }

            async function stopTest(runId) {
                try {
                    const response = await fetch(\`/tests/\${runId}/stop\`, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        loadTests();
                        document.getElementById('status').innerHTML = '<div class="status info">Test stopped and assistants cleaned up</div>';
                    }
                } catch (error) {
                    console.error('Failed to stop test:', error);
                }
            }

            async function viewDetails(runId) {
                try {
                    const response = await fetch(\`/tests/\${runId}\`);
                    const result = await response.json();
                    
                    if (result.success) {
                        const { testRun, transcripts, events } = result;
                        
                        const detailsWindow = window.open('', '_blank', 'width=1200,height=800');
                        detailsWindow.document.write(\`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>Interview Test Details: \${runId}</title>
                                <style>
                                    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                                    .container { background: white; padding: 20px; border-radius: 8px; }
                                    pre { background: #f8f9fa; padding: 15px; border-radius: 5px; overflow-x: auto; }
                                    .section { margin: 20px 0; }
                                    .transcript { background: #f8f9fa; padding: 10px; margin: 5px 0; border-left: 4px solid #007bff; }
                                    .interviewer { border-left-color: #dc3545; }
                                    .candidate { border-left-color: #28a745; }
                                    .tab { display: none; }
                                    .tab.active { display: block; }
                                    .tab-nav { margin: 20px 0; }
                                    .tab-nav button { padding: 10px 15px; margin: 0 5px; border: 1px solid #ddd; background: #f8f9fa; cursor: pointer; }
                                    .tab-nav button.active { background: #007bff; color: white; }
                                </style>
                            </head>
                            <body>
                                <div class="container">
                                    <h2>Interview Test Details: \${runId}</h2>
                                    
                                    <div class="section">
                                        <h3>Test Information</h3>
                                        <p><strong>Status:</strong> \${testRun.status}</p>
                                        <p><strong>Persona:</strong> \${testRun.persona}</p>
                                        <p><strong>Duration:</strong> \${testRun.duration}s</p>
                                        <p><strong>Start:</strong> \${new Date(testRun.startTime).toLocaleString()}</p>
                                        \${testRun.endTime ? \`<p><strong>End:</strong> \${new Date(testRun.endTime).toLocaleString()}</p>\` : ''}
                                        \${testRun.calls ? \`<p><strong>Call Method:</strong> \${testRun.calls.method}</p>\` : ''}
                                    </div>

                                    <div class="tab-nav">
                                        <button onclick="showTab('transcripts')" class="active" id="transcripts-btn">Transcripts (\${transcripts.length})</button>
                                        <button onclick="showTab('events')" id="events-btn">Events (\${events.length})</button>
                                        <button onclick="showTab('technical')" id="technical-btn">Technical Details</button>
                                    </div>
                                    
                                    <div id="transcripts" class="tab active">
                                        <h3>Conversation Transcripts</h3>
                                        \${transcripts.length > 0 ? 
                                            transcripts.map(t => \`
                                                <div class="transcript \${t.participant}">
                                                    <strong>\${t.participant.toUpperCase()}:</strong> \${t.text}
                                                    \${t.final ? ' <em>(final)</em>' : ' <em>(partial)</em>'}
                                                    <br><small>\${new Date(t.timestamp).toLocaleTimeString()}</small>
                                                </div>
                                            \`).join('') :
                                            '<p><em>No transcripts captured yet. Transcripts appear when Vapi processes the conversation.</em></p>'
                                        }
                                    </div>
                                    
                                    <div id="events" class="tab">
                                        <h3>System Events</h3>
                                        <pre>\${JSON.stringify(events, null, 2)}</pre>
                                    </div>
                                    
                                    <div id="technical" class="tab">
                                        <h3>Technical Details</h3>
                                        <pre>\${JSON.stringify(testRun, null, 2)}</pre>
                                    </div>
                                    
                                    <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 5px; cursor: pointer;">Close</button>
                                </div>
                                
                                <script>
                                    function showTab(tabName) {
                                        // Hide all tabs
                                        document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
                                        document.querySelectorAll('.tab-nav button').forEach(btn => btn.classList.remove('active'));
                                        
                                        // Show selected tab
                                        document.getElementById(tabName).classList.add('active');
                                        document.getElementById(tabName + '-btn').classList.add('active');
                                    }
                                </script>
                            </body>
                            </html>
                        \`);
                        detailsWindow.document.close();
                    }
                } catch (error) {
                    alert('Failed to load details: ' + error.message);
                }
            }

            // Auto-load tests and health check on page load
            window.addEventListener('load', () => {
                loadTests();
                checkHealth();
            });
            
            // Clear intervals when page unloads
            window.addEventListener('beforeunload', () => {
                if (refreshInterval) clearInterval(refreshInterval);
            });
        </script>
    </body>
    </html>
  `);
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error.message);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Graceful shutdown with cleanup
const gracefulShutdown = async () => {
  logger.info('Shutting down gracefully...');
  
  // Clean up all active assistants
  const assistantIds = Array.from(storage.assistants.keys());
  if (assistantIds.length > 0) {
    logger.info(`Cleaning up ${assistantIds.length} assistants...`);
    await Promise.all(assistantIds.map(id => deleteVapiAssistant(id)));
  }
  
  // Stop all active tests
  const activeTests = Array.from(storage.testRuns.values())
    .filter(test => !['completed'].includes(test.status));
  
  if (activeTests.length > 0) {
    logger.info(`Stopping ${activeTests.length} active tests...`);
    await Promise.all(activeTests.map(test => stopTest(test.runId)));
  }
  
  logger.info('Cleanup complete. Exiting...');
  process.exit(0);
};

// Start server
const startServer = async () => {
  try {
    // Test Twilio connection
    logger.info('Testing Twilio connection...');
    const account = await twilioClient.api.accounts(config.twilio.accountSid).fetch();
    logger.info('Twilio connection verified', { accountName: account.friendlyName });
    
    // Start server
    app.listen(config.port, () => {
      logger.info(`AI Interview System running on port ${config.port}`);
      logger.info('System Configuration:');
      logger.info(`   Twilio Account: ${config.twilio.accountSid.substring(0, 10)}...`);
      logger.info(`   From Number: ${config.twilio.fromNumber}`);
      logger.info(`   Webhook URL: ${config.twilio.webhookUrl}`);
      logger.info(`   Interviewer Phone: ${config.vapi.interviewer.phoneNumber || 'Not configured'}`);
      logger.info(`   Candidate Phone: ${config.vapi.candidate.phoneNumber || 'Not configured'}`);
      logger.info(`   Vapi API Key: ${config.vapi.apiKey ? 'Configured' : 'Not configured'}`);
      logger.info('\nSystem ready! The interviewer will call the candidate directly.');
      logger.info('Visit http://localhost:' + config.port + ' to start testing.');
    });
    
  } catch (error) {
    logger.error('Failed to start server:', error.message);
    logger.error('Please check your environment variables:');
    logger.error('   - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN');
    logger.error('   - VAPI_API_KEY');
    logger.error('   - VAPI_INTERVIEWER_PHONE, VAPI_CANDIDATE_PHONE');
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start the server
startServer();