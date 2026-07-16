import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const $ = (sel) => document.querySelector(sel);
const appRoot = document.getElementById('app');

const state = {
  firebaseReady: false,
  firebaseMissing: [],
  authReady: false,
  uid: null,
  db: null,
  projects: [],
  activeProjectId: null,
  activeView: 'home',
  logs: [],
  metrics: null,
  modal: null,
  busy: false,
};

const VIEW_NAMES = {
  home: 'Agent Home',
  projects: 'Project Folders',
  intake: 'Client Intake',
  summary: 'Requirement Summary',
  questions: 'Missing Questions',
  uiux: 'UI/UX Planner',
  stitch: 'Stitch UI Generator',
  dev: 'Developer Plan',
  infra: 'Infrastructure',
  files: 'File Structure',
  tasks: 'Task Path',
  qa: 'QA Plan',
  report: 'Client Report',
};

function slugify(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

function fmtDate(value) {
  if (!value) return 'Unknown time';

  const date = value?.toDate ? value.toDate() : new Date(value);

  if (Number.isNaN(date.getTime())) return 'Unknown time';

  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBytesPerSecond(bytes) {
  if (bytes == null) return 'N/A';
  if (bytes < 1024) return `${bytes} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB/s`;
}

function activeProject() {
  return state.projects.find((p) => p.id === state.activeProjectId) || null;
}

function activeAnalysis() {
  return activeProject()?.analysis || null;
}

function addLog(text, type = 'muted') {
  state.logs.push({
    text,
    type,
    at: new Date().toISOString(),
  });

  if (state.logs.length > 180) {
    state.logs = state.logs.slice(-180);
  }

  render();

  setTimeout(() => {
    const out = $('.terminal-output');
    if (out) out.scrollTop = out.scrollHeight;
  }, 0);
}

function setView(view) {
  state.activeView = view;
  render();
}

function projectCollection() {
  if (!state.db || !state.uid) return null;
  return collection(state.db, 'users', state.uid, 'projects');
}

function projectDoc(id) {
  if (!state.db || !state.uid) return null;
  return doc(state.db, 'users', state.uid, 'projects', id);
}

async function init() {
  renderBoot('Loading system metrics...');
  await fetchMetrics();

  renderBoot('Reading Firebase config...');

  const cfgRes = await fetch('/api/firebase-config');
  const cfg = await cfgRes.json();

  state.firebaseReady = cfg.ready;
  state.firebaseMissing = cfg.missing || [];

  if (!cfg.ready) {
    state.logs = [
      {
        type: 'warn',
        text: 'Firebase is not configured yet.',
      },
      {
        type: 'muted',
        text: `Missing env keys: ${state.firebaseMissing.join(', ')}`,
      },
      {
        type: 'cyan',
        text: 'Add Firebase values to .env.local, enable Anonymous Auth, create Firestore, then restart node server.js.',
      },
    ];

    render();
    startMetricLoop();
    return;
  }

  try {
    renderBoot('Starting Firebase anonymous session...');

    const firebaseApp = initializeApp(cfg.config);
    const auth = getAuth(firebaseApp);

    state.db = getFirestore(firebaseApp);

    await signInAnonymously(auth);

    onAuthStateChanged(auth, (user) => {
      if (!user) return;

      state.uid = user.uid;
      state.authReady = true;

      subscribeProjects();

      state.logs = [
        {
          type: 'success',
          text: 'AI Agent Terminal started successfully.',
        },
        {
          type: 'muted',
          text: 'No demo project is loaded. Use /new Project Name or click New Project.',
        },
        {
          type: 'cyan',
          text: 'Type /help to see all commands.',
        },
      ];

      render();
    });
  } catch (err) {
    state.logs = [
      {
        type: 'error',
        text: `Firebase start failed: ${err.message}`,
      },
      {
        type: 'warn',
        text: 'Check Firebase config, enable Anonymous Auth, and Firestore rules.',
      },
    ];

    render();
  }

  startMetricLoop();
}

function renderBoot(line) {
  appRoot.innerHTML = `
    <div class="boot-screen">
      <div class="boot-card">
        <div class="boot-title">AI Agent Terminal</div>
        <div class="boot-line">${escapeHtml(line)}</div>
      </div>
    </div>
  `;
}

function subscribeProjects() {
  const col = projectCollection();
  if (!col) return;

  const q = query(col, orderBy('updatedAt', 'desc'));

  onSnapshot(
    q,
    (snap) => {
      state.projects = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));

      if (!state.activeProjectId && state.projects.length) {
        state.activeProjectId = state.projects[0].id;
      }

      if (
        state.activeProjectId &&
        !state.projects.find((p) => p.id === state.activeProjectId)
      ) {
        state.activeProjectId = state.projects[0]?.id || null;
      }

      render();
    },
    (err) => {
      addLog(`Firestore read failed: ${err.message}`, 'error');
    }
  );
}

async function fetchMetrics() {
  try {
    const res = await fetch('/api/system');
    state.metrics = await res.json();
  } catch (_) {
    state.metrics = null;
  }
}

function startMetricLoop() {
  setInterval(async () => {
    await fetchMetrics();
    renderMetricsOnly();
  }, 2000);
}

function renderMetricsOnly() {
  const metrics = $('.metrics-grid');
  if (metrics) metrics.innerHTML = metricsHtml();
}

async function createProject({ name, clientName, clientIdea, transcript = '' }) {
  if (!state.authReady) {
    return addLog('Firebase is not ready yet.', 'error');
  }

  const cleanName = String(name || '').trim();

  if (!cleanName) {
    return addLog('Project name is required.', 'error');
  }

  const ref = await addDoc(projectCollection(), {
    name: cleanName,
    slug: slugify(cleanName),
    clientName: String(clientName || '').trim(),
    clientIdea: String(clientIdea || '').trim(),
    transcript: String(transcript || '').trim(),
    answers: {},
    analysis: null,
    analysisMeta: null,
    stitch: null,
    commandLog: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  state.activeProjectId = ref.id;
  state.activeView = 'intake';
  state.modal = null;

  addLog(`Created new Firebase project: ${cleanName}`, 'success');
  addLog('Paste client idea or transcript in the intake panel, then run /analyze.', 'cyan');

  render();
}

async function updateActiveProject(patch) {
  const project = activeProject();

  if (!project) {
    return addLog('No active project selected.', 'error');
  }

  await updateDoc(projectDoc(project.id), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
}

async function deleteActiveProject() {
  const project = activeProject();

  if (!project) return;

  const ok = confirm(`Delete project "${project.name}" from Firebase?`);

  if (!ok) return;

  await deleteDoc(projectDoc(project.id));

  state.activeProjectId = null;
  state.activeView = 'home';

  addLog(`Deleted project: ${project.name}`, 'warn');
}

function selectProject(id) {
  state.activeProjectId = id;

  const project = activeProject();

  state.activeView = project?.analysis ? 'summary' : 'intake';

  addLog(`Opened project: ${project?.name || id}`, 'success');

  render();
}

function findProjectByCommand(value) {
  const input = value.replace(/^cd\s+/i, '').trim().replace(/^\//, '');
  const [projectPart, sectionPart] = input.split('/').filter(Boolean);

  if (!projectPart) {
    return {
      project: null,
      section: null,
    };
  }

  const wanted = slugify(projectPart);

  const project = state.projects.find(
    (p) =>
      p.slug === wanted ||
      slugify(p.name) === wanted ||
      p.name.toLowerCase() === projectPart.toLowerCase()
  );

  const section = normalizeSection(sectionPart);

  return {
    project,
    section,
  };
}

function normalizeSection(value) {
  const v = slugify(value || '');

  const map = {
    'requirement-summary': 'summary',
    summary: 'summary',
    questions: 'questions',
    'missing-questions': 'questions',
    uiux: 'uiux',
    'ui-ux': 'uiux',
    'ui-ux-planner': 'uiux',
    stitch: 'stitch',
    'stitch-ui': 'stitch',
    'stitch-generator': 'stitch',
    'developer-plan': 'dev',
    dev: 'dev',
    development: 'dev',
    infrastructure: 'infra',
    infra: 'infra',
    'file-structure': 'files',
    files: 'files',
    tasks: 'tasks',
    'task-path': 'tasks',
    qa: 'qa',
    'client-report': 'report',
    report: 'report',
    intake: 'intake',
  };

  return map[v] || null;
}

async function runAnalyze() {
  const project = activeProject();

  if (!project) {
    return addLog('Create or open a project first. Use /new Project Name.', 'error');
  }

  const inputText = [project.clientIdea, project.transcript]
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!inputText) {
    return addLog('No client idea or transcript found. Use /intake first.', 'error');
  }

  state.busy = true;
  render();

  addLog('Sending grounded project data to Groq AI...', 'cyan');

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectName: project.name,
        clientName: project.clientName,
        clientIdea: project.clientIdea,
        transcript: project.transcript,
        answers: project.answers || {},
        currentAnalysis: project.analysis || null,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'AI analysis failed.');
    }

    await updateActiveProject({
      analysis: data.output,
      analysisMeta: data.meta,
    });

    state.activeView = 'summary';

    addLog('AI analysis saved to Firebase. Opening /summary.', 'success');
  } catch (err) {
    addLog(err.message, 'error');
    addLog('No demo data was used. Fix the API/config issue and run /analyze again.', 'warn');
  } finally {
    state.busy = false;
    render();
  }
}

async function handleCommand(raw) {
  const command = String(raw || '').trim();

  if (!command) return;

  addLog(`agent@workspace:~$ ${command}`, 'success');

  if (command === '/help') return showHelp();

  if (command === 'clear') {
    state.logs = [];
    return render();
  }

  if (command === 'ls' || command === '/projects' || command === 'all projects') {
    state.activeView = 'projects';
    addLog(`Found ${state.projects.length} Firebase project folder(s).`, 'cyan');
    return render();
  }

  if (command.startsWith('/new')) {
    const name = command.replace('/new', '').trim();

    if (name) {
      return createProject({
        name,
        clientName: '',
        clientIdea: '',
      });
    }

    state.modal = 'newProject';
    return render();
  }

  if (command.startsWith('cd ')) {
    const { project, section } = findProjectByCommand(command);

    if (!project) {
      return addLog('Project not found. Type /projects to see saved Firebase projects.', 'error');
    }

    state.activeProjectId = project.id;
    state.activeView = section || (project.analysis ? 'summary' : 'intake');

    addLog(`Changed directory to /${project.slug}${section ? '/' + section : ''}`, 'success');

    return render();
  }

  if (command === '/intake') return setView('intake');
  if (command === '/analyze') return runAnalyze();
  if (command === '/summary') return setView('summary');
  if (command === '/questions') return setView('questions');
  if (command === '/uiux' || command === '/ui-ux') return setView('uiux');
  if (command === '/stitch' || command === '/stitch-ui') return setView('stitch');

  if (command.startsWith('/stitch-url ')) {
    return saveStitchUrl(command.replace('/stitch-url', '').trim());
  }

  if (command === '/stitch-generate') return runStitchGenerate();
  if (command === '/dev' || command === '/development') return setView('dev');
  if (command === '/infra' || command === '/infrastructure') return setView('infra');
  if (command === '/files' || command === '/file-structure') return setView('files');
  if (command === '/tasks' || command === 'all tasks') return setView('tasks');
  if (command === '/qa') return setView('qa');
  if (command === '/report') return setView('report');
  if (command === '/delete') return deleteActiveProject();

  addLog('Unknown command. Type /help.', 'warn');
}

function showHelp() {
  addLog(
    `Available commands:
/help                         Show all commands
/new Project Name             Create new Firebase project
/projects                     Show saved projects as folders
cd /project-name              Open project
cd /project-name/uiux         Open project UI/UX planner
/intake                       Add client idea / meeting transcript
/analyze                      Generate real AI output and save to Firebase
/summary                      Requirement summary
/questions                    Missing client questions
/uiux                         UI/UX planning
/stitch                       Open Stitch UI prompt/link panel
/stitch-url https://...       Save Stitch design/share URL to project
/stitch-generate              Generate UI using optional Stitch SDK
/dev                          Frontend/backend/database/auth plan
/infra                        Hosting, env, security, deployment
/files                        AI generated file structure
/tasks or all tasks           Project task path
/qa                           QA checklist and tests
/report                       Client report
/delete                       Delete active Firebase project
clear                         Clear terminal logs`,
    'cyan'
  );
}

function metricsHtml() {
  const m = state.metrics || {};
  const net = m.network || {};
  const time = m.time ? new Date(m.time).toLocaleTimeString() : new Date().toLocaleTimeString();

  return `
    <div class="metric-pill">
      <span class="metric-label">CPU</span>
      <span class="metric-value">${escapeHtml(m.cpuPercent ?? 0)}%</span>
    </div>

    <div class="metric-pill">
      <span class="metric-label">RAM</span>
      <span class="metric-value">${escapeHtml(m.ramPercent ?? 0)}%</span>
    </div>

    <div class="metric-pill">
      <span class="metric-label">MEMORY</span>
      <span class="metric-value">${escapeHtml(m.ramUsedGb ?? '-')} / ${escapeHtml(m.ramTotalGb ?? '-')}GB</span>
    </div>

    <div class="metric-pill">
      <span class="metric-label">NET ↓</span>
      <span class="metric-value">${escapeHtml(formatBytesPerSecond(net.downBps))}</span>
    </div>

    <div class="metric-pill">
      <span class="metric-label">NET ↑</span>
      <span class="metric-value">${escapeHtml(formatBytesPerSecond(net.upBps))}</span>
    </div>

    <div class="metric-pill">
      <span class="metric-label">TIME</span>
      <span class="metric-value">${escapeHtml(time)}</span>
    </div>
  `;
}

function navItem(view, icon, label, badge = '') {
  const active = state.activeView === view ? 'active' : '';

  return `
    <button class="nav-item ${active}" data-view-target="${escapeHtml(view)}">
      <span class="ic">${escapeHtml(icon)}</span>
      <span>${escapeHtml(label)}</span>
      ${badge ? `<span class="nav-badge">${escapeHtml(badge)}</span>` : ''}
    </button>
  `;
}

function renderTopHeader(project) {
  const view = VIEW_NAMES[state.activeView] || state.activeView;
  const title = project?.name || 'New Project Workspace';

  return `
    <header class="top-header">
      <div class="brand">
        <span class="prompt-glyph">▍</span>
        console<span>.dev</span>
      </div>

      <div class="header-divider"></div>

      <div class="project-select">
        <span class="label">Active Project</span>
        <span class="name">${escapeHtml(title)}</span>
      </div>

      <div class="agent-status">
        <span class="live-dot"></span>
        ${state.busy ? 'Agent: Processing' : state.firebaseReady ? 'Agent: Online' : 'Agent: Setup'}
      </div>

      <div class="header-view-pill">${escapeHtml(view)}</div>

      <div class="metrics-grid">${metricsHtml()}</div>

      <div class="bell">⌁</div>
    </header>
  `;
}

function renderRightPanel() {
  const p = activeProject();
  const a = activeAnalysis();

  const questions = (a?.missingQuestions || []).slice(0, 4);

  const goals = [
    a?.project?.businessGoal,
    a?.project?.projectType,
    a?.uiuxPlanning?.designDirection,
  ]
    .filter(Boolean)
    .slice(0, 3);

  const recentLogs = state.logs.slice(-5).reverse();

  return `
    <aside class="right-panel">
      <h2>Agent Activity</h2>

      ${
        recentLogs.length
          ? recentLogs
              .map(
                (log) => `
                  <div class="feed-item">
                    <div class="t">${escapeHtml(log.at ? fmtDate(log.at) : 'now')}</div>
                    <div class="m ${escapeHtml(log.type || '')}">
                      ${escapeHtml(log.text || '')}
                    </div>
                  </div>
                `
              )
              .join('')
          : `<div class="feed-item"><div class="m">No activity yet. Create a project and run /analyze.</div></div>`
      }

      <h2 class="mt2">Extracted Client Goals</h2>

      <div class="pill-row">
        ${
          goals.length
            ? goals
                .map((g) => `<span class="pill">${escapeHtml(String(g).slice(0, 44))}</span>`)
                .join('')
            : `<span class="pill muted-pill">Waiting for /analyze</span>`
        }
      </div>

      <h2 class="mt2">Warnings</h2>

      ${
        !state.firebaseReady
          ? `<div class="alert-box">Firebase config is missing. Add .env.local values before using project history.</div>`
          : ''
      }

      ${p && !a ? `<div class="alert-box">Project has no AI plan yet. Add intake and run /analyze.</div>` : ''}

      ${
        questions.length
          ? questions
              .map(
                (q) => `
                  <div class="alert-box">
                    ${escapeHtml(q.question || 'Missing detail')}<br>
                    <span>${escapeHtml(q.priority || 'Medium')} priority</span>
                  </div>
                `
              )
              .join('')
          : `<div class="alert-box ok">No active requirement warnings shown.</div>`
      }
    </aside>
  `;
}

function render() {
  const project = activeProject();

  appRoot.innerHTML = `
    <div class="console-shell">
      ${renderTopHeader(project)}
      ${renderHistoryPanel()}

      <main class="main-panel">
        ${renderTerminal()}
        <section class="workspace">
          ${renderWorkspace()}
        </section>
      </main>

      ${renderRightPanel()}
      ${renderModal()}
    </div>
  `;

  bindEvents();
}

function renderHistoryPanel() {
  const qCount = activeAnalysis()?.missingQuestions?.length || '';

  return `
    <aside class="history-panel" id="sidebar">
      <div class="sect-label">Navigate</div>

      ${navItem('home', '#', 'Dashboard')}
      ${navItem('intake', '◆', 'Client Intake')}
      ${navItem('projects', '▣', 'Projects')}
      ${navItem('summary', '≡', 'Requirement Analysis')}
      ${navItem('questions', '?', 'Missing Questions', qCount ? String(qCount) : '')}
      ${navItem('uiux', '◫', 'UI/UX Planner')}
      ${navItem('stitch', '◇', 'Stitch UI Link')}
      ${navItem('dev', '⌘', 'Developer Plan')}
      ${navItem('infra', '☁', 'Infrastructure')}
      ${navItem('files', '/', 'File Structure')}
      ${navItem('tasks', '▤', 'Task Phases')}
      ${navItem('qa', '✓', 'QA')}
      ${navItem('report', '▣', 'Client Report')}

      <div class="sect-label projects-label">Project History</div>

      <button class="new-btn" data-action="open-new">+ New Project</button>

      ${
        !state.firebaseReady
          ? `<div class="setup-banner">Firebase env is missing. Project save is disabled until config is added.</div>`
          : ''
      }

      <div class="project-list">
        ${
          state.projects.length
            ? state.projects
                .map(
                  (p) => `
                    <div class="project-item ${p.id === state.activeProjectId ? 'active' : ''}" data-project-id="${p.id}">
                      <div class="project-name">
                        <span class="folder-mini">▣</span>
                        ${escapeHtml(p.name)}
                      </div>

                      <div class="project-meta">
                        ${escapeHtml(p.clientName || 'No client name')} • ${escapeHtml(fmtDate(p.updatedAt))}
                      </div>

                      <div class="project-meta">
                        ${p.analysis ? 'AI plan saved' : 'Waiting for /analyze'}
                      </div>
                    </div>
                  `
                )
                .join('')
            : `
              <div class="empty-card compact">
                <div class="muted">No saved projects yet.</div>
                <div class="muted">Use <b>/new Project Name</b>.</div>
              </div>
            `
        }
      </div>

      <div class="history-footer">
        Firebase auth: <span class="log-success">anonymous</span><br />
        Data path: <span class="log-success">users/{uid}/projects</span><br />
        AI demo fallback: <span class="log-error">OFF</span>
      </div>
    </aside>
  `;
}

/* FIXED: Only one renderTerminal function */
function renderTerminal() {
  const project = activeProject();
  const promptPath = project ? `~/${project.slug}/${state.activeView}` : '~/new-workspace';

  return `
    <section class="terminal-section">
      <div class="terminal-card">
        <div class="terminal-card-bar">
          <div class="terminal-dots">
            <span class="tdot g"></span>
            <span class="tdot c"></span>
            <span class="tdot a"></span>
          </div>

          <span class="terminal-title">
            agent-terminal — ${escapeHtml(promptPath)}
          </span>

          <span class="terminal-live">
            <span class="live-dot small"></span>
            ${state.busy ? 'processing' : 'live'}
          </span>
        </div>

        <div class="terminal-output">
          ${
            state.logs.length
              ? state.logs.map((log) => renderTerminalLog(log)).join('')
              : renderTerminalGreeting()
          }

          ${state.busy ? `<div class="terminal-line terminal-warn">AI is processing... please wait.</div>` : ''}
        </div>

        <form class="terminal-input-form" id="commandForm">
          <span class="terminal-prompt-symbol">›</span>

          <input
            class="terminal-input"
            id="commandInput"
            autocomplete="off"
            placeholder="Type a command… e.g. '/help', '/new Project Name', '/projects', 'cd /project/uiux'"
            ${state.busy ? 'disabled' : ''}
          />
        </form>
      </div>
    </section>
  `;
}

function renderTerminalGreeting() {
  return `
    <div class="terminal-line terminal-success">AI Agent Terminal v1.0.0</div>
    <div class="terminal-line terminal-muted">Your AI partner for planning, building, and delivering.</div>
    <div class="terminal-line"></div>
    <div class="terminal-line terminal-muted">Welcome, developer.</div>
    <div class="terminal-line terminal-muted">Type <span class="terminal-cmd">/help</span> to see all available commands.</div>
    <div class="terminal-line"></div>
    <div class="terminal-line">
      <span class="terminal-user">agent@firebase</span><span class="terminal-path">:~$</span>
      <span class="terminal-cmd"> /help</span>
    </div>
  `;
}

function renderTerminalLog(log) {
  const text = escapeHtml(log.text || '');
  const type = log.type || 'muted';

  let cls = 'terminal-muted';

  if (type === 'success') cls = 'terminal-success';
  if (type === 'cyan') cls = 'terminal-cyan';
  if (type === 'warn') cls = 'terminal-warn';
  if (type === 'error') cls = 'terminal-error';

  return `<div class="terminal-line ${cls}">${text}</div>`;
}

function renderWorkspace() {
  if (!state.firebaseReady) return renderFirebaseSetup();

  if (state.activeView === 'projects') return renderProjectsView();

  if (!activeProject()) return renderHomeView();

  if (state.activeView === 'intake') return renderIntakeView();

  const analysis = activeAnalysis();

  if (!analysis) return renderNeedAnalyze();

  if (state.activeView === 'summary') return renderSummary(analysis);
  if (state.activeView === 'questions') return renderQuestions(analysis);
  if (state.activeView === 'uiux') return renderUiux(analysis);
  if (state.activeView === 'stitch') return renderStitch(analysis);
  if (state.activeView === 'dev') return renderDev(analysis);
  if (state.activeView === 'infra') return renderInfra(analysis);
  if (state.activeView === 'files') return renderFiles(analysis);
  if (state.activeView === 'tasks') return renderTasks(analysis);
  if (state.activeView === 'qa') return renderQa(analysis);
  if (state.activeView === 'report') return renderReport(analysis);

  return renderHomeView();
}

function renderFirebaseSetup() {
  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Firebase setup required</h3>

        <p class="muted">
          This version does not use demo data or local-only fake data.
          Add Firebase config to <b>.env.local</b>, restart the server, and data will save in Firestore.
        </p>

        <div class="code-block">Missing env keys:\n${escapeHtml(state.firebaseMissing.join('\n'))}</div>
      </div>

      <div class="card span-6">
        <h3>Required Firebase services</h3>

        <ul class="list">
          <li>Firebase Web App config</li>
          <li>Authentication → Anonymous sign-in enabled</li>
          <li>Cloud Firestore database</li>
          <li>Firestore security rules from firestore.rules</li>
        </ul>
      </div>

      <div class="card span-6">
        <h3>Required Groq service</h3>

        <ul class="list">
          <li>GROQ_API_KEY in .env.local</li>
          <li>Valid Groq model name</li>
          <li>No demo fallback is active</li>
        </ul>
      </div>
    </div>
  `;
}

function renderHomeView() {
  return `
    <div class="empty-state">
      <div class="empty-card">
        <h2>Welcome to AI Agent Terminal</h2>

        <p>No project is open. This is like ChatGPT New Chat, but every project is saved to Firebase.</p>

        <p class="muted">
          Start with <b>/new Project Name</b>, or open an old project from the left history panel.
        </p>

        <div class="actions" style="justify-content:center">
          <button class="new-btn" style="width:auto" data-action="open-new">+ New Project</button>
          <button class="ghost-btn" data-action="show-projects">Show Projects</button>
        </div>
      </div>
    </div>
  `;
}

function renderNeedAnalyze() {
  const p = activeProject();

  return `
    <div class="empty-state">
      <div class="empty-card">
        <h2>${escapeHtml(p.name)}</h2>

        <p>This project is saved in Firebase, but AI analysis is not generated yet.</p>

        <p class="muted">
          Open <b>/intake</b>, add the client idea or meeting transcript, then run <b>/analyze</b>.
        </p>

        <div class="actions" style="justify-content:center">
          <button class="small-btn" data-action="view-intake">Open Intake</button>
          <button class="small-btn" data-action="run-analyze">Run Analyze</button>
        </div>
      </div>
    </div>
  `;
}

function renderProjectsView() {
  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Firebase Project Folders</h3>

        <p class="muted">
          Type <b>cd /project-name</b> or click a folder.
          This view appears when you use <b>/projects</b>.
        </p>
      </div>

      <div class="card span-12">
        <div class="folder-grid">
          ${
            state.projects.length
              ? state.projects
                  .map(
                    (p) => `
                      <div class="folder-card" data-project-id="${p.id}">
                        <div class="folder-icon">▰</div>

                        <div class="folder-title">
                          /${escapeHtml(p.slug || slugify(p.name))}
                        </div>

                        <div class="folder-meta">${escapeHtml(p.name)}</div>

                        <div class="folder-meta">
                          ${p.analysis ? 'Summary • UI/UX • Dev • QA ready' : 'Intake only'}
                        </div>
                      </div>
                    `
                  )
                  .join('')
              : `<div class="muted">No projects found. Use /new Project Name.</div>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderIntakeView() {
  const p = activeProject();

  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Client Intake</h3>

        <p class="muted">
          Paste meeting transcript, timestamp notes, or client idea.
          This is saved to Firebase. Then run <b>/analyze</b>.
        </p>
      </div>

      <div class="card span-6">
        <h3>Project Details</h3>

        <label class="muted">Project name</label>
        <input class="input" id="projectNameInput" value="${escapeHtml(p.name || '')}" />

        <br /><br />

        <label class="muted">Client name</label>
        <input class="input" id="clientNameInput" value="${escapeHtml(p.clientName || '')}" />

        <br /><br />

        <label class="muted">Client idea / short brief</label>
        <textarea class="textarea" id="clientIdeaInput" style="min-height:140px">${escapeHtml(p.clientIdea || '')}</textarea>
      </div>

      <div class="card span-6">
        <h3>Meeting Transcript / Timestamp Notes</h3>

        <textarea
          class="textarea"
          id="transcriptInput"
          placeholder="Example: 00:03 Client says they need admin dashboard..."
        >${escapeHtml(p.transcript || '')}</textarea>

        <div class="actions">
          <button class="small-btn" data-action="save-intake">Save Intake</button>
          <button class="small-btn" data-action="run-analyze">Run /analyze</button>
        </div>

        <p class="muted">
          The AI will ask missing questions instead of guessing unknown client details.
        </p>
      </div>
    </div>
  `;
}

function renderSummary(a) {
  const r = a.requirementSummary || {};

  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Requirement Summary</h3>

        <p>${escapeHtml(a.project?.summary || '')}</p>

        <div class="badge-row">
          <span class="badge">Confidence: ${escapeHtml(a.project?.confidence ?? 0)}%</span>
          <span class="badge warn">No guessing mode</span>
          <span class="badge">Saved in Firebase</span>
        </div>

        <p class="muted">${escapeHtml(a.project?.accuracyNote || '')}</p>
      </div>

      ${listCard('Confirmed Requirements', r.confirmed, 'span-6')}
      ${listCard('Recommended Technical Items', r.recommended, 'span-6')}
      ${listCard('Assumptions To Confirm', r.assumptionsToConfirm, 'span-6')}
      ${listCard('Missing Information', r.missingInformation, 'span-6')}
      ${listCard('Out Of Scope Until Confirmed', r.outOfScopeUntilConfirmed, 'span-12')}
    </div>
  `;
}

function renderQuestions(a) {
  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Missing Client Questions</h3>

        <p class="muted">
          Answer these, save, then run <b>/analyze</b> again for a more accurate plan.
        </p>
      </div>

      <div class="card span-12">
        ${
          (a.missingQuestions || []).length
            ? (a.missingQuestions || [])
                .map(
                  (q, idx) => `
                    <div class="question-card">
                      <div class="question-head">
                        <span class="question-category">${escapeHtml(q.category || 'Question')}</span>
                        <span class="priority">${escapeHtml(q.priority || 'Medium')}</span>
                      </div>

                      <div>${escapeHtml(q.question || '')}</div>

                      <div class="muted" style="margin-top:5px">
                        Why: ${escapeHtml(q.whyNeeded || '')}
                      </div>

                      <input
                        class="input answer-input"
                        data-answer-key="q${idx}"
                        placeholder="Type client answer here..."
                        value="${escapeHtml(activeProject()?.answers?.[`q${idx}`] || '')}"
                        style="margin-top:10px"
                      />
                    </div>
                  `
                )
                .join('')
            : '<p class="muted">No missing questions returned.</p>'
        }

        <div class="actions">
          <button class="small-btn" data-action="save-answers">Save Answers</button>
          <button class="small-btn" data-action="run-analyze">Re-analyze</button>
        </div>
      </div>
    </div>
  `;
}

function renderUiux(a) {
  const u = a.uiuxPlanning || {};

  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>UI/UX Planner</h3>

        <p>${escapeHtml(u.designDirection || '')}</p>

        <div class="actions">
          <button class="small-btn" data-action="view-stitch">Open Stitch UI Generator</button>
          <button class="ghost-btn" data-action="open-stitch-web">Open Stitch Website</button>
        </div>
      </div>

      <div class="card span-8">
        <h3>Pages & Wireframe Details</h3>

        ${
          (u.pages || []).length
            ? (u.pages || [])
                .map(
                  (p) => `
                    <div class="page-card">
                      <h4>${escapeHtml(p.pageName || 'Page')}</h4>

                      <p>${escapeHtml(p.purpose || '')}</p>

                      <div class="form-row">
                        <div>${miniList('Sections', p.sections)}</div>
                        <div>${miniList('Components', p.components)}</div>
                      </div>

                      <p class="muted"><b>Mobile:</b> ${escapeHtml(p.mobileNotes || '')}</p>
                      <p class="muted"><b>Desktop:</b> ${escapeHtml(p.desktopNotes || '')}</p>
                    </div>
                  `
                )
                .join('')
            : '<p class="muted">No pages returned.</p>'
        }
      </div>

      <div class="card span-4">
        ${miniList('User Flows', u.userFlows)}
        ${miniList('Wireframe Plan', u.wireframePlan)}
        ${miniList('Editable UI Notes', u.editableUiNotes)}
        ${miniList('Accessibility Checklist', u.accessibilityChecklist)}
      </div>
    </div>
  `;
}

function buildStitchPrompt(a) {
  const project = activeProject();
  const u = a.uiuxPlanning || {};
  const r = a.requirementSummary || {};
  const d = a.developmentPlan || {};

  const pages = (u.pages || [])
    .map((p, idx) => {
      return `${idx + 1}. ${p.pageName || 'Page'}
Purpose: ${p.purpose || ''}
Sections: ${(p.sections || []).join(', ')}
Components: ${(p.components || []).join(', ')}
Mobile notes: ${p.mobileNotes || ''}
Desktop notes: ${p.desktopNotes || ''}`;
    })
    .join('\n\n');

  return `Create a high-fidelity responsive web UI design for this software project.

Project name: ${project?.name || a.project?.name || 'Untitled Project'}
Client: ${project?.clientName || a.project?.clientName || 'Unknown'}
Project type: ${a.project?.projectType || 'Unknown'}
Business goal: ${a.project?.businessGoal || 'Unknown'}

Confirmed requirements:
${(r.confirmed || []).map((x) => `- ${x}`).join('\n')}

Design direction:
${u.designDirection || 'Clean, professional, modern SaaS interface.'}

Pages to design:
${pages || 'Create the main screens needed for the project.'}

User flows:
${(u.userFlows || []).map((x) => `- ${x}`).join('\n')}

Wireframe plan:
${(u.wireframePlan || []).map((x) => `- ${x}`).join('\n')}

Components to include:
${(u.pages || [])
  .flatMap((p) => p.components || [])
  .slice(0, 40)
  .map((x) => `- ${x}`)
  .join('\n')}

Frontend direction:
Framework: ${d.frontend?.framework || 'React / Next.js recommended'}
Libraries: ${(d.frontend?.libraries || []).join(', ')}

Important UI rules:
- Make it practical and development-ready, not just a concept.
- Use clear spacing, readable typography, strong visual hierarchy, and mobile-first responsive behavior.
- Include realistic empty states, loading states, form validation states, dashboard cards, tables/lists, and admin/customer flows where relevant.
- Do not invent extra business requirements. If a detail is unknown, keep the UI generic and editable.
- Generate a complete screen set that a developer can convert into frontend code.`;
}

function renderStitch(a) {
  const p = activeProject();
  const prompt = buildStitchPrompt(a);
  const stitch = p?.stitch || {};

  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Stitch UI Generator Link</h3>

        <p class="muted">
          Use this panel to send the AI UI/UX plan into Google Stitch.
          Manual mode always works. API mode requires <b>STITCH_API_KEY</b>
          and optional package <b>@google/stitch-sdk</b>.
        </p>

        <div class="actions">
          <button class="small-btn" data-action="copy-stitch-prompt">Copy Stitch Prompt</button>
          <button class="small-btn" data-action="open-stitch-web">Open Stitch Website</button>
          <button class="small-btn" data-action="run-stitch-generate">Generate with Stitch API</button>
        </div>
      </div>

      <div class="card span-7">
        <h3>Prompt to Paste in Stitch</h3>

        <textarea class="textarea code-textarea" id="stitchPromptInput" readonly>${escapeHtml(prompt)}</textarea>
      </div>

      <div class="card span-5">
        <h3>Generated UI Link / Preview</h3>

        ${
          stitch.htmlUrl
            ? `<p><a class="link-btn" href="${escapeHtml(stitch.htmlUrl)}" target="_blank" rel="noopener">Open Full Generated HTML UI →</a></p>`
            : `<p class="muted">No generated HTML link saved yet.</p>`
        }

        ${
          stitch.imageUrl
            ? `
              <p>
                <a class="link-btn" href="${escapeHtml(stitch.imageUrl)}" target="_blank" rel="noopener">
                  Open Screenshot Preview →
                </a>
              </p>

              <img class="preview-img" src="${escapeHtml(stitch.imageUrl)}" alt="Stitch generated UI preview" />
            `
            : ''
        }

        ${
          stitch.manualUrl
            ? `<p><a class="link-btn" href="${escapeHtml(stitch.manualUrl)}" target="_blank" rel="noopener">Open Saved Manual Stitch Link →</a></p>`
            : ''
        }

        <label class="muted">Paste Stitch share/project link manually</label>

        <input
          class="input"
          id="manualStitchUrl"
          placeholder="https://stitch.withgoogle.com/..."
          value="${escapeHtml(stitch.manualUrl || '')}"
        />

        <div class="actions">
          <button class="small-btn" data-action="save-stitch-url">Save Link</button>
        </div>

        <p class="muted">Command: <b>/stitch-url https://...</b></p>
      </div>

      <div class="card span-12">
        <h3>Stitch API Setup</h3>

        <pre class="code-block">STITCH_API_KEY=your_stitch_api_key_here
STITCH_BASE_URL=https://stitch.googleapis.com/mcp

Optional install for API mode:
npm install @google/stitch-sdk
node server.js</pre>
      </div>
    </div>
  `;
}

async function saveStitchUrl(url) {
  const clean = String(url || '').trim();

  if (!clean) {
    return addLog('Paste a Stitch URL first. Example: /stitch-url https://stitch.withgoogle.com/...', 'error');
  }

  if (!activeProject()) return addLog('Open a project first.', 'error');

  await updateActiveProject({
    stitch: {
      ...(activeProject().stitch || {}),
      manualUrl: clean,
      updatedAt: new Date().toISOString(),
    },
  });

  addLog('Stitch UI link saved to Firebase.', 'success');

  state.activeView = 'stitch';

  render();
}

async function runStitchGenerate() {
  const project = activeProject();
  const analysis = activeAnalysis();

  if (!project || !analysis) {
    return addLog('Run /analyze first, then open /stitch.', 'error');
  }

  const prompt = buildStitchPrompt(analysis);

  state.busy = true;
  render();

  addLog('Sending UI/UX prompt to Stitch API...', 'cyan');

  try {
    const res = await fetch('/api/stitch/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: project.name,
        prompt,
        deviceType: 'DESKTOP',
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Stitch generation failed.');
    }

    await updateActiveProject({
      stitch: data.result,
    });

    state.activeView = 'stitch';

    addLog('Stitch generated UI links saved to Firebase.', 'success');
  } catch (err) {
    addLog(err.message, 'error');
    addLog('Manual mode still works: copy prompt and open Stitch website.', 'warn');
  } finally {
    state.busy = false;
    render();
  }
}

function renderDev(a) {
  const d = a.developmentPlan || {};

  return `
    <div class="panel-grid">
      <div class="card span-4">
        <h3>Frontend</h3>

        <p><b>${escapeHtml(d.frontend?.framework || '')}</b></p>
        <p class="muted">${escapeHtml(d.frontend?.reason || '')}</p>

        ${miniList('Libraries', d.frontend?.libraries)}
      </div>

      <div class="card span-4">
        <h3>Backend</h3>

        <p><b>${escapeHtml(d.backend?.framework || '')}</b></p>
        <p class="muted">${escapeHtml(d.backend?.reason || '')}</p>

        ${miniList('Services', d.backend?.services)}
      </div>

      <div class="card span-4">
        <h3>Authentication</h3>

        <p><b>${escapeHtml(d.authentication?.method || '')}</b></p>

        ${miniList('Roles', d.authentication?.roles)}
        ${miniList('Rules', d.authentication?.rules)}
      </div>

      <div class="card span-6">
        <h3>Database</h3>

        <p><b>${escapeHtml(d.database?.name || '')}</b></p>
        <p class="muted">${escapeHtml(d.database?.reason || '')}</p>

        ${
          (d.database?.collectionsOrTables || [])
            .map(
              (c) => `
                <div class="question-card">
                  <b>${escapeHtml(c.name)}</b>
                  ${miniList('Fields', c.fields)}
                </div>
              `
            )
            .join('')
        }
      </div>

      <div class="card span-6">
        <h3>Modules</h3>

        ${
          (d.modules || [])
            .map(
              (m) => `
                <div class="question-card">
                  <b>${escapeHtml(m.name)}</b>
                  <p class="muted">${escapeHtml(m.description)}</p>

                  ${miniList('Files', m.mainFiles)}
                  ${miniList('Dependencies', m.dependencies)}
                </div>
              `
            )
            .join('')
        }
      </div>

      <div class="card span-12">
        <h3>API Routes</h3>

        ${
          (d.apiRoutes || [])
            .map(
              (r) => `
                <div class="task-card">
                  <span class="badge">${escapeHtml(r.method)}</span>
                  <b>${escapeHtml(r.path)}</b>

                  <p class="muted">${escapeHtml(r.purpose)}</p>
                </div>
              `
            )
            .join('')
        }
      </div>
    </div>
  `;
}

function renderInfra(a) {
  const i = a.infrastructurePlan || {};

  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Infrastructure Plan</h3>

        <p><b>Hosting:</b> ${escapeHtml(i.hosting || '')}</p>
      </div>

      ${listCard('Environment Variables', i.environmentVariables, 'span-6')}
      ${listCard('Security Checklist', i.securityChecklist, 'span-6')}
      ${listCard('Backup Plan', i.backupPlan, 'span-6')}
      ${listCard('Deployment Steps', i.deploymentSteps, 'span-6')}
    </div>
  `;
}

function renderFiles(a) {
  const f = a.fileStructure || {};
  const rootNode = parseTreeToHorizontalNodes(f.tree || '');

  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>AI Generated File Structure</h3>

        <p class="muted">
          Horizontal project structure view.
          Use this to understand frontend, backend, docs, tests, config, and deployment files clearly.
        </p>

        <div class="horizontal-file-shell">
          ${renderHorizontalFileMap(rootNode)}
        </div>

        <details class="raw-tree-box">
          <summary>Show raw terminal tree</summary>
          <pre class="code-block">${escapeHtml(f.tree || '')}</pre>
        </details>
      </div>

      ${listCard('Structure Notes', f.notes, 'span-12')}
    </div>
  `;
}

function parseTreeToHorizontalNodes(treeText) {
  const root = {
    name: 'project/',
    isDir: true,
    children: [],
  };

  const stack = [root];

  const lines = String(treeText || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '    '))
    .filter((line) => line.trim().length > 0);

  for (const line of lines) {
    const connectorIndex = line.search(/[├└]──/);

    let depth = 0;
    let name = '';

    if (connectorIndex >= 0) {
      depth = Math.floor(connectorIndex / 4) + 1;
      name = line.slice(connectorIndex).replace(/^[├└]──\s*/, '').trim();
    } else {
      depth = 0;
      name = line.trim();
    }

    name = name.replace(/[│├└─]/g, '').trim();

    if (!name) continue;

    const isDir = name.endsWith('/');

    if (depth === 0 && root.children.length === 0) {
      root.name = name;
      root.isDir = true;
      stack[0] = root;
      continue;
    }

    const node = {
      name,
      isDir,
      children: [],
    };

    const parent = stack[depth - 1] || root;

    parent.children.push(node);

    stack[depth] = node;
    stack.length = depth + 1;
  }

  return root;
}

function renderHorizontalFileMap(rootNode) {
  const children = rootNode.children || [];

  if (!children.length) {
    return `
      <div class="empty-horizontal-files">
        No file structure generated yet. Run <b>/analyze</b> first.
      </div>
    `;
  }

  return `
    <div class="file-root-line">
      <div class="file-root-badge">
        <span class="file-root-icon">▣</span>
        <span>${escapeHtml(rootNode.name)}</span>
      </div>

      <span class="file-root-arrow">→</span>
      <span class="muted">${children.length} main items</span>
    </div>

    <div class="file-horizontal-rail">
      ${children.map((node) => renderFileGroupCard(node)).join('')}
    </div>
  `;
}

function renderFileGroupCard(node) {
  const children = node.children || [];
  const folders = children.filter((child) => child.isDir);
  const files = children.filter((child) => !child.isDir);

  return `
    <div class="file-group-card">
      <div class="file-group-head">
        <span class="file-main-icon">${node.isDir ? '▣' : '□'}</span>

        <div>
          <div class="file-main-title">${escapeHtml(node.name)}</div>

          <div class="file-main-meta">
            ${folders.length} folders · ${files.length} files
          </div>
        </div>
      </div>

      ${renderFileChips('Folders', folders, 'folder')}
      ${renderFileChips('Files', files, 'file')}

      ${!folders.length && !files.length ? `<div class="file-empty-note">No child files</div>` : ''}
    </div>
  `;
}

function renderFileChips(title, items, type) {
  if (!items || !items.length) return '';

  return `
    <div class="file-chip-section">
      <div class="file-chip-title">${escapeHtml(title)}</div>

      <div class="file-chip-wrap">
        ${items
          .slice(0, 12)
          .map(
            (item) => `
              <span class="file-chip ${type}">
                <span>${type === 'folder' ? '▣' : '□'}</span>
                ${escapeHtml(item.name)}
              </span>
            `
          )
          .join('')}

        ${items.length > 12 ? `<span class="file-chip more">+${items.length - 12} more</span>` : ''}
      </div>
    </div>
  `;
}

function renderTasks(a) {
  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Task Path / Development Flow</h3>

        <p class="muted">
          This is the path you follow from client discovery to handover.
        </p>
      </div>

      <div class="card span-12">
        ${
          (a.taskPath || [])
            .map(
              (t, idx) => `
                <div class="task-card">
                  <div class="task-head">
                    <span class="phase-title">${idx + 1}. ${escapeHtml(t.phase || 'Phase')}</span>

                    <span class="badge ${
                      t.status === 'Blocked'
                        ? 'error'
                        : t.status === 'Completed'
                          ? ''
                          : 'warn'
                    }">
                      ${escapeHtml(t.status || 'Ready')}
                    </span>
                  </div>

                  <p>${escapeHtml(t.goal || '')}</p>

                  ${miniList('Tasks', t.tasks)}

                  <p class="muted"><b>Dependency:</b> ${escapeHtml(t.dependency || '')}</p>
                  <p class="muted"><b>Done:</b> ${escapeHtml(t.definitionOfDone || '')}</p>
                </div>
              `
            )
            .join('')
        }
      </div>
    </div>
  `;
}

function renderQa(a) {
  const q = a.qaPlan || {};

  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>QA Plan</h3>
      </div>

      <div class="card span-8">
        <h3>Test Cases</h3>

        ${
          (q.testCases || [])
            .map(
              (t) => `
                <div class="task-card">
                  <span class="badge warn">${escapeHtml(t.priority || 'Medium')}</span>
                  <b>${escapeHtml(t.area)}</b>

                  <p>${escapeHtml(t.test)}</p>
                  <p class="muted">Expected: ${escapeHtml(t.expectedResult)}</p>
                </div>
              `
            )
            .join('')
        }
      </div>

      <div class="card span-4">
        ${miniList('Responsive Tests', q.responsiveTests)}
        ${miniList('Security Tests', q.securityTests)}
        ${miniList('Handover Checks', q.handoverChecks)}
      </div>
    </div>
  `;
}

function renderReport(a) {
  const r = a.clientReport || {};

  return `
    <div class="panel-grid">
      <div class="card span-12">
        <h3>Client Report</h3>

        <p>${escapeHtml(r.overview || '')}</p>
      </div>

      ${listCard('Confirmed Scope', r.confirmedScope, 'span-6')}
      ${listCard('Pending Client Inputs', r.pendingClientInputs, 'span-6')}
      ${listCard('Risks / Blockers', r.risksOrBlockers, 'span-6')}
      ${listCard('Next Steps', r.nextSteps, 'span-6')}

      <div class="card span-12">
        <h3>Simple Client Message</h3>

        <p>${escapeHtml(r.simpleClientMessage || '')}</p>
      </div>
    </div>
  `;
}

function listCard(title, items = [], span = 'span-6') {
  return `
    <div class="card ${span}">
      <h3>${escapeHtml(title)}</h3>
      ${miniList(null, items)}
    </div>
  `;
}

function miniList(title, items = []) {
  const arr = Array.isArray(items) ? items : [];

  return `
    ${title ? `<h4>${escapeHtml(title)}</h4>` : ''}

    <ul class="list">
      ${
        arr.length
          ? arr
              .map((i) => `<li>${escapeHtml(typeof i === 'string' ? i : JSON.stringify(i))}</li>`)
              .join('')
          : '<li class="muted">No items</li>'
      }
    </ul>
  `;
}

function renderModal() {
  if (state.modal !== 'newProject') return '';

  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" onclick="event.stopPropagation()">
        <h2>New Project</h2>

        <p class="muted">Create a new Firebase project, like ChatGPT New Chat.</p>

        <div class="form-row">
          <div>
            <label class="muted">Project name</label>
            <input class="input" id="modalProjectName" placeholder="Example: ABC Hotel Booking App" />
          </div>

          <div>
            <label class="muted">Client name</label>
            <input class="input" id="modalClientName" placeholder="Example: ABC Hotels" />
          </div>
        </div>

        <label class="muted">Initial client idea</label>

        <textarea
          class="textarea"
          id="modalClientIdea"
          placeholder="Paste first client idea here..."
        ></textarea>

        <div class="actions">
          <button class="small-btn" data-action="create-project">Create Project</button>
          <button class="ghost-btn" data-action="close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function bindEvents() {
  const form = $('#commandForm');

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const input = $('#commandInput');
      const value = input.value;

      input.value = '';

      await handleCommand(value);
    });
  }

  document.querySelectorAll('[data-project-id]').forEach((el) => {
    el.addEventListener('click', () => {
      selectProject(el.getAttribute('data-project-id'));
    });
  });

  document.querySelectorAll('[data-view-target]').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeView = el.getAttribute('data-view-target') || 'home';
      render();
    });
  });

  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', async () => {
      const action = el.getAttribute('data-action');

      if (action === 'open-new') {
        state.modal = 'newProject';
        render();
      }

      if (action === 'close-modal') {
        state.modal = null;
        render();
      }

      if (action === 'show-projects') {
        state.activeView = 'projects';
        render();
      }

      if (action === 'view-intake') {
        state.activeView = 'intake';
        render();
      }

      if (action === 'run-analyze') {
        await runAnalyze();
      }

      if (action === 'view-stitch') {
        state.activeView = 'stitch';
        render();
      }

      if (action === 'open-stitch-web') {
        window.open('https://stitch.withgoogle.com/', '_blank', 'noopener');
      }

      if (action === 'copy-stitch-prompt') {
        await copyStitchPrompt();
      }

      if (action === 'run-stitch-generate') {
        await runStitchGenerate();
      }

      if (action === 'save-stitch-url') {
        await saveStitchUrl($('#manualStitchUrl')?.value || '');
      }

      if (action === 'save-intake') {
        await saveIntakeFromForm();
      }

      if (action === 'save-answers') {
        await saveAnswersFromForm();
      }

      if (action === 'create-project') {
        await createProject({
          name: $('#modalProjectName')?.value,
          clientName: $('#modalClientName')?.value,
          clientIdea: $('#modalClientIdea')?.value,
        });
      }
    });
  });
}

async function copyStitchPrompt() {
  const prompt =
    $('#stitchPromptInput')?.value ||
    (activeAnalysis() ? buildStitchPrompt(activeAnalysis()) : '');

  if (!prompt) {
    return addLog('No Stitch prompt available. Run /analyze first.', 'error');
  }

  try {
    await navigator.clipboard.writeText(prompt);
    addLog('Stitch prompt copied. Open Stitch and paste it.', 'success');
  } catch (_) {
    addLog('Could not copy automatically. Select the prompt text and copy manually.', 'warn');
  }
}

async function saveIntakeFromForm() {
  const name = $('#projectNameInput')?.value || activeProject()?.name;
  const clientName = $('#clientNameInput')?.value || '';
  const clientIdea = $('#clientIdeaInput')?.value || '';
  const transcript = $('#transcriptInput')?.value || '';

  await updateActiveProject({
    name,
    slug: slugify(name),
    clientName,
    clientIdea,
    transcript,
  });

  addLog('Intake saved to Firebase.', 'success');
}

async function saveAnswersFromForm() {
  const answers = {
    ...(activeProject()?.answers || {}),
  };

  document.querySelectorAll('.answer-input').forEach((input) => {
    answers[input.getAttribute('data-answer-key')] = input.value;
  });

  await updateActiveProject({
    answers,
  });

  addLog('Question answers saved to Firebase.', 'success');
}

init();