import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runInventorySync } from './inventorySync.js';

const COOKIE_NAME = 'mebelcenter_ops_auth';
const SUPPLIERS = {
  megapap: {
    key: 'megapap',
    name: 'Megapap',
    vendor: 'Mebelcenter',
    tone: 'emerald',
  },
  b2bmarkt: {
    key: 'b2bmarkt',
    name: 'B2BMarkt',
    vendor: 'Europe',
    tone: 'blue',
  },
};

let currentRun = null;
let lastCompletedRun = null;

function getDashboardPassword() {
  return process.env.DASHBOARD_PASSWORD || '';
}

function getCookieValue() {
  return crypto
    .createHash('sha256')
    .update(getDashboardPassword() || 'missing-password')
    .digest('hex');
}

function isVercelRuntime() {
  return Boolean(process.env.VERCEL);
}

export function getRuntimeLogDir() {
  const configured = process.env.LOG_DIR || './logs';
  if (isVercelRuntime() && !path.isAbsolute(configured)) {
    return path.join('/tmp', 'mebelcenter-logs');
  }
  return configured;
}

function sendHtml(res, statusCode, html, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return idx === -1
          ? [part, '']
          : [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
      }),
  );
}

function getCookieOptions(req, maxAge) {
  const proto = req.headers['x-forwarded-proto'] || '';
  const secure = proto === 'https' || isVercelRuntime();
  const maxAgePart = maxAge == null ? '' : `; Max-Age=${maxAge}`;
  return `HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}${maxAgePart}`;
}

function isAuthenticated(req) {
  if (!getDashboardPassword()) return false;
  return parseCookies(req)[COOKIE_NAME] === getCookieValue();
}

function requireAuth(req, res) {
  if (!getDashboardPassword()) {
    sendJson(res, 500, { error: 'DASHBOARD_PASSWORD is not configured.' });
    return false;
  }
  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function readRequestBody(req) {
  if (req.body != null) {
    if (typeof req.body === 'string') return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
    if (typeof req.body === 'object') return JSON.stringify(req.body);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeSummary(summary, logs = []) {
  if (!summary?.counts) return null;
  return {
    supplierKey: summary.supplier,
    supplier: SUPPLIERS[summary.supplier]?.name || summary.supplier,
    vendor: summary.vendor,
    mode: summary.dryRun ? 'dry-run' : 'apply',
    dryRun: summary.dryRun,
    updated: summary.counts.updated,
    errors: summary.counts.errors,
    skipped: summary.counts.skipped.total,
    planned: summary.counts.planned,
    elapsed: summary.elapsedSeconds,
    elapsedSeconds: summary.elapsedSeconds,
    finishedAt: summary.finishedAt,
    logFiles: summary.logFiles || null,
    logs,
  };
}

async function listRecentRuns(limit = 8) {
  const logDir = getRuntimeLogDir();
  let entries;
  try {
    entries = await fs.readdir(logDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .filter((entry) => entry.name.startsWith('megapap-') || entry.name.startsWith('b2bmarkt-'))
    .map((entry) => path.join(logDir, entry.name));

  const runs = [];
  for (const file of jsonFiles) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!parsed?.supplier || !parsed?.counts) continue;
      runs.push({
        supplierKey: parsed.supplier,
        supplier: SUPPLIERS[parsed.supplier]?.name || parsed.supplier,
        vendor: parsed.vendor,
        mode: parsed.dryRun ? 'dry-run' : 'apply',
        updated: parsed.counts.updated,
        errors: parsed.counts.errors,
        skipped: parsed.counts.skipped.total,
        planned: parsed.counts.planned,
        elapsed: parsed.elapsedSeconds,
        finishedAt: parsed.finishedAt || parsed.date,
        logFile: file,
      });
    } catch {
      // Ignore partial or unrelated JSON files.
    }
  }

  return runs
    .sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime())
    .slice(0, limit);
}

function renderLoginPage(message = '') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mebelcenter Operations Login</title>
    <style>${renderStyles()}</style>
  </head>
  <body class="login-body">
    <main class="login-shell">
      <section class="login-panel">
        <div class="brand-mark">MC</div>
        <p class="eyebrow">Private Operations</p>
        <h1>Mebelcenter Operations</h1>
        <p class="login-copy">Private control panel for Shopify supplier operations.</p>
        <form class="login-form" method="post" action="/api/login">
          <label for="password">Dashboard password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
          <button type="submit">Sign in</button>
          <div class="form-message">${escapeHtml(message)}</div>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

function renderDashboardPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mebelcenter Operations</title>
    <style>${renderStyles()}</style>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <div class="brand-mark">MC</div>
          <div>
            <strong>Mebelcenter</strong>
            <span>Operations</span>
          </div>
        </div>
        <nav class="nav-list" aria-label="Operations navigation">
          <a class="nav-item active" href="/dashboard">Inventory Sync</a>
          <span class="nav-item disabled">Price Sync</span>
          <span class="nav-item disabled">Missing Products</span>
          <span class="nav-item disabled">Translation Tools</span>
          <span class="nav-item disabled">Product Cleanup</span>
          <span class="nav-item disabled">Logs</span>
          <span class="nav-item disabled">Settings</span>
        </nav>
      </aside>

      <main class="main">
        <header class="topbar">
          <div>
            <p class="eyebrow">Private Control Panel</p>
            <h1>Mebelcenter Operations</h1>
            <p class="subtitle">Private control panel for Shopify supplier operations</p>
          </div>
          <form method="post" action="/api/logout">
            <button class="ghost-button" type="submit">Logout</button>
          </form>
        </header>

        <section class="supplier-grid" aria-label="Inventory suppliers">
          ${renderSupplierCard(SUPPLIERS.megapap)}
          ${renderSupplierCard(SUPPLIERS.b2bmarkt)}
        </section>

        <section class="workspace-grid">
          <article class="panel output-panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">Run Output</p>
                <h2>Current Result</h2>
              </div>
              <span id="status-badge" class="status-badge idle">Idle</span>
            </div>

            <div class="metrics-grid">
              <div class="metric"><span>Updated</span><strong id="metric-updated">0</strong></div>
              <div class="metric"><span>Errors</span><strong id="metric-errors">0</strong></div>
              <div class="metric"><span>Skipped</span><strong id="metric-skipped">0</strong></div>
              <div class="metric"><span>Planned</span><strong id="metric-planned">0</strong></div>
              <div class="metric"><span>Elapsed</span><strong id="metric-elapsed">-</strong></div>
              <div class="metric"><span>Supplier</span><strong id="metric-supplier">-</strong></div>
              <div class="metric"><span>Mode</span><strong id="metric-mode">-</strong></div>
              <div class="metric"><span>Finished</span><strong id="metric-finished">-</strong></div>
            </div>
          </article>

          <article class="panel logs-panel">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">Logs</p>
                <h2>Run Log</h2>
              </div>
              <button id="copy-log" class="ghost-button small" type="button">Copy log</button>
            </div>
            <pre id="logs">No run selected.</pre>
          </article>
        </section>

        <section class="panel recent-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Recent Runs</p>
              <h2>Inventory History</h2>
            </div>
            <button id="refresh-runs" class="ghost-button small" type="button">Refresh</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Mode</th>
                  <th>Updated</th>
                  <th>Errors</th>
                  <th>Skipped</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody id="recent-runs">
                <tr><td colspan="6">Loading recent runs...</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>

    <script>${renderClientScript()}</script>
  </body>
</html>`;
}

function renderSupplierCard(supplier) {
  return `<article class="supplier-card ${supplier.tone}" data-card="${supplier.key}">
    <div class="card-top">
      <div>
        <span class="supplier-kicker">${supplier.vendor}</span>
        <h2>${supplier.name}</h2>
      </div>
      <span class="health-dot">Ready</span>
    </div>
    <div class="supplier-meta">
      <span>Manual only</span>
      <span>Inventory stock</span>
    </div>
    <div class="last-result" id="last-${supplier.key}">Last result: waiting for run data</div>
    <div class="button-row">
      <button class="run-button safe" type="button" data-supplier="${supplier.key}" data-dry-run="true">Dry Run</button>
      <button class="run-button danger" type="button" data-supplier="${supplier.key}" data-dry-run="false">Apply Sync</button>
    </div>
  </article>`;
}

function renderStyles() {
  return `
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --surface: #ffffff;
      --surface-2: #f8fafc;
      --text: #111827;
      --muted: #667085;
      --border: #d9e1ea;
      --line: #e8edf3;
      --nav: #17202b;
      --nav-2: #202b38;
      --accent: #0f766e;
      --accent-2: #2563eb;
      --danger: #c2410c;
      --danger-2: #991b1b;
      --success-bg: #ecfdf3;
      --success-text: #047857;
      --warning-bg: #fff7ed;
      --warning-text: #c2410c;
      --shadow: 0 18px 40px rgba(15, 23, 42, 0.08);
      --radius: 8px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    button, input {
      font: inherit;
    }
    button {
      transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
    }
    button:not([disabled]):hover {
      transform: translateY(-1px);
    }
    button[disabled] {
      cursor: not-allowed;
      opacity: 0.55;
      transform: none;
    }
    .login-body {
      display: grid;
      place-items: center;
      background:
        linear-gradient(135deg, rgba(23,32,43,0.98), rgba(32,43,56,0.94)),
        radial-gradient(circle at 20% 20%, rgba(15,118,110,0.24), transparent 34%);
    }
    .login-shell {
      width: min(440px, calc(100vw - 32px));
    }
    .login-panel {
      background: rgba(255,255,255,0.96);
      border: 1px solid rgba(255,255,255,0.4);
      border-radius: var(--radius);
      padding: 32px;
      box-shadow: 0 24px 70px rgba(0,0,0,0.24);
    }
    .brand-mark {
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      border-radius: 8px;
      background: linear-gradient(135deg, #0f766e, #2563eb);
      color: #fff;
      font-weight: 800;
      letter-spacing: 0.04em;
    }
    .eyebrow {
      margin: 0 0 6px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .login-panel h1 {
      margin: 14px 0 8px;
      font-size: 30px;
      line-height: 1.1;
    }
    .login-copy {
      margin: 0 0 24px;
      color: var(--muted);
      line-height: 1.5;
    }
    .login-form label {
      display: block;
      margin-bottom: 8px;
      color: #344054;
      font-size: 14px;
      font-weight: 700;
    }
    .login-form input {
      width: 100%;
      min-height: 46px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0 14px;
      background: #fff;
      color: var(--text);
    }
    .login-form button {
      width: 100%;
      min-height: 46px;
      margin-top: 14px;
      border: none;
      border-radius: var(--radius);
      background: #17202b;
      color: #fff;
      cursor: pointer;
      font-weight: 700;
    }
    .form-message {
      min-height: 22px;
      margin-top: 12px;
      color: var(--danger-2);
      font-size: 14px;
    }
    .app-shell {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 22px 16px;
      background: linear-gradient(180deg, var(--nav), var(--nav-2));
      color: #fff;
    }
    .sidebar-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 6px 22px;
      border-bottom: 1px solid rgba(255,255,255,0.12);
    }
    .sidebar-brand strong, .sidebar-brand span {
      display: block;
    }
    .sidebar-brand span {
      margin-top: 2px;
      color: #aab5c3;
      font-size: 13px;
    }
    .nav-list {
      display: grid;
      gap: 6px;
      margin-top: 18px;
    }
    .nav-item {
      display: block;
      padding: 11px 12px;
      border-radius: var(--radius);
      color: #cbd5e1;
      text-decoration: none;
      font-size: 14px;
      font-weight: 650;
    }
    .nav-item.active {
      background: rgba(255,255,255,0.12);
      color: #fff;
    }
    .nav-item.disabled {
      color: #7f8da0;
    }
    .main {
      min-width: 0;
      padding: 28px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      margin-bottom: 22px;
    }
    .topbar h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.05;
    }
    .subtitle {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 16px;
    }
    .ghost-button {
      min-height: 38px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0 14px;
      background: #fff;
      color: #344054;
      cursor: pointer;
      font-weight: 700;
    }
    .ghost-button.small {
      min-height: 34px;
      font-size: 13px;
    }
    .supplier-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }
    .supplier-card, .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .supplier-card {
      padding: 18px;
      border-top: 4px solid var(--accent);
    }
    .supplier-card.blue {
      border-top-color: var(--accent-2);
    }
    .card-top, .panel-heading {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .supplier-kicker {
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .supplier-card h2, .panel h2 {
      margin: 4px 0 0;
      font-size: 22px;
      line-height: 1.15;
    }
    .health-dot, .status-badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      border-radius: 999px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .health-dot, .status-badge.success {
      background: var(--success-bg);
      color: var(--success-text);
    }
    .status-badge.idle {
      background: #eef2f7;
      color: #475467;
    }
    .status-badge.running {
      background: #eff6ff;
      color: #1d4ed8;
    }
    .status-badge.error {
      background: #fef2f2;
      color: var(--danger-2);
    }
    .supplier-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 16px 0;
    }
    .supplier-meta span {
      border-radius: 999px;
      background: var(--surface-2);
      border: 1px solid var(--line);
      padding: 6px 9px;
      color: #475467;
      font-size: 12px;
      font-weight: 700;
    }
    .last-result {
      min-height: 42px;
      margin-bottom: 16px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.45;
    }
    .button-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .run-button {
      min-height: 42px;
      border: none;
      border-radius: var(--radius);
      color: #fff;
      cursor: pointer;
      font-weight: 800;
    }
    .run-button.safe {
      background: #0f766e;
    }
    .run-button.danger {
      background: #b42318;
      box-shadow: 0 10px 24px rgba(180,35,24,0.18);
    }
    .workspace-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      gap: 16px;
      margin-bottom: 16px;
    }
    .panel {
      padding: 18px;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 16px;
    }
    .metric {
      min-width: 0;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-2);
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .metric strong {
      display: block;
      min-width: 0;
      margin-top: 7px;
      overflow: hidden;
      color: var(--text);
      font-size: 22px;
      line-height: 1.1;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .logs-panel pre {
      min-height: 310px;
      max-height: 430px;
      margin: 16px 0 0;
      overflow: auto;
      border-radius: var(--radius);
      border: 1px solid #111827;
      padding: 14px;
      background: #0d1117;
      color: #d1e7dd;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .table-wrap {
      margin-top: 14px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: var(--radius);
    }
    table {
      width: 100%;
      min-width: 720px;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      white-space: nowrap;
    }
    th {
      background: var(--surface-2);
      color: #475467;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    tr:last-child td {
      border-bottom: none;
    }
    .mode-pill {
      display: inline-flex;
      border-radius: 999px;
      padding: 4px 8px;
      background: #eef2f7;
      color: #475467;
      font-size: 12px;
      font-weight: 800;
    }
    .mode-pill.apply {
      background: var(--warning-bg);
      color: var(--warning-text);
    }
    @media (max-width: 1100px) {
      .app-shell {
        grid-template-columns: 1fr;
      }
      .sidebar {
        position: static;
        height: auto;
      }
      .nav-list {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .workspace-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 740px) {
      .main {
        padding: 18px 14px 28px;
      }
      .topbar {
        display: grid;
      }
      .supplier-grid {
        grid-template-columns: 1fr;
      }
      .metrics-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .button-row {
        grid-template-columns: 1fr;
      }
      .nav-list {
        grid-template-columns: 1fr;
      }
    }
  `;
}

function renderClientScript() {
  return `
    const statusBadge = document.getElementById('status-badge');
    const logsEl = document.getElementById('logs');
    const copyLogButton = document.getElementById('copy-log');
    const runButtons = Array.from(document.querySelectorAll('.run-button'));
    const recentRunsEl = document.getElementById('recent-runs');
    const refreshRunsButton = document.getElementById('refresh-runs');
    const metrics = {
      updated: document.getElementById('metric-updated'),
      errors: document.getElementById('metric-errors'),
      skipped: document.getElementById('metric-skipped'),
      planned: document.getElementById('metric-planned'),
      elapsed: document.getElementById('metric-elapsed'),
      supplier: document.getElementById('metric-supplier'),
      mode: document.getElementById('metric-mode'),
      finished: document.getElementById('metric-finished'),
    };

    let localRunning = false;

    function formatDate(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString();
    }

    function setStatus(label, state) {
      statusBadge.textContent = label;
      statusBadge.className = 'status-badge ' + state;
    }

    function setButtonsDisabled(disabled) {
      for (const button of runButtons) button.disabled = disabled;
    }

    function setSummary(summary) {
      metrics.updated.textContent = String(summary?.updated ?? 0);
      metrics.errors.textContent = String(summary?.errors ?? 0);
      metrics.skipped.textContent = String(summary?.skipped ?? 0);
      metrics.planned.textContent = String(summary?.planned ?? 0);
      metrics.elapsed.textContent = summary ? summary.elapsed + 's' : '-';
      metrics.supplier.textContent = summary?.supplier || '-';
      metrics.mode.textContent = summary ? (summary.dryRun ? 'Dry Run' : 'Apply') : '-';
      metrics.finished.textContent = summary ? formatDate(summary.finishedAt) : '-';
    }

    function setLogs(lines) {
      logsEl.textContent = Array.isArray(lines) && lines.length ? lines.join('\\n') : 'No logs captured.';
      logsEl.scrollTop = logsEl.scrollHeight;
    }

    function updateSupplierLastResult(summary) {
      if (!summary?.supplierKey) return;
      const el = document.getElementById('last-' + summary.supplierKey);
      if (!el) return;
      el.textContent =
        'Last ' + (summary.dryRun ? 'dry run' : 'apply') +
        ': planned ' + summary.planned +
        ', updated ' + summary.updated +
        ', errors ' + summary.errors +
        ', skipped ' + summary.skipped + '.';
    }

    function renderRecentRuns(runs) {
      if (!Array.isArray(runs) || runs.length === 0) {
        recentRunsEl.innerHTML = '<tr><td colspan="6">No recent inventory runs found.</td></tr>';
        return;
      }
      recentRunsEl.innerHTML = runs.map((run) => {
        const modeLabel = run.mode === 'apply' ? 'Apply' : 'Dry Run';
        const modeClass = run.mode === 'apply' ? 'mode-pill apply' : 'mode-pill';
        return '<tr>' +
          '<td>' + run.supplier + '</td>' +
          '<td><span class="' + modeClass + '">' + modeLabel + '</span></td>' +
          '<td>' + run.updated + '</td>' +
          '<td>' + run.errors + '</td>' +
          '<td>' + run.skipped + '</td>' +
          '<td>' + formatDate(run.finishedAt) + '</td>' +
        '</tr>';
      }).join('');
    }

    function updateCardsFromRecentRuns(runs) {
      const seen = new Set();
      for (const run of runs || []) {
        if (seen.has(run.supplierKey)) continue;
        seen.add(run.supplierKey);
        updateSupplierLastResult({
          supplierKey: run.supplierKey,
          dryRun: run.mode !== 'apply',
          planned: run.planned,
          updated: run.updated,
          errors: run.errors,
          skipped: run.skipped,
        });
      }
    }

    async function loadRecentRuns() {
      const res = await fetch('/api/runs', { credentials: 'same-origin' });
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      const data = await res.json();
      renderRecentRuns(data.runs || []);
      updateCardsFromRecentRuns(data.runs || []);
    }

    async function refreshStatus() {
      try {
        const res = await fetch('/api/status', { credentials: 'same-origin' });
        if (res.status === 401) {
          window.location.href = '/';
          return false;
        }
        const data = await res.json();
        const running = Boolean(data.running);
        if (!localRunning) setButtonsDisabled(running);
        if (running && data.run) {
          setStatus('Running ' + data.run.supplierKey, 'running');
          setLogs(data.run.logs || []);
          if (data.run.summary) setSummary(data.run.summary);
        } else if (!localRunning) {
          setStatus('Idle', 'idle');
        }
        return running;
      } catch (error) {
        setStatus('Status error', 'error');
        return false;
      }
    }

    async function runSync(supplierKey, dryRun) {
      if (localRunning) return;
      if (!dryRun) {
        const confirmed = window.confirm(
          'This will update Shopify inventory for ' + supplierKey + '. Did you run a dry run first?'
        );
        if (!confirmed) return;
      }

      localRunning = true;
      setButtonsDisabled(true);
      setStatus('Running ' + supplierKey, 'running');
      setSummary(null);
      setLogs(['Starting ' + supplierKey + ' ' + (dryRun ? 'dry run' : 'apply sync') + '...']);

      try {
        const res = await fetch('/api/sync', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supplierKey, dryRun }),
        });
        const data = await res.json();
        if (!res.ok) {
          setStatus('Run failed', 'error');
          if (data.logs) setLogs(data.logs);
          if (data.summary) setSummary(data.summary);
          return;
        }
        setStatus(data.summary.errors > 0 ? 'Completed with errors' : 'Completed', data.summary.errors > 0 ? 'error' : 'success');
        setSummary(data.summary);
        setLogs(data.logs);
        updateSupplierLastResult(data.summary);
        await loadRecentRuns();
      } catch (error) {
        setStatus('Request failed', 'error');
        setLogs(['Request failed: ' + error.message]);
      } finally {
        localRunning = false;
        const stillRunning = await refreshStatus();
        setButtonsDisabled(Boolean(stillRunning));
      }
    }

    for (const button of runButtons) {
      button.addEventListener('click', () => {
        runSync(button.dataset.supplier, button.dataset.dryRun === 'true');
      });
    }
    copyLogButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(logsEl.textContent || '');
      copyLogButton.textContent = 'Copied';
      setTimeout(() => { copyLogButton.textContent = 'Copy log'; }, 1200);
    });
    refreshRunsButton.addEventListener('click', loadRecentRuns);

    setSummary(null);
    refreshStatus();
    loadRecentRuns();
    setInterval(refreshStatus, 2500);
  `;
}

async function handleLogin(req, res) {
  if (!getDashboardPassword()) {
    sendHtml(res, 500, renderLoginPage('DASHBOARD_PASSWORD is not configured.'));
    return;
  }

  const body = await readRequestBody(req);
  const params = new URLSearchParams(body);
  const password = params.get('password') || '';

  if (password !== getDashboardPassword()) {
    sendHtml(res, 401, renderLoginPage('Invalid password.'));
    return;
  }

  redirect(res, '/dashboard', {
    'Set-Cookie': `${COOKIE_NAME}=${getCookieValue()}; ${getCookieOptions(req)}`,
  });
}

function handleLogout(req, res) {
  redirect(res, '/', {
    'Set-Cookie': `${COOKIE_NAME}=; ${getCookieOptions(req, 0)}`,
  });
}

async function handleSync(req, res) {
  if (!requireAuth(req, res)) return;
  if (currentRun?.running) {
    sendJson(res, 409, {
      error: 'A sync is already running.',
      run: {
        supplierKey: currentRun.supplierKey,
        dryRun: currentRun.dryRun,
        logs: currentRun.logs,
        summary: currentRun.summary,
      },
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readRequestBody(req));
  } catch {
    sendJson(res, 400, { error: 'Request body must be valid JSON.' });
    return;
  }

  const supplierKey = payload?.supplierKey;
  const dryRun = payload?.dryRun === true;
  if (!Object.hasOwn(SUPPLIERS, supplierKey)) {
    sendJson(res, 400, { error: 'supplierKey must be "megapap" or "b2bmarkt".' });
    return;
  }

  currentRun = {
    running: true,
    supplierKey,
    dryRun,
    logs: [],
    summary: null,
  };

  const previousLogDir = process.env.LOG_DIR;
  process.env.LOG_DIR = getRuntimeLogDir();

  try {
    const result = await runInventorySync({
      supplierKey,
      dryRun,
      onLog(line) {
        currentRun.logs.push(line);
      },
    });

    const supplierResult = result.results[0];
    if (supplierResult?.error) {
      sendJson(res, 500, {
        error: supplierResult.error,
        supplierKey,
        mode: dryRun ? 'dry-run' : 'apply',
        logs: currentRun.logs,
        summary: null,
      });
      return;
    }

    const summary = normalizeSummary(supplierResult, currentRun.logs);
    currentRun.summary = summary;
    lastCompletedRun = {
      ...currentRun,
      running: false,
      summary,
    };

    sendJson(res, 200, {
      ok: true,
      supplierKey,
      mode: dryRun ? 'dry-run' : 'apply',
      updated: summary.updated,
      errors: summary.errors,
      skipped: summary.skipped,
      planned: summary.planned,
      elapsed: summary.elapsed,
      logs: currentRun.logs,
      logFiles: summary.logFiles,
      summary,
    });
  } catch (error) {
    currentRun.logs.push(`[dashboard] FATAL: ${error.message}`);
    sendJson(res, 500, {
      error: error.message,
      supplierKey,
      mode: dryRun ? 'dry-run' : 'apply',
      logs: currentRun.logs,
      summary: currentRun.summary,
    });
  } finally {
    if (previousLogDir == null) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = previousLogDir;
    if (currentRun) currentRun.running = false;
  }
}

function handleStatus(req, res) {
  if (!requireAuth(req, res)) return;
  const source = currentRun || lastCompletedRun;
  sendJson(res, 200, {
    running: Boolean(currentRun?.running),
    run: source
      ? {
          supplierKey: source.supplierKey,
          dryRun: source.dryRun,
          logs: source.logs,
          summary: source.summary,
        }
      : null,
  });
}

async function handleRuns(req, res) {
  if (!requireAuth(req, res)) return;
  sendJson(res, 200, {
    runs: await listRecentRuns(),
    volatile: isVercelRuntime(),
    logDir: getRuntimeLogDir(),
  });
}

export async function handleDashboardRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/') {
    if (isAuthenticated(req)) {
      redirect(res, '/dashboard');
      return;
    }
    sendHtml(res, 200, renderLoginPage(), { 'Cache-Control': 'no-store' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/dashboard') {
    if (!getDashboardPassword()) {
      sendHtml(res, 500, renderLoginPage('DASHBOARD_PASSWORD is not configured.'));
      return;
    }
    if (!isAuthenticated(req)) {
      redirect(res, '/');
      return;
    }
    sendHtml(res, 200, renderDashboardPage(), { 'Cache-Control': 'no-store' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    await handleLogin(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    handleLogout(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    handleStatus(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/runs') {
    await handleRuns(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sync') {
    await handleSync(req, res);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}
