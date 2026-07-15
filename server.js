/*
  AI Agent Terminal - Firebase + Groq Edition
  No npm install required. Run with: node server.js
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const ENV_PATHS = [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')];

function loadEnv() {
  for (const envPath of ENV_PATHS) {
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const STITCH_BASE_URL = process.env.STITCH_BASE_URL || 'https://stitch.googleapis.com/mcp';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(new Error('Request body too large. Max 5MB.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';
}

function safeStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const filePath = path.normalize(path.join(PUBLIC, cleanPath));
  if (!filePath.startsWith(PUBLIC)) return null;
  return filePath;
}

let previousCpuSnapshot = null;
let previousNetSnapshot = null;

function getCpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type of Object.keys(cpu.times)) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function getCpuPercent() {
  const current = getCpuSnapshot();
  if (!previousCpuSnapshot) {
    previousCpuSnapshot = current;
    return 0;
  }
  const idleDiff = current.idle - previousCpuSnapshot.idle;
  const totalDiff = current.total - previousCpuSnapshot.total;
  previousCpuSnapshot = current;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function sumLinuxNetworkBytes() {
  const file = '/proc/net/dev';
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(2);
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    const parts = line.trim().split(/[:\s]+/);
    if (parts.length < 17) continue;
    const iface = parts[0];
    if (iface === 'lo') continue;
    rx += Number(parts[1] || 0);
    tx += Number(parts[9] || 0);
  }
  return { rx, tx };
}

function sumMacNetworkBytes() {
  try {
    const out = execSync("netstat -ib | awk 'NR>1 && $1 !~ /lo/ {rx+=$7; tx+=$10} END {print rx \" \" tx}'", { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [rx, tx] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) return null;
    return { rx, tx };
  } catch (_) {
    return null;
  }
}

function sumWindowsNetworkBytes() {
  try {
    const ps = `
      $stats = Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress;
      Write-Output $stats;
    `;
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/\n/g, ' ')}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    }).trim();
    if (!out) return null;
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    let rx = 0;
    let tx = 0;
    for (const row of rows) {
      rx += Number(row.ReceivedBytes || 0);
      tx += Number(row.SentBytes || 0);
    }
    return { rx, tx };
  } catch (_) {
    return null;
  }
}

function getNetworkBytes() {
  if (process.platform === 'linux') return sumLinuxNetworkBytes();
  if (process.platform === 'darwin') return sumMacNetworkBytes();
  if (process.platform === 'win32') return sumWindowsNetworkBytes();
  return null;
}

function getNetworkSpeed() {
  const currentBytes = getNetworkBytes();
  const now = Date.now();
  if (!currentBytes) return { downBps: null, upBps: null };
  if (!previousNetSnapshot) {
    previousNetSnapshot = { ...currentBytes, at: now };
    return { downBps: 0, upBps: 0 };
  }
  const seconds = Math.max(0.5, (now - previousNetSnapshot.at) / 1000);
  const downBps = Math.max(0, Math.round((currentBytes.rx - previousNetSnapshot.rx) / seconds));
  const upBps = Math.max(0, Math.round((currentBytes.tx - previousNetSnapshot.tx) / seconds));
  previousNetSnapshot = { ...currentBytes, at: now };
  return { downBps, upBps };
}

function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const net = getNetworkSpeed();
  return {
    cpuPercent: getCpuPercent(),
    ramPercent: Math.round((usedMem / totalMem) * 100),
    ramUsedGb: Number((usedMem / 1024 / 1024 / 1024).toFixed(2)),
    ramTotalGb: Number((totalMem / 1024 / 1024 / 1024).toFixed(2)),
    network: net,
    localIp: getLocalIp(),
    platform: process.platform,
    time: new Date().toISOString(),
  };
}

function firebaseConfig() {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || '',
  };
  return config;
}

const AGENT_SYSTEM_PROMPT = `You are a senior AI software project agent for a solo software engineer.
Your job is to analyze ONLY the provided client idea, meeting transcript, answers, and current project data.
Do not invent client facts. Do not add fake completed work. If information is not provided, mark it as missing and ask a question.
Give practical development guidance: UI/UX, requirements, architecture, infrastructure, file structure, tasks, QA, and client report.
The output must be strict JSON only. No markdown fences. No explanation outside JSON.
Every recommendation must be grounded in the provided data. You may make technical suggestions, but label them as recommendations, not confirmed client requirements.
Keep wording clear and useful for a software engineer who will build the project alone.`;

function buildAgentPrompt(payload) {
  const projectName = payload.projectName || 'Untitled Project';
  const clientName = payload.clientName || 'Unknown Client';
  const clientIdea = payload.clientIdea || '';
  const transcript = payload.transcript || '';
  const answers = payload.answers || {};
  const currentAnalysis = payload.currentAnalysis || null;

  return `Analyze this software project and return a complete project agent output.

PROJECT NAME:
${projectName}

CLIENT NAME:
${clientName}

CLIENT IDEA / INITIAL NOTES:
${clientIdea}

MEETING TRANSCRIPT / TIMESTAMP NOTES:
${transcript}

ANSWERS TO PREVIOUS MISSING QUESTIONS:
${JSON.stringify(answers, null, 2)}

CURRENT SAVED ANALYSIS, IF ANY:
${JSON.stringify(currentAnalysis, null, 2)}

Return JSON in exactly this shape:
{
  "project": {
    "name": "string",
    "clientName": "string",
    "projectType": "string or Unknown",
    "businessGoal": "string or Unknown",
    "summary": "string",
    "confidence": 0,
    "accuracyNote": "string explaining what is confirmed and what is missing"
  },
  "requirementSummary": {
    "confirmed": ["string"],
    "recommended": ["string"],
    "assumptionsToConfirm": ["string"],
    "missingInformation": ["string"],
    "outOfScopeUntilConfirmed": ["string"]
  },
  "missingQuestions": [
    {"category":"Business|Users|Features|Design|Technical|Budget|Timeline|Content|Deployment", "priority":"High|Medium|Low", "question":"string", "whyNeeded":"string"}
  ],
  "uiuxPlanning": {
    "designDirection": "string",
    "pages": [
      {"pageName":"string", "purpose":"string", "sections":["string"], "components":["string"], "mobileNotes":"string", "desktopNotes":"string"}
    ],
    "userFlows": ["string"],
    "wireframePlan": ["string"],
    "editableUiNotes": ["string"],
    "accessibilityChecklist": ["string"]
  },
  "developmentPlan": {
    "frontend": {"framework":"string", "reason":"string", "libraries":["string"]},
    "backend": {"framework":"string", "reason":"string", "services":["string"]},
    "database": {"name":"string", "reason":"string", "collectionsOrTables":[{"name":"string", "fields":["string"]}]},
    "authentication": {"method":"string", "roles":["string"], "rules":["string"]},
    "storage": {"service":"string", "usage":["string"]},
    "modules": [{"name":"string", "description":"string", "mainFiles":["string"], "dependencies":["string"]}],
    "apiRoutes": [{"method":"GET|POST|PUT|PATCH|DELETE", "path":"string", "purpose":"string"}]
  },
  "infrastructurePlan": {
    "hosting":"string",
    "environmentVariables":["string"],
    "securityChecklist":["string"],
    "backupPlan":["string"],
    "deploymentSteps":["string"]
  },
  "fileStructure": {
    "tree":"string with newline escaped folder tree",
    "notes":["string"]
  },
  "taskPath": [
    {"phase":"string", "status":"Not Started|Ready|In Progress|Blocked|Completed", "goal":"string", "tasks":["string"], "dependency":"string", "definitionOfDone":"string"}
  ],
  "qaPlan": {
    "testCases":[{"area":"string", "test":"string", "expectedResult":"string", "priority":"High|Medium|Low"}],
    "responsiveTests":["string"],
    "securityTests":["string"],
    "handoverChecks":["string"]
  },
  "clientReport": {
    "overview":"string",
    "confirmedScope":["string"],
    "pendingClientInputs":["string"],
    "risksOrBlockers":["string"],
    "nextSteps":["string"],
    "simpleClientMessage":"string"
  }
}`;
}

function extractJson(text) {
  if (!text) throw new Error('AI returned empty response.');
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch (_) {}
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const slice = trimmed.slice(first, last + 1);
    return JSON.parse(slice);
  }
  throw new Error('AI response was not valid JSON. Try again or use a stronger JSON-capable Groq model.');
}

function validateAgentOutput(output) {
  const required = ['project', 'requirementSummary', 'missingQuestions', 'uiuxPlanning', 'developmentPlan', 'infrastructurePlan', 'fileStructure', 'taskPath', 'qaPlan', 'clientReport'];
  for (const key of required) {
    if (!output || typeof output !== 'object' || !(key in output)) {
      throw new Error(`AI JSON missing required section: ${key}`);
    }
  }
  return output;
}

async function callGroqAgent(payload) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error('GROQ_API_KEY is missing. Add it to .env.local and restart node server.js.');
    err.status = 400;
    throw err;
  }

  const userPrompt = buildAgentPrompt(payload);
  const response = await fetch(`${GROQ_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 6000,
      response_format: { type: 'json_object' },
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      message = parsed.error?.message || parsed.message || raw;
    } catch (_) {}
    const err = new Error(`Groq API error: ${message}`);
    err.status = response.status;
    throw err;
  }

  let json;
  try { json = JSON.parse(raw); } catch (e) { throw new Error('Groq API returned invalid response JSON.'); }
  const content = json.choices?.[0]?.message?.content;
  const output = validateAgentOutput(extractJson(content));
  return {
    output,
    meta: {
      model: json.model || GROQ_MODEL,
      createdAt: new Date().toISOString(),
      provider: 'groq',
      demoData: false,
    },
  };
}


async function callStitchGenerate(payload) {
  const apiKey = process.env.STITCH_API_KEY;
  if (!apiKey) {
    const err = new Error('STITCH_API_KEY is missing. Add it to .env.local. You can still copy the Stitch prompt and use stitch.withgoogle.com manually.');
    err.status = 400;
    throw err;
  }

  let sdk;
  try {
    sdk = await import('@google/stitch-sdk');
  } catch (_) {
    const err = new Error('Optional package @google/stitch-sdk is not installed. Run: npm install @google/stitch-sdk, then restart node server.js. Manual Stitch prompt mode still works without installing it.');
    err.status = 501;
    throw err;
  }

  const title = String(payload.title || 'AI Agent UI Project').slice(0, 120);
  const prompt = String(payload.prompt || '').trim();
  const deviceType = payload.deviceType || 'DESKTOP';
  if (!prompt) {
    const err = new Error('Stitch prompt is required. Open /uiux or /stitch after running /analyze.');
    err.status = 400;
    throw err;
  }

  const client = new sdk.StitchToolClient({
    apiKey,
    baseUrl: STITCH_BASE_URL,
    timeout: 300000,
  });

  try {
    const stitch = new sdk.Stitch(client);
    const created = await client.callTool('create_project', { title });
    const projectId = created?.projectId || created?.id || created?.project?.projectId || created?.project?.id;
    if (!projectId) throw new Error('Stitch project created, but project ID was not returned by Stitch.');

    const project = stitch.project(projectId);
    const screen = await project.generate(prompt, deviceType);
    const htmlUrl = await screen.getHtml();
    const imageUrl = await screen.getImage();

    return {
      projectId,
      screenId: screen?.screenId || screen?.id || null,
      htmlUrl,
      imageUrl,
      stitchHomeUrl: 'https://stitch.withgoogle.com/',
      generatedAt: new Date().toISOString(),
      deviceType,
      prompt,
    };
  } finally {
    try { await client.close(); } catch (_) {}
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, app: 'AI Agent Terminal Firebase', time: new Date().toISOString() });
  }

  if (url.pathname === '/api/firebase-config') {
    const config = firebaseConfig();
    const missing = Object.entries(config).filter(([k, v]) => k !== 'measurementId' && !v).map(([k]) => k);
    return sendJson(res, 200, { config, ready: missing.length === 0, missing });
  }

  if (url.pathname === '/api/system') {
    return sendJson(res, 200, getSystemMetrics());
  }

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const hasInput = [payload.projectName, payload.clientName, payload.clientIdea, payload.transcript].some(v => String(v || '').trim().length > 0);
      if (!hasInput) return sendJson(res, 400, { error: 'Add a project name, client idea, or transcript before running analysis.' });
      const result = await callGroqAgent(payload);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || 'Analysis failed.' });
    }
  }


  if (url.pathname === '/api/stitch/generate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const result = await callStitchGenerate(payload);
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      return sendJson(res, err.status || 500, { ok: false, error: err.message || 'Stitch generation failed.' });
    }
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url);
    if (handled === false) sendJson(res, 404, { error: 'API route not found.' });
    return;
  }

  let filePath = safeStaticPath(url.pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return sendText(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mimeType(filePath) });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\nAI Agent Terminal Firebase is running`);
  console.log(`Open: http://localhost:${PORT}`);
  console.log(`Groq model: ${GROQ_MODEL}`);
  console.log(`Firebase project: ${process.env.FIREBASE_PROJECT_ID || 'not configured'}\n`);
});
