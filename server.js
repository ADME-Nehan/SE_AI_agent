const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

let lastNetwork = null;

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
  };

  return types[ext] || "application/octet-stream";
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  let filePath;

  if (urlPath === "/" || urlPath === "") {
    filePath = path.join(PUBLIC_DIR, "index.html");
  } else {
    filePath = path.join(PUBLIC_DIR, urlPath);
  }

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const indexPath = path.join(PUBLIC_DIR, "index.html");

      fs.readFile(indexPath, (indexErr, indexData) => {
        if (indexErr) {
          return sendText(res, 404, "index.html not found");
        }

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(indexData);
      });

      return;
    }

    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store",
    });

    res.end(data);
  });
}

function getFirebaseConfig() {
  const config = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID,
  };

  const required = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId",
  ];

  const missing = required.filter((key) => !config[key]);

  return {
    ready: missing.length === 0,
    missing,
    config,
  };
}

function getNetworkSpeed() {
  const interfaces = os.networkInterfaces();
  let totalBytes = 0;

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (!net.internal && net.mac) {
        totalBytes += 0;
      }
    }
  }

  const now = Date.now();

  if (!lastNetwork) {
    lastNetwork = { time: now, totalBytes };
    return { upBps: 0, downBps: 0 };
  }

  lastNetwork = { time: now, totalBytes };

  return {
    upBps: 0,
    downBps: 0,
  };
}

function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const load = os.loadavg()[0] || 0;
  const cpuCount = os.cpus().length || 1;
  const cpuPercent = Math.min(100, Math.round((load / cpuCount) * 100));

  return {
    time: new Date().toISOString(),
    cpuPercent,
    ramPercent: Math.round((usedMem / totalMem) * 100),
    ramUsedGb: (usedMem / 1024 / 1024 / 1024).toFixed(2),
    ramTotalGb: (totalMem / 1024 / 1024 / 1024).toFixed(2),
    network: getNetworkSpeed(),
  };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();

      if (body.length > 10_000_000) {
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function extractJson(text) {
  const cleaned = String(text || "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const match = cleaned.match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error("AI response did not contain valid JSON.");
  }

  return JSON.parse(match[0]);
}

function buildAgentPrompt(input) {
  return `
You are an AI software project agent for a solo software engineer.

Use only the provided client idea, transcript, and answers.
Do not invent client facts.
If information is missing, ask questions.

Return ONLY valid JSON. No markdown.

JSON shape:
{
  "project": {
    "name": "",
    "clientName": "",
    "projectType": "",
    "businessGoal": "",
    "summary": "",
    "confidence": 0,
    "accuracyNote": ""
  },
  "requirementSummary": {
    "confirmed": [],
    "recommended": [],
    "assumptionsToConfirm": [],
    "missingInformation": [],
    "outOfScopeUntilConfirmed": []
  },
  "missingQuestions": [
    {
      "category": "",
      "priority": "High",
      "question": "",
      "whyNeeded": ""
    }
  ],
  "uiuxPlanning": {
    "designDirection": "",
    "userFlows": [],
    "wireframePlan": [],
    "editableUiNotes": [],
    "accessibilityChecklist": [],
    "pages": [
      {
        "pageName": "",
        "purpose": "",
        "sections": [],
        "components": [],
        "mobileNotes": "",
        "desktopNotes": ""
      }
    ]
  },
  "developmentPlan": {
    "frontend": {
      "framework": "",
      "reason": "",
      "libraries": []
    },
    "backend": {
      "framework": "",
      "reason": "",
      "services": []
    },
    "database": {
      "name": "",
      "reason": "",
      "collectionsOrTables": [
        {
          "name": "",
          "fields": []
        }
      ]
    },
    "authentication": {
      "method": "",
      "roles": [],
      "rules": []
    },
    "modules": [
      {
        "name": "",
        "description": "",
        "mainFiles": [],
        "dependencies": []
      }
    ],
    "apiRoutes": [
      {
        "method": "",
        "path": "",
        "purpose": ""
      }
    ]
  },
  "infrastructurePlan": {
    "hosting": "",
    "environmentVariables": [],
    "securityChecklist": [],
    "backupPlan": [],
    "deploymentSteps": []
  },
  "fileStructure": {
    "tree": "",
    "notes": []
  },
  "taskPath": [
    {
      "phase": "",
      "goal": "",
      "tasks": [],
      "dependency": "",
      "status": "",
      "definitionOfDone": ""
    }
  ],
  "qaPlan": {
    "testCases": [
      {
        "area": "",
        "priority": "",
        "test": "",
        "expectedResult": ""
      }
    ],
    "responsiveTests": [],
    "securityTests": [],
    "handoverChecks": []
  },
  "clientReport": {
    "overview": "",
    "confirmedScope": [],
    "pendingClientInputs": [],
    "risksOrBlockers": [],
    "nextSteps": [],
    "simpleClientMessage": ""
  }
}

Project name:
${input.projectName || ""}

Client name:
${input.clientName || ""}

Client idea:
${input.clientIdea || ""}

Transcript:
${input.transcript || ""}

Answers:
${JSON.stringify(input.answers || {}, null, 2)}

Current analysis:
${JSON.stringify(input.currentAnalysis || {}, null, 2)}
`;
}

async function handleAnalyze(req, res) {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    const baseUrl = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";

    if (!apiKey) {
      return sendJson(res, 500, {
        error: "GROQ_API_KEY is missing in environment variables.",
      });
    }

    const body = await readBody(req);

    const prompt = buildAgentPrompt(body);

    const groqRes = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a precise software planning AI agent. Return only valid JSON. Never use demo data.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.2,
      }),
    });

    const data = await groqRes.json();

    if (!groqRes.ok) {
      return sendJson(res, groqRes.status, {
        error: data.error?.message || "Groq API request failed.",
      });
    }

    const content = data.choices?.[0]?.message?.content;

    const output = extractJson(content);

    return sendJson(res, 200, {
      output,
      meta: {
        provider: "groq",
        model,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return sendJson(res, 500, {
      error: err.message || "Analyze failed.",
    });
  }
}

async function handleStitchGenerate(req, res) {
  return sendJson(res, 501, {
    error:
      "Stitch API mode is not configured on this server. Use manual mode: copy prompt and paste into Stitch.",
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];

  if (urlPath === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      time: new Date().toISOString(),
    });
  }

  if (urlPath === "/api/firebase-config") {
    return sendJson(res, 200, getFirebaseConfig());
  }

  if (urlPath === "/api/system") {
    return sendJson(res, 200, getSystemMetrics());
  }

  if (urlPath === "/api/analyze" && req.method === "POST") {
    return handleAnalyze(req, res);
  }

  if (urlPath === "/api/stitch/generate" && req.method === "POST") {
    return handleStitchGenerate(req, res);
  }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log("AI Agent Terminal running");
  console.log(`Open: http://localhost:${PORT}`);
  console.log(`Port: ${PORT}`);
  console.log(`Public dir: ${PUBLIC_DIR}`);
});