// Load environment variables first
require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Utility functions (define first)
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
  'TWILIO_AUTH_TOKEN'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  logger.error('❌ Missing required environment variables:', missingVars.join(', '));
  logger.error('💡 Please check your environment variables on Render.');
  process.exit(1);
}

// Initialize Twilio client
let twilioClient;
try {
  twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  logger.info('✅ Twilio client initialized successfully');
} catch (error) {
  logger.error('❌ Failed to initialize Twilio client:', error.message);
  process.exit(1);
}

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Simplified test function with better error handling
const startTest = async (req, res) => {
  const { persona = 'nervous', scenarioId = 'default' } = req.body;
  const runId = generateRunId();
  
  try {
    logger.info(`Starting test run ${runId} with persona: ${persona}`);
    
    // Test Twilio client first
    if (!twilioClient) {
      throw new Error('Twilio client not initialized');
    }

    // Create Twilio Conference with simpler configuration
    const conference = await twilioClient.conferences.create({
      friendlyName: `AI_Interview_${runId}`,
      statusCallback: `${config.twilio.webhookUrl}/twilio/status`,
      statusCallbackEvent: ['start', 'end'],
      endConferenceOnExit: false,
      maxParticipants: 3
    });

    logger.info(`✅ Conference created: ${conference.sid}`);

    // Store test run
    storage.testRuns.set(runId, {
      runId,
      scenarioId,
      persona,
      conferenceSid: conference.sid,
      status: 'created',
      startTime: new Date().toISOString(),
      participants: {}
    });

    saveEvent(runId, 'test_started', { persona, scenarioId, conferenceSid: conference.sid });

    res.json({
      success: true,
      runId,
      conferenceSid: conference.sid,
      status: 'created',
      message: 'Test conference created successfully!'
    });

  } catch (error) {
    logger.error(`❌ Failed to start test ${runId}:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      runId,
      details: 'Check server logs for more information'
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
    if (testRun.conferenceSid) {
      await twilioClient.conferences(testRun.conferenceSid)
        .update({ status: 'completed' });
    }

    // Update status
    testRun.status = 'completed';
    testRun.endTime = new Date().toISOString();
    
    saveEvent(runId, 'test_completed', { 
      duration: new Date(testRun.endTime) - new Date(testRun.startTime)
    });

    logger.info(`✅ Test run ${runId} completed`);

  } catch (error) {
    logger.error(`❌ Failed to stop test ${runId}:`, error.message);
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
  logger.info('📞 Voice webhook received', { CallSid, From, To });
  
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Hello from AI Interview System');
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/twilio/status', (req, res) => {
  const { ConferenceSid, StatusCallbackEvent, FriendlyName } = req.body;
  logger.info('📊 Conference status event', { ConferenceSid, StatusCallbackEvent, FriendlyName });
  
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeTests: Array.from(storage.testRuns.values()).filter(t => t.status === 'running').length,
    totalTests: storage.testRuns.size,
    config: {
      twilioConfigured: !!(config.twilio.accountSid && config.twilio.authToken),
      vapiConfigured: !!(config.vapi.apiKey && config.vapi.assistantId),
      ultravoxConfigured: !!config.ultravox.apiKey
    }
  });
});

// Debug endpoint
app.get('/debug/twilio', async (req, res) => {
  try {
    const account = await twilioClient.api.accounts(config.twilio.accountSid).fetch();
    res.json({
      success: true,
      account: account.friendlyName,
      conferencesAvailable: typeof twilioClient.conferences.create === 'function',
      twilioVersion: require('twilio/package.json').version
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Simple web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>AI Interview Test System</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .form-group { margin: 20px 0; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            select, button { padding: 12px; margin: 5px 0; border-radius: 5px; border: 1px solid #ddd; }
            button { background: #007bff; color: white; border: none; cursor: pointer; font-weight: bold; }
            button:hover { background: #0056b3; }
            .status { margin: 20px 0; padding: 15px; border-radius: 5px; }
            .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
            .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
            .info { background: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460; }
            .test-list { margin-top: 30px; }
            .test-item { padding: 15px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; background: #f8f9fa; }
            pre { background: #f8f9fa; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
            .header { text-align: center; margin-bottom: 30px; }
            .emoji { font-size: 2em; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="emoji">🤖</div>
                <h1>AI Interview Test System</h1>
                <p>Test AI-powered interviews with different candidate personas</p>
            </div>
            
            <div class="form-group">
                <label for="persona">Select Candidate Persona:</label>
                <select id="persona" style="width: 100%;">
                    <option value="nervous">🤷 Nervous Fresher - Anxious recent graduate</option>
                    <option value="confident">😎 Overconfident Candidate - Assertive and direct</option>
                    <option value="experienced">👔 Senior Professional - Calm and experienced</option>
                </select>
            </div>

            <div class="form-group">
                <button onclick="startTest()" style="width: 200px; margin-right: 10px;">🚀 Start Test</button>
                <button onclick="loadTests()" style="width: 150px; background: #28a745;">📋 Refresh</button>
                <button onclick="checkHealth()" style="width: 150px; background: #6c757d;">💓 Health Check</button>
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
                    statusDiv.innerHTML = '<div class="status info">🔄 Starting test conference...</div>';
                    
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
                                ✅ Conference Created Successfully!<br><br>
                                <strong>Run ID:</strong> \${result.runId}<br>
                                <strong>Conference:</strong> \${result.conferenceSid}<br>
                                <strong>Status:</strong> \${result.status}<br>
                                <strong>Message:</strong> \${result.message}
                            </div>
                        \`;
                        loadTests();
                    } else {
                        statusDiv.innerHTML = \`
                            <div class="status error">
                                ❌ <strong>Error:</strong> \${result.error}<br>
                                \${result.details ? '<br><strong>Details:</strong> ' + result.details : ''}
                            </div>
                        \`;
                    }
                } catch (error) {
                    statusDiv.innerHTML = \`<div class="status error">❌ <strong>Request failed:</strong> \${error.message}</div>\`;
                }
            }

            async function checkHealth() {
                const statusDiv = document.getElementById('status');
                try {
                    const response = await fetch('/health');
                    const result = await response.json();
                    
                    statusDiv.innerHTML = \`
                        <div class="status info">
                            💓 <strong>System Health Check</strong><br><br>
                            <strong>Status:</strong> \${result.status}<br>
                            <strong>Active Tests:</strong> \${result.activeTests}<br>
                            <strong>Total Tests:</strong> \${result.totalTests}<br>
                            <strong>Twilio:</strong> \${result.config.twilioConfigured ? '✅' : '❌'}<br>
                            <strong>Vapi:</strong> \${result.config.vapiConfigured ? '✅' : '❌'}<br>
                            <strong>Ultravox:</strong> \${result.config.ultravoxConfigured ? '✅' : '❌'}
                        </div>
                    \`;
                } catch (error) {
                    statusDiv.innerHTML = \`<div class="status error">❌ Health check failed: \${error.message}</div>\`;
                }
            }

            async function loadTests() {
                try {
                    const response = await fetch('/tests');
                    const result = await response.json();
                    
                    if (result.success) {
                        const testListDiv = document.getElementById('testList');
                        
                        if (result.tests.length === 0) {
                            testListDiv.innerHTML = '<div class="info">📋 <strong>No tests yet.</strong> Start your first test above!</div>';
                            return;
                        }
                        
                        const testItems = result.tests.map(test => \`
                            <div class="test-item">
                                <strong>🧪 \${test.runId}</strong> 
                                <span style="padding: 3px 8px; border-radius: 3px; font-size: 12px; background: \${test.status === 'completed' ? '#28a745' : '#007bff'}; color: white;">
                                    \${test.status.toUpperCase()}
                                </span><br>
                                <strong>Persona:</strong> \${test.persona} | 
                                <strong>Started:</strong> \${new Date(test.startTime).toLocaleString()}<br>
                                <strong>Conference:</strong> \${test.conferenceSid}
                                <br>
                                <button onclick="viewDetails('\${test.runId}')" style="margin-top: 10px; font-size: 12px; padding: 5px 10px;">📊 View Details</button>
                                \${test.status !== 'completed' ? 
                                    \`<button onclick="stopTest('\${test.runId}')" style="margin-top: 10px; margin-left: 5px; font-size: 12px; padding: 5px 10px; background: #dc3545;">⏹️ Stop</button>\` : 
                                    ''
                                }
                            </div>
                        \`).join('');
                        
                        testListDiv.innerHTML = \`
                            <h3>📋 Recent Tests (\${result.tests.length})</h3>
                            \${testItems}
                        \`;
                    }
                } catch (error) {
                    console.error('Failed to load tests:', error);
                }
            }

            async function stopTest(runId) {
                try {
                    const response = await fetch(\`/tests/\${runId}/stop\`, { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        loadTests();
                        document.getElementById('status').innerHTML = '<div class="status info">⏹️ Test stopped successfully</div>';
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
                        
                        const detailsWindow = window.open('', '_blank', 'width=800,height=600');
                        detailsWindow.document.write(\`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>Test Details: \${runId}</title>
                                <style>body { font-family: Arial, sans-serif; margin: 20px; } pre { background: #f8f9fa; padding: 15px; border-radius: 5px; overflow-x: auto; }</style>
                            </head>
                            <body>
                                <h2>📊 Test Run Details: \${runId}</h2>
                                <p><strong>Status:</strong> \${testRun.status}</p>
                                <p><strong>Persona:</strong> \${testRun.persona}</p>
                                <p><strong>Conference SID:</strong> \${testRun.conferenceSid}</p>
                                <p><strong>Start Time:</strong> \${new Date(testRun.startTime).toLocaleString()}</p>
                                <p><strong>End Time:</strong> \${testRun.endTime ? new Date(testRun.endTime).toLocaleString() : 'N/A'}</p>
                                
                                <h3>📅 Events (\${events.length})</h3>
                                <pre>\${JSON.stringify(events, null, 2)}</pre>
                                
                                <h3>📝 Transcripts (\${transcripts.length})</h3>
                                <pre>\${JSON.stringify(transcripts, null, 2)}</pre>
                                
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
    logger.info('🔍 Testing Twilio connection...');
    const account = await twilioClient.api.accounts(config.twilio.accountSid).fetch();
    logger.info('✅ Twilio connection verified', { accountName: account.friendlyName });
    
    // Start server
    app.listen(config.port, () => {
      logger.info(`🚀 AI Interview System running on port ${config.port}`);
      logger.info('📋 System Status:');
      logger.info(`   ✅ Twilio Account: ${config.twilio.accountSid.substring(0, 10)}...`);
      logger.info(`   📡 Webhook URL: ${config.twilio.webhookUrl}`);
      logger.info(`   📞 Vapi Phone: ${config.vapi.phoneNumber || '❌ Not configured'}`);
      logger.info(`   🎭 Ultravox API: ${config.ultravox.apiUrl}`);
      logger.info('\n🎯 System ready! Visit your Render URL to start testing.');
    });
    
  } catch (error) {
    logger.error('❌ Failed to start server:', error.message);
    logger.error('💡 Troubleshooting tips:');
    logger.error('   - Verify TWILIO_ACCOUNT_SID starts with "AC"');
    logger.error('   - Check TWILIO_AUTH_TOKEN is correct');
    logger.error('   - Ensure Twilio account is active and funded');
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('👋 Shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer();