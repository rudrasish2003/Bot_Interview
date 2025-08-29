// Load environment variables first
require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration
const config = {
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    webhookUrl: process.env.WEBHOOK_BASE_URL || 'https://your-ngrok-url.ngrok.io'
  },
  vapi: {
    apiKey: process.env.VAPI_API_KEY,
    assistantId: process.env.VAPI_ASSISTANT_ID,
    phoneNumber: process.env.VAPI_PHONE_NUMBER
  },
  ultravox: {
    apiKey: process.env.ULTRAVOX_API_KEY,
    apiUrl: process.env.ULTRAVOX_API_URL || 'https://api.ultravox.ai/v1'
  },
  testTimeout: 5 * 60 * 1000, // 5 minutes
  port: process.env.PORT || 3000
};

// Validate required environment variables
const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'VAPI_API_KEY',
  'VAPI_ASSISTANT_ID',
  'VAPI_PHONE_NUMBER',
  'ULTRAVOX_API_KEY'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingVars.join(', '));
  console.error('💡 Please check your .env file and ensure all required variables are set.');
  process.exit(1);
}

// Initialize Twilio client with error handling
let twilioClient;
try {
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    throw new Error('Twilio credentials missing');
  }
  twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  logger.info('Twilio client initialized successfully');
} catch (error) {
  logger.error('Failed to initialize Twilio client:', error.message);
  process.exit(1);
}

// In-memory storage for demo (replace with database)
const storage = {
  testRuns: new Map(),
  transcripts: new Map(),
  events: new Map()
};

// Personas for Ultravox
const personas = {
  nervous: {
    name: "Nervous Fresher",
    description: "Recent graduate, anxious but eager. Tends to over-explain and second-guess answers.",
    traits: ["anxious", "eager", "verbose", "uncertain"],
    voice: "alloy"
  },
  confident: {
    name: "Overconfident Candidate", 
    description: "Self-assured, sometimes interrupts, gives brief confident answers.",
    traits: ["assertive", "brief", "confident", "direct"],
    voice: "echo"
  },
  experienced: {
    name: "Senior Professional",
    description: "Calm, thoughtful responses with relevant examples from experience.",
    traits: ["calm", "experienced", "thoughtful", "detailed"],
    voice: "fable"
  }
};

// Utility functions
const logger = {
  info: (msg, data = {}) => console.log(`[INFO] ${msg}`, data),
  error: (msg, data = {}) => console.error(`[ERROR] ${msg}`, data),
  debug: (msg, data = {}) => console.log(`[DEBUG] ${msg}`, data)
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

// Vapi API integration for outbound calls
const createVapiCall = async (runId, conferenceSid) => {
  try {
    const callPayload = {
      assistantId: config.vapi.assistantId,
      customer: {
        number: `conference:${conferenceSid}` // Special Twilio conference dial string
      },
      phoneNumberId: config.vapi.phoneNumber, // Your Vapi phone number ID
      metadata: {
        runId,
        role: 'interviewer'
      }
    };

    const response = await axios.post(
      'https://api.vapi.ai/call',
      callPayload,
      {
        headers: {
          'Authorization': `Bearer ${config.vapi.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    logger.error('Failed to create Vapi call', error.response?.data || error.message);
    throw error;
  }
};

// Ultravox API integration - modified to work with conference
const createUltravoxCall = async (persona, runId, conferenceSid) => {
  try {
    const selectedPersona = personas[persona] || personas.nervous;
    
    const callPayload = {
      systemPrompt: `You are a ${selectedPersona.name}. ${selectedPersona.description} 
        You are being interviewed for a software engineering position. 
        Respond naturally as this persona would. Keep responses concise but in character.
        Traits: ${selectedPersona.traits.join(', ')}.
        
        You will be connected to a conference call with an interviewer. Wait for questions and respond appropriately.`,
      model: "fixie-ai/ultravox",
      voice: selectedPersona.voice,
      temperature: 0.7,
      maxDuration: 300, // 5 minutes
      // Try to pass conference info if Ultravox supports it
      callTarget: conferenceSid, 
      metadata: {
        runId,
        persona: selectedPersona.name,
        conferenceSid
      }
    };

    const response = await axios.post(
      `${config.ultravox.apiUrl}/calls`,
      callPayload,
      {
        headers: {
          'Authorization': `Bearer ${config.ultravox.apiKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    logger.error('Failed to create Ultravox call', error.response?.data || error.message);
    throw error;
  }
};

// Main test orchestration
const startTest = async (req, res) => {
  const { persona = 'nervous', scenarioId = 'default' } = req.body;
  const runId = generateRunId();
  
  try {
    logger.info(`Starting test run ${runId} with persona: ${persona}`);
    
    // Debug: Check if twilioClient is properly initialized
    if (!twilioClient || typeof twilioClient.conferences !== 'object') {
      throw new Error('Twilio client not properly initialized');
    }
    
    // Step 1: Create Twilio Conference
    const conference = await twilioClient.conferences.create({
      friendlyName: `AI_Interview_${runId}`,
      record: 'record-from-start',
      statusCallback: `${config.twilio.webhookUrl}/twilio/status`,
      statusCallbackEvent: ['start', 'end', 'join', 'leave'],
      endConferenceOnExit: false,
      maxParticipants: 2
    });

    logger.info(`Conference created: ${conference.sid}`);

    // Step 2: Store test run
    storage.testRuns.set(runId, {
      runId,
      scenarioId,
      persona,
      conferenceSid: conference.sid,
      status: 'starting',
      startTime: new Date().toISOString(),
      participants: {}
    });

    saveEvent(runId, 'test_started', { persona, scenarioId, conferenceSid: conference.sid });

    // Step 3: Start both calls to join the conference
    // Step 3a: Add Interview Bot (Vapi) via PSTN
    const vapiParticipant = await twilioClient.conferences(conference.sid)
      .participants
      .create({
        to: config.vapi.phoneNumber, // Your Vapi phone number
        from: '+15005550006', // Twilio test number
        statusCallback: `${config.twilio.webhookUrl}/twilio/participant-status`,
        statusCallbackEvent: ['ringing', 'answered', 'completed'],
        label: 'interviewer',
        statusCallbackMethod: 'POST'
      });

    logger.info(`Vapi participant added: ${vapiParticipant.callSid}`);

    // Wait a moment for first bot to settle and answer
    setTimeout(async () => {
      try {
        // Step 3b: Create Ultravox call that joins the conference
        const ultravoxCall = await createUltravoxCall(persona, runId, conference.sid);
        let ultravoxTarget;
        
        if (ultravoxCall.joinUrl) {
          // If Ultravox provides a SIP URI
          ultravoxTarget = ultravoxCall.joinUrl;
        } else {
          // If Ultravox provides a phone number
          ultravoxTarget = ultravoxCall.phoneNumber || `+1${ultravoxCall.callId}`;
        }

        const ultravoxParticipant = await twilioClient.conferences(conference.sid)
          .participants
          .create({
            to: ultravoxTarget,
            from: '+15005550006',
            statusCallback: `${config.twilio.webhookUrl}/twilio/participant-status`,
            statusCallbackEvent: ['ringing', 'answered', 'completed'],
            label: 'candidate'
          });

        logger.info(`Ultravox participant added: ${ultravoxParticipant.callSid}`);

        // Update storage
        const testRun = storage.testRuns.get(runId);
        testRun.participants = {
          interviewer: { callSid: vapiParticipant.callSid, vendor: 'vapi', phoneNumber: config.vapi.phoneNumber },
          candidate: { callSid: ultravoxParticipant.callSid, vendor: 'ultravox', target: ultravoxTarget }
        };
        testRun.status = 'running';

        saveEvent(runId, 'participants_added', testRun.participants);

        // Set timeout to auto-stop test
        setTimeout(() => stopTest(runId), config.testTimeout);

      } catch (error) {
        logger.error(`Failed to add second participant for ${runId}`, error);
      }
    }, 5000); // Wait 5 seconds for Vapi to answer and settle

    res.json({
      success: true,
      runId,
      conferenceSid: conference.sid,
      status: 'starting',
      message: 'Test initiated. Bots joining conference...'
    });

  } catch (error) {
    logger.error(`Failed to start test ${runId}`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      runId
    });
  }
};

// Stop test function
const stopTest = async (runId) => {
  try {
    const testRun = storage.testRuns.get(runId);
    if (!testRun || testRun.status === 'completed') {
      return;
    }

    logger.info(`Stopping test run ${runId}`);

    // End the conference
    await twilioClient.conferences(testRun.conferenceSid)
      .update({ status: 'completed' });

    // Update status
    testRun.status = 'completed';
    testRun.endTime = new Date().toISOString();
    
    saveEvent(runId, 'test_completed', { 
      duration: new Date(testRun.endTime) - new Date(testRun.startTime)
    });

    logger.info(`Test run ${runId} completed`);

  } catch (error) {
    logger.error(`Failed to stop test ${runId}`, error);
  }
};

// API Endpoints

// Start a new test
app.post('/tests/start', startTest);

// Stop a test manually
app.post('/tests/:runId/stop', async (req, res) => {
  const { runId } = req.params;
  
  try {
    await stopTest(runId);
    res.json({ success: true, message: `Test ${runId} stopped` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get test status
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

// List all tests
app.get('/tests', (req, res) => {
  const tests = Array.from(storage.testRuns.values());
  res.json({ success: true, tests });
});

// Twilio voice webhook (for conference setup)
app.post('/twilio/voice', (req, res) => {
  const { CallSid, From, To } = req.body;
  
  logger.info('Incoming voice webhook', { CallSid, From, To });
  
  // Simple TwiML response - join conference if needed
  const twiml = new twilio.twiml.VoiceResponse();
  
  // For demo purposes, you could create a conference here too
  // But we're primarily using REST API approach
  twiml.say('Connecting to AI interview system...');
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Twilio status callbacks
app.post('/twilio/status', (req, res) => {
  const { ConferenceSid, StatusCallbackEvent, FriendlyName } = req.body;
  
  logger.info('Conference status event', { ConferenceSid, StatusCallbackEvent, FriendlyName });
  
  // Find test run by conference SID
  const testRun = Array.from(storage.testRuns.values())
    .find(run => run.conferenceSid === ConferenceSid);
  
  if (testRun) {
    saveEvent(testRun.runId, 'conference_event', { 
      event: StatusCallbackEvent,
      conferenceSid: ConferenceSid 
    });
  }
  
  res.sendStatus(200);
});

// Participant status callbacks
app.post('/twilio/participant-status', (req, res) => {
  const { CallSid, ConferenceSid, StatusCallbackEvent, Label } = req.body;
  
  logger.info('Participant status event', { CallSid, ConferenceSid, StatusCallbackEvent, Label });
  
  // Find test run and update participant status
  const testRun = Array.from(storage.testRuns.values())
    .find(run => run.conferenceSid === ConferenceSid);
  
  if (testRun) {
    saveEvent(testRun.runId, 'participant_event', { 
      event: StatusCallbackEvent,
      callSid: CallSid,
      label: Label 
    });

    // Update participant connection times
    if (testRun.participants) {
      Object.keys(testRun.participants).forEach(role => {
        if (testRun.participants[role].callSid === CallSid) {
          if (StatusCallbackEvent === 'answered') {
            testRun.participants[role].connectTime = new Date().toISOString();
          } else if (StatusCallbackEvent === 'completed') {
            testRun.participants[role].disconnectTime = new Date().toISOString();
          }
        }
      });
    }
  }
  
  res.sendStatus(200);
});

// Vapi webhooks for transcripts
app.post('/webhooks/vapi/transcript', (req, res) => {
  const { transcript, isFinal, callId } = req.body;
  
  logger.debug('Vapi transcript received', { transcript, isFinal });
  
  // Find test run by call ID (you'd need to track this mapping)
  // For simplicity, we'll use a different approach in the real implementation
  
  res.sendStatus(200);
});

// Ultravox webhooks for transcripts
app.post('/webhooks/ultravox/transcript', (req, res) => {
  const { transcript, isFinal, callId } = req.body;
  
  logger.debug('Ultravox transcript received', { transcript, isFinal });
  
  // Store transcript
  // Note: You'll need to map callId to runId in production
  
  res.sendStatus(200);
});

// Generic transcript webhook (simplified for demo)
app.post('/webhooks/transcript/:vendor/:runId', (req, res) => {
  const { vendor, runId } = req.params;
  const { transcript, is_final, speaker } = req.body;
  
  logger.info(`Transcript from ${vendor}`, { runId, transcript, is_final });
  
  const participantType = vendor === 'vapi' ? 'interviewer' : 'candidate';
  saveTranscript(runId, participantType, transcript, is_final);
  
  res.sendStatus(200);
});

// Simple web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>AI Interview Test System</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .container { max-width: 800px; margin: 0 auto; }
            .form-group { margin: 20px 0; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            select, button { padding: 10px; margin: 5px 0; }
            button { background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; }
            button:hover { background: #0052a3; }
            .status { margin: 20px 0; padding: 15px; border-radius: 4px; }
            .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
            .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
            .test-list { margin-top: 30px; }
            .test-item { padding: 10px; margin: 5px 0; border: 1px solid #ddd; border-radius: 4px; }
            pre { background: #f8f9fa; padding: 10px; border-radius: 4px; overflow-x: auto; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 AI Interview Test System</h1>
            
            <div class="form-group">
                <label for="persona">Candidate Persona:</label>
                <select id="persona">
                    <option value="nervous">Nervous Fresher</option>
                    <option value="confident">Overconfident Candidate</option>
                    <option value="experienced">Senior Professional</option>
                </select>
            </div>

            <div class="form-group">
                <button onclick="startTest()">🚀 Start Interview Test</button>
                <button onclick="loadTests()">📋 Refresh Test List</button>
            </div>

            <div id="status"></div>
            <div id="testList" class="test-list"></div>
        </div>

        <script>
            let currentRunId = null;

            async function startTest() {
                const persona = document.getElementById('persona').value;
                const statusDiv = document.getElementById('status');
                
                try {
                    statusDiv.innerHTML = '<div class="status">Starting test...</div>';
                    
                    const response = await fetch('/tests/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ persona })
                    });
                    
                    const result = await response.json();
                    
                    if (result.success) {
                        currentRunId = result.runId;
                        statusDiv.innerHTML = \`
                            <div class="status success">
                                ✅ Test Started!<br>
                                Run ID: \${result.runId}<br>
                                Conference: \${result.conferenceSid}<br>
                                Status: \${result.status}
                            </div>
                        \`;
                        
                        // Auto-refresh status
                        setTimeout(() => checkStatus(result.runId), 5000);
                    } else {
                        statusDiv.innerHTML = \`<div class="status error">❌ Error: \${result.error}</div>\`;
                    }
                } catch (error) {
                    statusDiv.innerHTML = \`<div class="status error">❌ Request failed: \${error.message}</div>\`;
                }
            }

            async function stopTest(runId) {
                try {
                    const response = await fetch(\`/tests/\${runId}/stop\`, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        loadTests();
                    }
                } catch (error) {
                    console.error('Failed to stop test:', error);
                }
            }

            async function checkStatus(runId) {
                try {
                    const response = await fetch(\`/tests/\${runId}\`);
                    const result = await response.json();
                    
                    if (result.success) {
                        const { testRun, transcripts, events } = result;
                        
                        document.getElementById('status').innerHTML = \`
                            <div class="status">
                                <strong>Test: \${runId}</strong><br>
                                Status: \${testRun.status}<br>
                                Persona: \${testRun.persona}<br>
                                Events: \${events.length}<br>
                                Transcripts: \${transcripts.length}
                                
                                \${testRun.status === 'running' ? 
                                    \`<button onclick="stopTest('\${runId}')" style="margin-top: 10px;">⏹️ Stop Test</button>\` : 
                                    ''
                                }
                            </div>
                        \`;
                        
                        // Continue checking if still running
                        if (testRun.status === 'running') {
                            setTimeout(() => checkStatus(runId), 10000);
                        }
                    }
                } catch (error) {
                    console.error('Failed to check status:', error);
                }
            }

            async function loadTests() {
                try {
                    const response = await fetch('/tests');
                    const result = await response.json();
                    
                    if (result.success) {
                        const testListDiv = document.getElementById('testList');
                        
                        if (result.tests.length === 0) {
                            testListDiv.innerHTML = '<p>No tests yet. Start your first test above!</p>';
                            return;
                        }
                        
                        const testItems = result.tests.map(test => \`
                            <div class="test-item">
                                <strong>\${test.runId}</strong> 
                                <span style="color: #666;">[\${test.status}]</span><br>
                                Persona: \${test.persona} | 
                                Started: \${new Date(test.startTime).toLocaleTimeString()}<br>
                                Conference: \${test.conferenceSid}
                                <button onclick="viewDetails('\${test.runId}')" style="margin-left: 10px;">View Details</button>
                            </div>
                        \`).join('');
                        
                        testListDiv.innerHTML = \`
                            <h3>Recent Tests</h3>
                            \${testItems}
                        \`;
                    }
                } catch (error) {
                    console.error('Failed to load tests:', error);
                }
            }

            async function viewDetails(runId) {
                try {
                    const response = await fetch(\`/tests/\${runId}\`);
                    const result = await response.json();
                    
                    if (result.success) {
                        const { testRun, transcripts, events } = result;
                        
                        const detailsWindow = window.open('', '_blank');
                        detailsWindow.document.write(\`
                            <html>
                            <head><title>Test Details: \${runId}</title></head>
                            <body style="font-family: Arial, sans-serif; margin: 20px;">
                                <h2>Test Run: \${runId}</h2>
                                <p><strong>Status:</strong> \${testRun.status}</p>
                                <p><strong>Persona:</strong> \${testRun.persona}</p>
                                <p><strong>Duration:</strong> \${testRun.startTime} - \${testRun.endTime || 'ongoing'}</p>
                                
                                <h3>Events (\${events.length})</h3>
                                <pre>\${JSON.stringify(events, null, 2)}</pre>
                                
                                <h3>Transcripts (\${transcripts.length})</h3>
                                <pre>\${JSON.stringify(transcripts, null, 2)}</pre>
                            </body>
                            </html>
                        \`);
                    }
                } catch (error) {
                    alert('Failed to load details: ' + error.message);
                }
            }

            // Load tests on page load
            loadTests();
        </script>
    </body>
    </html>
  `);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeTests: Array.from(storage.testRuns.values()).filter(t => t.status === 'running').length,
    totalTests: storage.testRuns.size
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  
  // Stop any running tests
  const runningTests = Array.from(storage.testRuns.values())
    .filter(test => test.status === 'running');
  
  for (const test of runningTests) {
    try {
      await stopTest(test.runId);
    } catch (error) {
      logger.error(`Failed to stop test ${test.runId} during shutdown`, error);
    }
  }
  
  process.exit(0);
});

// Start server with proper error handling
const startServer = async () => {
  try {
    // Test Twilio connection
    logger.info('Testing Twilio connection...');
    const account = await twilioClient.api.accounts(config.twilio.accountSid).fetch();
    logger.info('✅ Twilio connection verified', { accountName: account.friendlyName });
    
    // Test conferences API
    logger.info('Testing Twilio conferences API...');
    if (typeof twilioClient.conferences.create !== 'function') {
      throw new Error('Twilio conferences API not available - check SDK version');
    }
    logger.info('✅ Twilio conferences API available');
    
    app.listen(config.port, () => {
      logger.info(`🚀 AI Interview System running on port ${config.port}`);
      logger.info('📋 Configuration check:');
      logger.info(`   Twilio Account: ${config.twilio.accountSid} ✅`);
      logger.info(`   Webhook URL: ${config.twilio.webhookUrl}`);
      logger.info(`   Vapi Phone: ${config.vapi.phoneNumber} ✅`);
      logger.info(`   Vapi Assistant: ${config.vapi.assistantId ? '✅' : '❌'}`);
      logger.info(`   Ultravox API: ${config.ultravox.apiUrl}`);
      logger.info('\n🎯 Ready to start AI interview tests!');
      logger.info('   Open http://localhost:' + config.port + ' to begin');
    });
    
  } catch (error) {
    logger.error('❌ Failed to start server:', error.message);
    logger.error('💡 Common fixes:');
    logger.error('   - Verify TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are correct');
    logger.error('   - Check your internet connection');
    logger.error('   - Ensure Twilio account is active');
    logger.error('   - Update Twilio SDK: npm install twilio@latest');
    process.exit(1);
  }
};

// Start the server
startServer();

module.exports = app;