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
  testTimeout: 5 * 60 * 1000, // 5 minutes
  port: process.env.PORT || 3000
};

// Validate required environment variables for direct call method
const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'VAPI_API_KEY',
  'VAPI_INTERVIEWER_ASSISTANT_ID',
  'VAPI_CANDIDATE_PHONE'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  logger.error('Missing required environment variables:', missingVars.join(', '));
  logger.error('Please check your environment variables on Render.');
  logger.error('Required for direct call method:');
  logger.error('  - VAPI_INTERVIEWER_ASSISTANT_ID (assistant that makes the call)');
  logger.error('  - VAPI_CANDIDATE_PHONE (Vapi number that receives the call)');
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
  events: new Map()
};

// Personas for candidate agent
const personas = {
  nervous: {
    name: "Nervous Fresher",
    systemPrompt: "You are a nervous recent graduate interviewing for your first job. You're eager to please but anxious. Tend to over-explain answers, say 'um' and 'like' frequently, and second-guess yourself. Be enthusiastic but show uncertainty.",
    voice: "alloy"
  },
  confident: {
    name: "Overconfident Candidate",
    systemPrompt: "You are an overconfident job candidate. Give brief, assertive answers. Sometimes interrupt or talk over the interviewer. Show supreme confidence in your abilities, even when you might not know something. Be direct and slightly arrogant.",
    voice: "echo"
  },
  experienced: {
    name: "Senior Professional",
    systemPrompt: "You are a seasoned professional with 10+ years of experience. Give thoughtful, detailed responses with specific examples from your career. Speak calmly and confidently. Ask clarifying questions when appropriate.",
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

// Updated createVapiCall function - simplified for direct calling
const createVapiCall = async (assistantId, toPhoneNumber, participantType) => {
  try {
    const response = await axios.post('https://api.vapi.ai/call', {
      assistantId: assistantId,
      type: 'outboundPhoneCall',
      customer: {
        number: toPhoneNumber
      }
    }, {
      headers: {
        'Authorization': `Bearer ${config.vapi.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    
    logger.info(`Vapi ${participantType} call created to ${toPhoneNumber}:`, response.data.id);
    return response.data;
  } catch (error) {
    logger.error(`Failed to create Vapi ${participantType} call:`, error.response?.data || error.message);
    throw error;
  }
};

// Updated startTest function - simplified approach
const startTest = async (req, res) => {
  const { persona = 'nervous', scenarioId = 'default' } = req.body;
  const runId = generateRunId();
  
  try {
    logger.info(`Starting test run ${runId} with persona: ${persona}`);
    
    // Validate required configuration
    if (!config.vapi.interviewer.assistantId) {
      throw new Error('VAPI_INTERVIEWER_ASSISTANT_ID is required');
    }
    if (!config.vapi.candidate.phoneNumber) {
      throw new Error('VAPI_CANDIDATE_PHONE is required');
    }

    // Store test run
    storage.testRuns.set(runId, {
      runId,
      scenarioId,
      persona,
      status: 'starting',
      startTime: new Date().toISOString(),
      participants: {}
    });

    saveEvent(runId, 'test_started', { persona, scenarioId });

    // Create interviewer assistant call to candidate phone number
    logger.info(`Interviewer (${config.vapi.interviewer.assistantId}) calling candidate (${config.vapi.candidate.phoneNumber})`);
    
    const interviewerCall = await createVapiCall(
      config.vapi.interviewer.assistantId,
      config.vapi.candidate.phoneNumber,
      'interviewer'
    );

    // Update test run with call details
    const testRun = storage.testRuns.get(runId);
    testRun.participants = {
      interviewer: { 
        vapiCallId: interviewerCall.id,
        assistantId: config.vapi.interviewer.assistantId,
        role: 'caller',
        status: 'calling'
      },
      candidate: { 
        phoneNumber: config.vapi.candidate.phoneNumber,
        assistantId: config.vapi.candidate.assistantId || 'configured_on_number',
        role: 'receiver',
        persona: persona,
        status: 'receiving'
      }
    };
    testRun.status = 'running';
    testRun.vapiCallId = interviewerCall.id;
    
    saveEvent(runId, 'vapi_call_created', {
      callId: interviewerCall.id,
      from: config.vapi.interviewer.assistantId,
      to: config.vapi.candidate.phoneNumber
    });

    res.json({
      success: true,
      runId,
      status: 'calling',
      message: `Interviewer calling candidate at ${config.vapi.candidate.phoneNumber}`,
      method: 'direct_vapi_call',
      callId: interviewerCall.id
    });

    // Set up auto-cleanup after test timeout
    setTimeout(async () => {
      const currentTest = storage.testRuns.get(runId);
      if (currentTest && currentTest.status !== 'completed') {
        logger.info(`Auto-stopping test ${runId} due to timeout`);
        await stopTest(runId);
      }
    }, config.testTimeout);

  } catch (error) {
    logger.error(`Failed to start test ${runId}:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      runId
    });
  }
};

// Updated stopTest function
const stopTest = async (runId) => {
  try {
    const testRun = storage.testRuns.get(runId);
    if (!testRun || testRun.status === 'completed') {
      return;
    }

    logger.info(`Stopping test run ${runId}`);

    // End Vapi call
    if (testRun.vapiCallId) {
      try {
        await axios.patch(`https://api.vapi.ai/call/${testRun.vapiCallId}`, 
          { status: 'ended' },
          { headers: { 'Authorization': `Bearer ${config.vapi.apiKey}` } }
        );
        logger.info(`Ended Vapi call: ${testRun.vapiCallId}`);
      } catch (error) {
        logger.error(`Failed to end Vapi call: ${error.message}`);
      }
    }

    // Update status
    testRun.status = 'completed';
    testRun.endTime = new Date().toISOString();
    
    saveEvent(runId, 'test_completed', { 
      duration: new Date(testRun.endTime) - new Date(testRun.startTime)
    });

    logger.info(`Test run ${runId} completed`);

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

// Vapi webhook for transcripts and call events
app.post('/vapi/webhook', (req, res) => {
  const { type, call, transcript, message } = req.body;
  
  logger.info('Vapi webhook received', { type, callId: call?.id });
  
  // Find test run by Vapi call ID
  const testRun = Array.from(storage.testRuns.values())
    .find(run => run.vapiCallId === call?.id);
  
  if (testRun) {
    // Handle different webhook types
    switch (type) {
      case 'call-start':
        testRun.status = 'active';
        testRun.participants.interviewer.status = 'connected';
        testRun.participants.candidate.status = 'connected';
        saveEvent(testRun.runId, 'call_started', { callId: call.id });
        logger.info(`Call ${call.id} started for test ${testRun.runId}`);
        break;
        
      case 'call-end':
        testRun.status = 'completed';
        testRun.endTime = new Date().toISOString();
        testRun.participants.interviewer.status = 'disconnected';
        testRun.participants.candidate.status = 'disconnected';
        saveEvent(testRun.runId, 'call_ended', { 
          callId: call.id,
          duration: call.duration || 'unknown'
        });
        logger.info(`Call ${call.id} ended for test ${testRun.runId}`);
        break;
        
      case 'transcript':
        if (transcript) {
          // Determine participant based on message role or use alternating logic
          const participantType = message?.role === 'user' ? 'candidate' : 'interviewer';
          
          saveTranscript(testRun.runId, participantType, transcript.text, transcript.isFinal);
          
          saveEvent(testRun.runId, 'transcript', {
            participant: participantType,
            text: transcript.text,
            isFinal: transcript.isFinal
          });
          
          logger.debug(`Transcript from ${participantType}: ${transcript.text.substring(0, 50)}...`);
        }
        break;
        
      default:
        saveEvent(testRun.runId, 'vapi_webhook', { type, data: req.body });
        break;
    }
  } else {
    logger.debug(`No test run found for Vapi call ${call?.id}`);
  }
  
  res.sendStatus(200);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeTests: Array.from(storage.testRuns.values()).filter(t => t.status === 'running' || t.status === 'active').length,
    totalTests: storage.testRuns.size,
    config: {
      twilioConfigured: !!(config.twilio.accountSid && config.twilio.authToken),
      vapiApiConfigured: !!config.vapi.apiKey,
      interviewerAssistantConfigured: !!config.vapi.interviewer.assistantId,
      candidatePhoneConfigured: !!config.vapi.candidate.phoneNumber,
      method: 'direct_vapi_call'
    }
  });
});

// Debug endpoint
app.get('/debug/vapi', async (req, res) => {
  try {
    // Test Vapi API connection by listing assistants
    const response = await axios.get('https://api.vapi.ai/assistant', {
      headers: {
        'Authorization': `Bearer ${config.vapi.apiKey}`
      }
    });
    
    res.json({
      success: true,
      vapiConnection: 'OK',
      assistantsCount: response.data.length,
      config: {
        interviewerAssistantId: config.vapi.interviewer.assistantId || 'Not configured',
        candidatePhone: config.vapi.candidate.phoneNumber || 'Not configured',
        webhookUrl: `${config.twilio.webhookUrl}/vapi/webhook`
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// Enhanced web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>AI Interview Test System - Dual Vapi Agents</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
            .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .form-group { margin: 20px 0; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            select, button { padding: 12px; margin: 5px 0; border-radius: 5px; border: 1px solid #ddd; }
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
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>AI Interview Test System</h1>
                <p>Dual Vapi Agent Configuration</p>
            </div>

            <div class="config-info">
                <strong>Setup Requirements:</strong><br>
                • Two separate Vapi phone numbers<br>
                • Two different Vapi assistants (interviewer + candidate personas)<br>
                • Environment variables: VAPI_INTERVIEWER_PHONE, VAPI_CANDIDATE_PHONE, VAPI_INTERVIEWER_ASSISTANT_ID, VAPI_CANDIDATE_ASSISTANT_ID
            </div>
            
            <div class="form-group">
                <label for="persona">Select Candidate Persona:</label>
                <select id="persona" style="width: 100%;">
                    <option value="nervous">Nervous Fresher - Anxious recent graduate</option>
                    <option value="confident">Overconfident Candidate - Assertive and direct</option>
                    <option value="experienced">Senior Professional - Calm and experienced</option>
                </select>
            </div>

            <div class="form-group">
                <button onclick="startTest()" style="width: 200px; margin-right: 10px;">Start Test</button>
                <button onclick="loadTests()" style="width: 150px; background: #28a745;">Refresh</button>
                <button onclick="checkHealth()" style="width: 150px; background: #6c757d;">Health Check</button>
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
                    statusDiv.innerHTML = '<div class="status info">Starting dual Vapi agent test...</div>';
                    
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
                                Test Started Successfully!<br><br>
                                <strong>Run ID:</strong> \${result.runId}<br>
                                <strong>Conference:</strong> \${result.conferenceName}<br>
                                <strong>Status:</strong> \${result.status}<br>
                                <strong>Method:</strong> \${result.method}<br>
                                <strong>Message:</strong> \${result.message}
                            </div>
                        \`;
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
                        <strong>Candidate Phone:</strong> \${result.config.candidatePhoneConfigured ? '✅' : '❌'}<br>
                        <strong>Interviewer Assistant:</strong> \${result.config.interviewerAssistantConfigured ? '✅' : '❌'}<br>
                        <strong>Candidate Assistant:</strong> \${result.config.candidateAssistantConfigured ? '✅' : '❌'}
                    \`;
                    
                    const allConfigured = Object.values(result.config).every(v => v);
                    const statusClass = allConfigured ? 'success' : 'warning';
                    
                    statusDiv.innerHTML = \`
                        <div class="status \${statusClass}">
                            <strong>System Health Check</strong><br><br>
                            <strong>Status:</strong> \${result.status}<br>
                            <strong>Active Tests:</strong> \${result.activeTests}<br>
                            <strong>Total Tests:</strong> \${result.totalTests}<br><br>
                            \${configStatus}
                        </div>
                    \`;
                } catch (error) {
                    statusDiv.innerHTML = \`<div class="status error">Health check failed: \${error.message}</div>\`;
                }
            }

            async function loadTests() {
                try {
                    const response = await fetch('/tests');
                    const result = await response.json();
                    
                    if (result.success) {
                        const testListDiv = document.getElementById('testList');
                        
                        if (result.tests.length === 0) {
                            testListDiv.innerHTML = '<div class="info"><strong>No tests yet.</strong> Start your first test above!</div>';
                            return;
                        }
                        
                        const testItems = result.tests.map(test => \`
                            <div class="test-item">
                                <strong>\${test.runId}</strong> 
                                <span style="padding: 3px 8px; border-radius: 3px; font-size: 12px; background: \${getStatusColor(test.status)}; color: white;">
                                    \${test.status.toUpperCase()}
                                </span><br>
                                <strong>Persona:</strong> \${test.persona} | 
                                <strong>Started:</strong> \${new Date(test.startTime).toLocaleString()}<br>
                                <strong>Conference:</strong> \${test.conferenceSid || 'Pending'}<br>
                                <strong>Participants:</strong> \${getParticipantStatus(test.participants)}
                                <br>
                                <button onclick="viewDetails('\${test.runId}')" style="margin-top: 10px; font-size: 12px; padding: 5px 10px;">View Details</button>
                                \${test.status !== 'completed' ? 
                                    \`<button onclick="stopTest('\${test.runId}')" style="margin-top: 10px; margin-left: 5px; font-size: 12px; padding: 5px 10px; background: #dc3545;">Stop</button>\` : 
                                    ''
                                }
                            </div>
                        \`).join('');
                        
                        testListDiv.innerHTML = \`
                            <h3>Recent Tests (\${result.tests.length})</h3>
                            \${testItems}
                        \`;
                    }
                } catch (error) {
                    console.error('Failed to load tests:', error);
                }
            }

            function getStatusColor(status) {
                switch(status) {
                    case 'completed': return '#28a745';
                    case 'active': return '#17a2b8';
                    case 'running': return '#007bff';
                    case 'starting': return '#ffc107';
                    default: return '#6c757d';
                }
            }

            function getParticipantStatus(participants) {
                if (!participants) return 'None';
                const interviewer = participants.interviewer?.status || 'unknown';
                const candidate = participants.candidate?.status || 'unknown';
                return \`Interviewer: \${interviewer}, Candidate: \${candidate}\`;
            }

            async function stopTest(runId) {
                try {
                    const response = await fetch(\`/tests/\${runId}/stop\`, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        loadTests();
                        document.getElementById('status').innerHTML = '<div class="status info">Test stopped successfully</div>';
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
                        
                        const detailsWindow = window.open('', '_blank', 'width=1000,height=700');
                        detailsWindow.document.write(\`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>Test Details: \${runId}</title>
                                <style>
                                    body { font-family: Arial, sans-serif; margin: 20px; }
                                    pre { background: #f8f9fa; padding: 15px; border-radius: 5px; overflow-x: auto; }
                                    .section { margin: 20px 0; }
                                    .participants { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 10px 0; }
                                </style>
                            </head>
                            <body>
                                <h2>Test Run Details: \${runId}</h2>
                                
                                <div class="section">
                                    <h3>Basic Info</h3>
                                    <p><strong>Status:</strong> \${testRun.status}</p>
                                    <p><strong>Persona:</strong> \${testRun.persona}</p>
                                    <p><strong>Conference:</strong> \${testRun.conferenceName}</p>
                                    <p><strong>Conference SID:</strong> \${testRun.conferenceSid || 'Not created yet'}</p>
                                    <p><strong>Start Time:</strong> \${new Date(testRun.startTime).toLocaleString()}</p>
                                    <p><strong>End Time:</strong> \${testRun.endTime ? new Date(testRun.endTime).toLocaleString() : 'Still running'}</p>
                                </div>

                                <div class="section">
                                    <h3>Participants</h3>
                                    <div class="participants">
                                        <pre>\${JSON.stringify(testRun.participants, null, 2)}</pre>
                                    </div>
                                </div>
                                
                                <div class="section">
                                    <h3>Events (\${events.length})</h3>
                                    <pre>\${JSON.stringify(events, null, 2)}</pre>
                                </div>
                                
                                <div class="section">
                                    <h3>Transcripts (\${transcripts.length})</h3>
                                    \${transcripts.length > 0 ? 
                                        transcripts.map(t => \`
                                            <div style="margin: 10px 0; padding: 10px; border-left: 3px solid \${t.participant === 'interviewer' ? '#007bff' : '#28a745'};">
                                                <strong>\${t.participant.toUpperCase()}:</strong> \${t.text}<br>
                                                <small>\${new Date(t.timestamp).toLocaleString()}</small>
                                            </div>
                                        \`).join('') :
                                        '<p>No transcripts captured yet</p>'
                                    }
                                </div>
                                
                                <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #6c757d; color: white; border: none; border-radius: 5px; cursor: pointer;">Close</button>
                            </body>
                            </html>
                        \`);
                        detailsWindow.document.close();
                    }
                } catch (error) {
                    alert('Failed to load details: ' + error.message);
                }
            }

            // Auto-load tests on page load
            window.addEventListener('load', () => {
                loadTests();
                checkHealth();
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
      logger.info('System Status:');
      logger.info(`   Twilio Account: ${config.twilio.accountSid.substring(0, 10)}...`);
      logger.info(`   Webhook URL: ${config.twilio.webhookUrl}`);
      logger.info(`   Interviewer Phone: ${config.vapi.interviewer.phoneNumber || 'Not configured'}`);
      logger.info(`   Candidate Phone: ${config.vapi.candidate.phoneNumber || 'Not configured'}`);
      logger.info(`   Vapi API Key: ${config.vapi.apiKey ? 'Configured' : 'Not configured'}`);
      logger.info('\nSystem ready! Configure your Vapi phone numbers and assistants to begin testing.');
    });
    
  } catch (error) {
    logger.error('Failed to start server:', error.message);
    logger.error('Troubleshooting tips:');
    logger.error('   - Verify TWILIO_ACCOUNT_SID starts with "AC"');
    logger.error('   - Check TWILIO_AUTH_TOKEN is correct');
    logger.error('   - Ensure Twilio account is active and funded');
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer();