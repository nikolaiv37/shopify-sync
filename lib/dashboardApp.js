import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runInventorySync } from './inventorySync.js';
import { runB2BCenterSync } from './b2bcenterSync.js';

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

// B2BCenter (Supabase) dry-run-only module. Separate from the Shopify SUPPLIERS.
const B2BCENTER_SUPPLIERS = {
  megapap: {
    key: 'megapap',
    name: 'Megapap',
    manufacturer: 'Mebelcenter',
  },
  b2bmarkt: {
    key: 'b2bmarkt',
    name: 'B2BMarkt',
    manufacturer: 'Europe',
  },
};

// Official Mebelcenter wordmark (flame icon + "MEBELCENTER"), pulled from the
// live storefront logo asset. Rendered inline so the panel stays self-contained.
const BRAND_LOGO_SVG = `<svg class="brand-logo" viewBox="0 0 170 52" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mebelcenter">
  <style>.mc-logo-fill{fill:#BA0009;}</style>
  <g>
    <g transform="matrix(0.7203340843886565,0,0,0.7203340843886565,182.70465672364983,49.98460041129305)">
      <path class="mc-logo-fill" d="M-115.5-42.1c-3.4-5.1-7.6-2.3-13.2-1c-5.6,1.3-4.2-7.4,0.8-15.1c5-7.7,0.1-10.6-3.7-8c-2.5,1.7-15,7.3-17.2,1.9c-0.6-1.4-1.2-3-2.1-3.9c-0.2-0.2-0.3-0.1-0.2,0.1c0.1,0.4,0.2,0.8,0.4,1.6c0.2,0.8,0.4,1.8,0.6,3c0.2,1.2,0.4,2.5,0.6,4c0.2,1.5,0.3,3,0.4,4.7c0.1,0.8,0.1,1.7,0.1,2.6c0,0.4,0,0.9,0,1.3s0,0.9,0,1.4c0,0.9,0,1.8,0,2.7c0,0.5,0,0.9,0.1,1.4c0,0.5,0.1,0.9,0.2,1.3c0,0.2,0.1,0.4,0.2,0.6c0.1,0.2,0.2,0.3,0.2,0.4c0.1,0.1,0.1,0.1,0.2,0.1c0.1,0,0.3,0,0.5-0.1c0.4-0.1,0.8-0.3,1.3-0.5c0.4-0.2,0.9-0.4,1.4-0.6c1-0.4,2-0.6,3.1-0.6c1,0,2,0.1,3,0.3c1,0.2,2,0.6,2.9,1c0.9,0.5,1.7,1,2.4,1.5c1.5,1.1,2.8,2.3,4,3.5c1.2,1.2,2.3,2.3,3.4,3.3c0.5,0.5,1.1,0.9,1.6,1.2c0.5,0.3,1.1,0.6,1.6,0.8c1.1,0.4,2.1,0.4,2.9,0.2c0.4-0.1,0.7-0.2,1-0.3c0.3-0.1,0.5-0.3,0.7-0.4c0.1-0.1,0.2-0.1,0.2-0.2c0.1-0.1,0.1-0.1,0.2-0.1c0.1-0.1,0.1-0.1,0.1-0.1l0,0c0,0,0,0,0.1,0c0,0,0,0,0,0.1c0,0,0,0-0.1,0.1c0,0-0.1,0.1-0.2,0.1c-0.1,0.1-0.2,0.1-0.2,0.2c-0.4,0.3-1,0.6-1.8,0.9c-0.8,0.2-1.9,0.2-3.1-0.1c-1.1-0.3-2.4-1-3.5-1.9c-1.1-1-2.2-2.1-3.5-3.2c-1.2-1.1-2.6-2.3-4-3.4c-0.7-0.5-1.5-1-2.4-1.4c-0.8-0.4-1.7-0.7-2.7-0.9c-0.9-0.2-1.9-0.3-2.9-0.3c-1,0-1.9,0.2-2.8,0.6c-0.5,0.2-0.9,0.4-1.3,0.6c-0.4,0.2-0.9,0.4-1.4,0.5c-0.2,0.1-0.5,0.1-0.7,0.1c-0.3,0-0.5-0.1-0.7-0.3c-0.2-0.2-0.3-0.4-0.4-0.6c-0.1-0.2-0.2-0.5-0.2-0.7c-0.2-0.9-0.2-1.9-0.3-2.8c0-0.9,0-1.9,0-2.8c0.1-1.8,0.1-3.6,0-5.3c0-1.7-0.1-3.2-0.3-4.7c-0.1-1.5-0.3-2.8-0.5-4c-0.2-1.2-0.3-2.2-0.5-3c-0.2-1-0.3-1.6-0.6-1.9c-0.7-1-1.7-1.2-2.9-0.8c-1.8,0.6-3.2,4.3-2.8,17c0.4,12.1,7.1,27.2,20.3,28.5v1.4c-7.4,0-13.3,0.6-13.3,1.4c0,0.8,6.4,1.4,14.3,1.4c7.9,0,14.3-0.6,14.3-1.4c0-0.7-5.9-1.3-13.3-1.4v-1.3C-120.3-23.5-111.3-35.9-115.5-42.1z"></path>
    </g>
    <g transform="matrix(0.8488585562093208,0,0,0.8488585562093208,47.16540709828512,125.83461074719091)">
      <path class="mc-logo-fill" d="M-42-94.3l-6.1,4.1l-6.1-4.1v7.3h-1.3v-9.7l7.4,5l7.4-5v9.7H-42L-42-94.3L-42-94.3z M-22-88.3v1.3h-14.9v-10.4H-22v1.3h-13.6v3.2l9.1,0l0,1.3l-9.1,0v3.2L-22-88.3L-22-88.3z M-4-91.8c0.4,0.5,0.7,1.1,0.7,1.9c0,2.3-1.9,2.9-2.9,2.9h-12v-10.4h11.7c2.3,0,3.2,1.7,3.2,2.9c0,0.8-0.2,1.4-0.7,1.9l-0.3,0.4L-4-91.8z M-5.3-88.5c0.5-0.3,0.7-0.7,0.7-1.4c0-0.7-0.3-1.1-0.9-1.4c-0.5-0.2-1-0.2-1-0.2h-10.4v3.2h10.7l0,0C-6.2-88.3-5.7-88.3-5.3-88.5L-5.3-88.5z M-5.3-93.1c0.5-0.3,0.7-0.7,0.7-1.4c0-0.7-0.3-1.1-0.9-1.4c-0.5-0.2-1-0.2-1-0.2h-10.4v3.2h10.7l0,0C-6.2-92.8-5.7-92.9-5.3-93.1L-5.3-93.1z M15.1-88.3v1.3H0.2v-10.4h14.9v1.3H1.5v3.2l9.1,0l0,1.3l-9.1,0v3.2L15.1-88.3L15.1-88.3z M20.2-97.4l0,9.1h13.6v1.3H18.9v-10.4L20.2-97.4L20.2-97.4z M51.3-87l-0.6,0c0,0-1,0-3,0c-1.2,0-2.4,0-3.7,0c-2.3,0-4.1-0.5-5.4-1.4c-1.2-0.9-1.9-2.2-1.9-3.7c0-1.5,0.7-2.8,1.9-3.7c1.3-0.9,3.2-1.4,5.4-1.4c1.5,0,2.7,0,3.7,0c2,0,3,0,3.1,0l0.6,0l0,1.3l-0.6,0c-0.2,0-2.5,0-6.7,0c-3.8,0-6.1,1.5-6.1,3.8c0,1.1,0.5,2,1.4,2.6c1.1,0.8,2.7,1.2,4.7,1.2c4.4,0,6.7,0,6.7,0l0.6,0L51.3-87z M70-88.3v1.3H55.1v-10.4H70v1.3H56.4v3.2l9.1,0l0,1.3l-9.1,0v3.2L70-88.3L70-88.3z M88.7-97.4v9.9l-13.6-7.1v7.6h-1.3v-9.9l13.6,7.1v-7.6H88.7z M99.3-87.1v-9.1h-6.8v-1.3h14.9v1.3h-6.8v9.1H99.3L99.3-87.1z M126.1-88.3v1.3h-14.9v-10.4h14.9v1.3h-13.6v3.2l9.1,0l0,1.3l-9.1,0v3.2L126.1-88.3L126.1-88.3z M136.5-91.2l-0.1-0.4h-5.2l0,4.5l-1.3,0l0-9.6v-0.6l0.6,0h11c1.3,0,3.1,0.8,3.1,2.9c0,2.3-1.9,2.9-2.9,2.9h-4.2l0.2,0.7c0.2,0.5,0.4,0.9,0.8,1.3c1.3,1.3,3.9,1.3,5.2,1.2l0.6,0l0,1.3l-0.7,0c-0.2,0-0.4,0-0.6,0c-1.6,0-4-0.2-5.5-1.6C137-89.4,136.6-90.2,136.5-91.2L136.5-91.2z M131.2-96.1l0,3.2h10.6l0,0c0,0,0.5,0,0.9-0.2c0.5-0.3,0.7-0.7,0.7-1.4c0-0.7-0.3-1.1-0.9-1.4c-0.5-0.2-1-0.2-1-0.2L131.2-96.1L131.2-96.1z"></path>
    </g>
  </g>
</svg>`;

// Lightweight inline icon set. Kept as strings so the panel stays fully
// self-contained (no external font/CDN loads). Stroke uses currentColor so
// each icon inherits its container's text color.
const IC = {
  inv: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5v-7z"/><path d="M3 6.5 10 10l7-3.5"/><path d="M10 10v7"/></svg>`,
  eye: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.7 10s2.6-5.3 8.3-5.3S18.3 10 18.3 10 15.7 15.3 10 15.3 1.7 10 1.7 10z"/><circle cx="10" cy="10" r="2.4"/></svg>`,
  sync: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5A6.5 6.5 0 0 1 15 5.2"/><path d="M15 2.5V6h-3.5"/><path d="M16.5 11.5A6.5 6.5 0 0 1 5 14.8"/><path d="M5 17.5V14h3.5"/></svg>`,
  refresh: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6"/><path d="M16.5 3.5V7H13"/></svg>`,
  logout: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 15v1.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1V5"/><path d="M8 10h9m0 0-3-3m3 3-3 3"/></svg>`,
  store: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8v8.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V8"/><path d="M2 8h16l-1.4-4.2a.8.8 0 0 0-.76-.55H4.16a.8.8 0 0 0-.76.55L2 8z"/><path d="M2 8a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0"/></svg>`,
  portal: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3h6v6"/><path d="M17 3l-8 8"/><path d="M14 11v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  check: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5 8 14.5 16 6"/></svg>`,
  warn: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 2.5 16h15L10 3z"/><path d="M10 8v4"/><circle cx="10" cy="14.5" r="0.6" fill="currentColor" stroke="none"/></svg>`,
  err: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M7 7l6 6M13 7l-6 6"/></svg>`,
  clock: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/></svg>`,
  info: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 9v5"/><circle cx="10" cy="6.5" r="0.6" fill="currentColor" stroke="none"/></svg>`,
  spark: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.4 4.4l2.1 2.1M13.5 13.5l2.1 2.1M4.4 15.6l2.1-2.1M13.5 6.5l2.1-2.1"/></svg>`,
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

function extractPassword(req, rawBody) {
  if (req.body != null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return req.body.password || '';
    }
  }
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(rawBody);
      return parsed?.password || '';
    } catch {
      return '';
    }
  }
  const params = new URLSearchParams(rawBody);
  return params.get('password') || '';
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
  const isB2b = summary.target === 'b2bcenter';
  const nameMap = isB2b ? B2BCENTER_SUPPLIERS : SUPPLIERS;
  const name = nameMap[summary.supplier]?.name || summary.supplier;
  return {
    target: isB2b ? 'b2bcenter' : 'shopify',
    supplierKey: summary.supplier,
    supplier: isB2b ? `B2BCenter · ${name}` : name,
    manufacturer: summary.manufacturer || nameMap[summary.supplier]?.vendor || summary.vendor || null,
    vendor: summary.vendor || summary.manufacturer || null,
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
    .filter(
      (entry) =>
        entry.name.startsWith('megapap-') ||
        entry.name.startsWith('b2bmarkt-') ||
        entry.name.startsWith('b2bcenter-'),
    )
    .map((entry) => path.join(logDir, entry.name));

  const runs = [];
  for (const file of jsonFiles) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!parsed?.supplier || !parsed?.counts) continue;
      const isB2b = parsed.target === 'b2bcenter';
      const nameMap = isB2b ? B2BCENTER_SUPPLIERS : SUPPLIERS;
      const name = nameMap[parsed.supplier]?.name || parsed.supplier;
      runs.push({
        target: isB2b ? 'b2bcenter' : 'shopify',
        supplierKey: parsed.supplier,
        supplier: `${isB2b ? 'B2BCenter' : 'Shopify'} · ${name}`,
        vendor: parsed.vendor || parsed.manufacturer || null,
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
<html lang="bg">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Вход · Mebelcenter Операции</title>
    <style>${renderStyles()}</style>
  </head>
  <body class="login-body">
    <main class="login-shell">
      <section class="login-panel">
        <div class="login-logo">${BRAND_LOGO_SVG}</div>
        <p class="eyebrow">Оперативен панел</p>
        <h1>Вход в системата</h1>
        <p class="login-copy">Вътрешен панел за управление на наличностите от доставчиците към онлайн магазина.</p>
        <form class="login-form" method="post" action="/api/login">
          <label for="password">Парола за достъп</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
          <button class="btn btn-primary btn-block" type="submit">Влизане</button>
          <div class="form-message" role="alert">${escapeHtml(message)}</div>
        </form>
      </section>
      <p class="login-foot">Достъпът е ограничен само за оторизиран персонал на Mebelcenter.</p>
    </main>
  </body>
</html>`;
}

function renderDashboardPage() {
  return `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mebelcenter Операции · Наличности</title>
    <style>${renderStyles()}</style>
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">${BRAND_LOGO_SVG}</div>
        <nav class="nav" aria-label="Навигация">
          <p class="nav-label">Работа</p>
          <a class="nav-item active" href="/dashboard" aria-current="page">
            <span class="nav-ico" aria-hidden="true">${IC.inv}</span>Наличности
          </a>
          <p class="nav-label nav-label-soft">Предстоящи</p>
          <span class="nav-item disabled">Цени</span>
          <span class="nav-item disabled">Липсващи продукти</span>
          <span class="nav-item disabled">Преводи</span>
          <span class="nav-item disabled">Почистване</span>
          <span class="nav-item disabled">Логове</span>
          <span class="nav-item disabled">Настройки</span>
        </nav>
        <div class="sidebar-foot">
          <span class="dot-live" aria-hidden="true"></span>
          Системата е активна
        </div>
      </aside>

      <main class="main">
        <header class="topbar">
          <div class="topbar-text">
            <p class="eyebrow">Оперативен панел</p>
            <h1>Синхронизация на наличности</h1>
            <p class="subtitle">Обновявайте складовите количества от доставчиците. Първо направете преглед, след което приложете промените.</p>
          </div>
          <form method="post" action="/api/logout">
            <button class="btn btn-ghost" type="submit">
              <span class="btn-ico">${IC.logout}</span>Изход
            </button>
          </form>
        </header>

        <ol class="rail" aria-label="Как работи">
          <li class="rail-step is-current"><span class="rail-dot">1</span><span class="rail-text">Изберете доставчик</span></li>
          <li class="rail-step"><span class="rail-dot">2</span><span class="rail-text">Направете преглед</span></li>
          <li class="rail-step"><span class="rail-dot">3</span><span class="rail-text">Проверете резултата</span></li>
          <li class="rail-step"><span class="rail-dot">4</span><span class="rail-text">Приложете промените</span></li>
        </ol>

        <section aria-labelledby="sec-shopify">
          <div class="section-heading">
            <div class="section-title">
              <span class="section-ico" aria-hidden="true">${IC.store}</span>
              <div>
                <p class="eyebrow">Онлайн магазин</p>
                <h2 id="sec-shopify">Наличности в Shopify</h2>
              </div>
            </div>
            <p class="section-note">Обновява складовите количества на продуктите в онлайн магазина по данни от доставчика.</p>
          </div>
          <div class="supplier-grid">
            ${renderSupplierCard(SUPPLIERS.megapap)}
            ${renderSupplierCard(SUPPLIERS.b2bmarkt)}
          </div>
        </section>

        <section class="b2bcenter-section" aria-labelledby="sec-portal">
          <div class="section-heading">
            <div class="section-title">
              <span class="section-ico" aria-hidden="true">${IC.portal}</span>
              <div>
                <p class="eyebrow">Портал за доставчици</p>
                <h2 id="sec-portal">Синхронизация към B2BCenter</h2>
              </div>
            </div>
            <p class="section-note">Обновява <strong>само количествата</strong> на артикулите в портала B2BCenter. Не променя цени, имена, категории или снимки и <strong>не засяга онлайн магазина</strong>.</p>
          </div>
          <div class="supplier-grid">
            ${renderB2BCenterCard(B2BCENTER_SUPPLIERS.megapap)}
            ${renderB2BCenterCard(B2BCENTER_SUPPLIERS.b2bmarkt)}
          </div>
        </section>

        <section class="panel result-panel is-idle" aria-live="polite">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">Резултат</p>
              <h2>Текущ резултат</h2>
            </div>
            <span id="status-badge" class="status idle">
              <span class="status-ico" aria-hidden="true">${IC.clock}</span>В готовност
            </span>
          </div>

          <div id="result-progress" class="progress" hidden>
            <div class="progress-bar"></div>
            <p class="progress-text" id="progress-text">Обработва се…</p>
          </div>

          <div id="result-empty" class="idle-hint">
            <div class="idle-ico" aria-hidden="true">${IC.eye}</div>
            <div>
              <p class="idle-title">Все още няма изпълнение</p>
              <p class="idle-body">Изберете доставчик и стартирайте <strong>Преглед</strong> — промени няма да бъдат направени, просто ще видите какво предстои.</p>
            </div>
          </div>

          <div id="result-content" hidden>
            <p id="result-summary" class="result-summary"></p>
            <div class="stat-row">
              <div class="stat" id="stat-primary"><span class="stat-label" id="stat-primary-label">Готови за обновяване</span><strong class="stat-value" id="stat-primary-value">0</strong></div>
              <div class="stat" id="stat-skipped"><span class="stat-label">Пропуснати</span><strong class="stat-value" id="stat-skipped-value">0</strong></div>
              <div class="stat" id="stat-attention"><span class="stat-label" id="stat-attention-label">Изискват внимание</span><strong class="stat-value" id="stat-attention-value">0</strong></div>
            </div>
            <dl class="result-meta">
              <div><dt>Доставчик</dt><dd id="meta-supplier">—</dd></div>
              <div><dt>Режим</dt><dd id="meta-mode">—</dd></div>
              <div><dt>Продължителност</dt><dd id="meta-elapsed">—</dd></div>
              <div><dt>Приключено</dt><dd id="meta-finished">—</dd></div>
            </dl>
            <details class="tech-details">
              <summary>
                <span class="tech-label">Технически детайли (лог)</span>
                <button id="copy-log" class="btn btn-ghost btn-sm" type="button">Копирай</button>
              </summary>
              <pre id="logs">Няма записан лог.</pre>
            </details>
          </div>
        </section>

        <section class="panel recent-panel">
          <div class="panel-heading">
            <div>
              <p class="eyebrow">История</p>
              <h2>Последни изпълнения</h2>
            </div>
            <button id="refresh-runs" class="btn btn-ghost btn-sm" type="button">
              <span class="btn-ico">${IC.refresh}</span>Обнови
            </button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Дестинация · Доставчик</th>
                  <th>Режим</th>
                  <th class="num">Обновени</th>
                  <th class="num">Пропуснати</th>
                  <th class="num">Грешки</th>
                  <th>Приключено</th>
                </tr>
              </thead>
              <tbody id="recent-runs"></tbody>
            </table>
          </div>
        </section>
      </main>
    </div>

    <div id="confirm-modal" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="modal-icon" aria-hidden="true">${IC.warn}</div>
        <h3 id="confirm-title">Да приложа ли синхронизацията?</h3>
        <p id="confirm-body" class="modal-body"></p>
        <ul id="confirm-points" class="modal-points"></ul>
        <p id="confirm-hint" class="modal-hint"></p>
        <div class="modal-actions">
          <button id="confirm-cancel" class="btn btn-ghost" type="button">Отказ</button>
          <button id="confirm-ok" class="btn btn-primary" type="button">Да, приложи</button>
        </div>
      </div>
    </div>

    <script>${renderClientScript()}</script>
  </body>
</html>`;
}

function renderSupplierCard(supplier) {
  return `<article class="supplier-card" id="card-shopify-${supplier.key}" data-card="${supplier.key}">
    <header class="card-head">
      <div class="card-title">
        <h3>${supplier.name}</h3>
        <p class="card-caption">Магазин · Марка ${supplier.vendor}</p>
      </div>
      <span class="health-dot ok" data-idle="В готовност">
        <span class="dot" aria-hidden="true"></span>В готовност
      </span>
    </header>
    <p class="card-desc">Обновява складовите количества в онлайн магазина по данни от <strong>${supplier.name}</strong>.</p>
    <div class="last-result" id="last-${supplier.key}">Все още няма данни от изпълнение.</div>
    <div class="card-actions">
      <button class="btn btn-secondary" type="button" data-target="shopify" data-supplier="${supplier.key}" data-dry-run="true">
        <span class="btn-ico">${IC.eye}</span>Преглед
      </button>
      <button class="btn btn-primary" type="button" data-target="shopify" data-supplier="${supplier.key}" data-dry-run="false">
        <span class="btn-ico">${IC.sync}</span>Синхронизирай
      </button>
    </div>
    <p class="card-foot"><span>Ръчно стартиране · Обновяват се само количествата</span></p>
  </article>`;
}

function renderB2BCenterCard(supplier) {
  return `<article class="supplier-card is-portal" id="card-b2bcenter-${supplier.key}" data-card="b2bcenter-${supplier.key}">
    <header class="card-head">
      <div class="card-title">
        <h3>${supplier.name}</h3>
        <p class="card-caption">Портал B2BCenter · ${supplier.manufacturer}</p>
      </div>
      <span class="health-dot ok" data-idle="В готовност">
        <span class="dot" aria-hidden="true"></span>В готовност
      </span>
    </header>
    <p class="card-desc">Обновява количествата на артикулите на <strong>${supplier.name}</strong> в портала B2BCenter.</p>
    <div class="last-result" id="last-b2bcenter-${supplier.key}">Все още няма данни от изпълнение.</div>
    <div class="card-actions">
      <button class="btn btn-secondary" type="button" data-target="b2bcenter" data-supplier="${supplier.key}" data-dry-run="true">
        <span class="btn-ico">${IC.eye}</span>Преглед
      </button>
      <button class="btn btn-primary" type="button" data-target="b2bcenter" data-supplier="${supplier.key}" data-dry-run="false">
        <span class="btn-ico">${IC.sync}</span>Синхронизирай
      </button>
    </div>
    <p class="card-foot"><span title="Съпоставяне по артикулен номер (SKU) в портала B2BCenter">Съпоставяне по артикул · Само количествата</span></p>
  </article>`;
}

function renderStyles() {
  return `
    :root {
      color-scheme: light;
      /* Brand */
      --brand: #C4301C;
      --brand-strong: #A5271A;
      --brand-deep: #7B1E13;
      --brand-soft: #F6DDD8;
      --brand-softer: #FBEEE9;
      --brand-tint: #FDF7F5;
      /* Neutrals — warm, no blue */
      --ink: #1F1B1A;
      --ink-2: #3A3330;
      --text: #2B2724;
      --muted: #78706C;
      --faint: #A29A96;
      --bg: #F7F5F2;
      --surface: #FFFFFF;
      --surface-2: #FAF7F4;
      --surface-3: #F1ECE7;
      --border: #E8E2DC;
      --line: #EFEAE4;
      /* Semantic (kept restrained) */
      --ok-bg: #ECF5EE; --ok-text: #2A6E45; --ok-border: #D1E7D8;
      --warn-bg: #FBF1DE; --warn-text: #7C5100; --warn-border: #EFDAA9;
      --err-bg: #FBEAE7; --err-text: #A5271A; --err-border: #F3CEC7;
      /* Sizing */
      --radius: 14px;
      --radius-sm: 10px;
      --radius-xs: 8px;
      --shadow-sm: 0 1px 2px rgba(31,27,26,0.04), 0 1px 3px rgba(31,27,26,0.05);
      --shadow: 0 8px 24px rgba(31,27,26,0.06);
      --shadow-lg: 0 20px 44px rgba(31,27,26,0.14);
      --focus-ring: 0 0 0 3px rgba(196,48,28,0.22);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-size: 14.5px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    h1, h2, h3, h4 { color: var(--ink); letter-spacing: -0.005em; margin: 0; }
    h1 { font-size: clamp(24px, 2.4vw, 30px); line-height: 1.15; letter-spacing: -0.015em; }
    h2 { font-size: 18px; line-height: 1.25; font-weight: 700; }
    h3 { font-size: 17px; line-height: 1.25; font-weight: 700; }
    p { margin: 0; }
    button, input { font: inherit; color: inherit; }
    a { color: inherit; }
    [hidden] { display: none !important; }

    /* -----------------------------------------------------------------
       Buttons — one shared system, three variants (+ small size)
       ----------------------------------------------------------------- */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      height: 40px;
      padding: 0 18px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      background: transparent;
      color: var(--ink);
      font-weight: 600;
      font-size: 14px;
      letter-spacing: -0.005em;
      cursor: pointer;
      white-space: nowrap;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease, transform 140ms ease, opacity 140ms ease;
    }
    .btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    .btn:not([disabled]):active { transform: translateY(0.5px); }
    .btn[disabled] { cursor: not-allowed; opacity: 0.45; }
    .btn-block { width: 100%; }
    .btn-sm { height: 32px; padding: 0 12px; font-size: 12.5px; }
    .btn-ico {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px; height: 16px;
      color: currentColor;
    }
    .btn-ico svg { width: 100%; height: 100%; display: block; }
    /* Primary — Mebelcenter red */
    .btn-primary {
      background: var(--brand);
      color: #fff;
      box-shadow: 0 1px 0 rgba(31,27,26,0.04), 0 1px 2px rgba(196,48,28,0.20);
    }
    .btn-primary:not([disabled]):hover { background: var(--brand-strong); box-shadow: 0 6px 16px rgba(196,48,28,0.22); }
    .btn-primary:not([disabled]):active { background: var(--brand-deep); }
    /* Secondary — white with warm border */
    .btn-secondary {
      background: var(--surface);
      color: var(--ink);
      border-color: var(--border);
    }
    .btn-secondary:not([disabled]):hover { background: var(--surface-2); border-color: #d9d1c9; color: var(--ink); }
    /* Ghost — chrome-free, subtle hover */
    .btn-ghost {
      background: transparent;
      color: var(--ink-2);
      border-color: transparent;
    }
    .btn-ghost:not([disabled]):hover { background: var(--surface-3); color: var(--ink); }

    .eyebrow {
      margin: 0 0 6px;
      color: var(--brand);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.10em;
      text-transform: uppercase;
    }

    /* -----------------------------------------------------------------
       Login
       ----------------------------------------------------------------- */
    .login-body {
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(1200px 520px at 50% -8%, rgba(196,48,28,0.06), transparent 60%),
        var(--bg);
    }
    .login-shell { width: min(430px, 100%); }
    .login-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 36px 34px 32px;
      box-shadow: var(--shadow-lg);
    }
    .login-logo { margin-bottom: 24px; }
    .login-logo .brand-logo { height: 36px; width: auto; }
    .login-panel h1 { font-size: 26px; margin-bottom: 8px; }
    .login-copy { margin: 0 0 26px; color: var(--muted); font-size: 14.5px; }
    .login-form label {
      display: block;
      margin-bottom: 8px;
      color: var(--ink-2);
      font-size: 13px;
      font-weight: 600;
    }
    .login-form input {
      width: 100%;
      height: 46px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0 14px;
      background: var(--surface);
      color: var(--text);
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    .login-form input:hover { border-color: #d9d1c9; }
    .login-form input:focus-visible { outline: none; border-color: var(--brand); box-shadow: var(--focus-ring); }
    .login-form .btn { height: 46px; margin-top: 16px; font-size: 15px; font-weight: 700; }
    .form-message { min-height: 20px; margin-top: 12px; color: var(--err-text); font-size: 13px; font-weight: 600; }
    .login-foot { margin: 18px 4px 0; text-align: center; color: var(--faint); font-size: 12.5px; }

    /* -----------------------------------------------------------------
       App shell / sidebar
       ----------------------------------------------------------------- */
    .app-shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 24px 14px 18px;
      background: var(--surface);
      border-right: 1px solid var(--border);
    }
    .sidebar-brand {
      display: flex;
      align-items: center;
      padding: 2px 10px 20px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--line);
    }
    .sidebar-brand .brand-logo { height: 30px; width: auto; }
    .nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .nav-label {
      margin: 14px 12px 6px;
      color: var(--faint);
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.10em;
      text-transform: uppercase;
    }
    .nav-label:first-child { margin-top: 0; }
    .nav-label-soft { color: var(--faint); opacity: 0.75; }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      border-radius: var(--radius-sm);
      color: var(--ink-2);
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: background 120ms ease, color 120ms ease;
    }
    a.nav-item:hover { background: var(--surface-3); color: var(--ink); }
    .nav-ico {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px; height: 18px;
      color: var(--faint);
    }
    .nav-ico svg { width: 100%; height: 100%; display: block; }
    .nav-item.active {
      background: var(--brand-softer);
      color: var(--brand-strong);
      font-weight: 600;
    }
    .nav-item.active .nav-ico { color: var(--brand); }
    .nav-item.disabled {
      color: var(--faint);
      cursor: default;
      font-weight: 500;
      padding-left: 12px;
    }
    .sidebar-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 12px 4px;
      margin-top: 10px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12.5px;
      font-weight: 500;
    }
    .dot-live {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--ok-text);
      box-shadow: 0 0 0 3px var(--ok-bg);
    }

    /* -----------------------------------------------------------------
       Main / header
       ----------------------------------------------------------------- */
    .main { min-width: 0; padding: 32px clamp(20px, 4vw, 44px) 56px; max-width: 1180px; }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
      margin-bottom: 24px;
    }
    .topbar-text { min-width: 0; }
    .subtitle {
      margin-top: 8px;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.55;
      max-width: 620px;
    }

    /* -----------------------------------------------------------------
       Workflow rail — compact horizontal steps with connectors
       ----------------------------------------------------------------- */
    .rail {
      display: flex;
      align-items: center;
      gap: 0;
      margin: 0 0 28px;
      padding: 14px 18px;
      list-style: none;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      overflow-x: auto;
    }
    .rail-step {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
      position: relative;
      padding-right: 18px;
    }
    .rail-step + .rail-step { padding-left: 18px; }
    .rail-step + .rail-step::before {
      content: "";
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 12px;
      height: 1.5px;
      background: var(--line);
    }
    .rail-dot {
      flex-shrink: 0;
      display: inline-grid;
      place-items: center;
      width: 24px; height: 24px;
      border-radius: 50%;
      background: var(--surface-3);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .rail-step.is-current .rail-dot {
      background: var(--brand);
      color: #fff;
      box-shadow: 0 0 0 4px var(--brand-softer);
    }
    .rail-text {
      color: var(--muted);
      font-size: 13.5px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rail-step.is-current .rail-text { color: var(--ink); font-weight: 600; }

    /* -----------------------------------------------------------------
       Section headings
       ----------------------------------------------------------------- */
    section { margin-bottom: 28px; }
    .section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .section-title {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .section-ico {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px; height: 38px;
      border-radius: 10px;
      background: var(--brand-tint);
      color: var(--brand);
      flex-shrink: 0;
    }
    .section-ico svg { width: 20px; height: 20px; }
    .section-heading h2 { font-size: 19px; letter-spacing: -0.01em; }
    .section-note {
      max-width: 540px;
      color: var(--muted);
      font-size: 13.5px;
      line-height: 1.55;
    }
    .section-note strong { color: var(--ink-2); font-weight: 600; }

    /* -----------------------------------------------------------------
       Cards / panels
       ----------------------------------------------------------------- */
    .supplier-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .supplier-card, .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
    }
    .supplier-card {
      display: flex;
      flex-direction: column;
      padding: 22px 22px 18px;
      transition: box-shadow 180ms ease, transform 180ms ease, border-color 180ms ease;
    }
    .supplier-card:hover { box-shadow: var(--shadow); transform: translateY(-1px); }
    .supplier-card.is-running {
      border-color: var(--brand-soft);
      box-shadow: 0 0 0 4px var(--brand-tint), var(--shadow);
    }
    .panel { padding: 24px; }

    .card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .card-title h3 { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; }
    .card-caption {
      margin-top: 3px;
      color: var(--faint);
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    .card-desc {
      color: var(--muted);
      font-size: 13.5px;
      line-height: 1.55;
      margin-bottom: 14px;
    }
    .card-desc strong { color: var(--ink-2); font-weight: 600; }

    .last-result {
      min-height: 40px;
      margin-bottom: 16px;
      padding: 10px 13px;
      border-radius: var(--radius-xs);
      background: var(--surface-2);
      border: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .card-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .card-actions .btn { height: 42px; }
    .card-foot {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px dashed var(--line);
      color: var(--faint);
      font-size: 11.5px;
      font-weight: 500;
      letter-spacing: 0.01em;
    }
    .card-foot span[title] { cursor: help; }

    /* -----------------------------------------------------------------
       Status badges — one shared shape, semantic tones
       ----------------------------------------------------------------- */
    .health-dot, .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 26px;
      padding: 0 11px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      border: 1px solid transparent;
    }
    .status-ico { display: inline-flex; width: 13px; height: 13px; }
    .status-ico svg { width: 100%; height: 100%; display: block; }
    .health-dot .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .health-dot.ok        { background: var(--ok-bg);   color: var(--ok-text);   border-color: var(--ok-border); }
    .health-dot.running   { background: var(--brand-softer); color: var(--brand-strong); border-color: var(--brand-soft); }
    .health-dot.running .dot { animation: pulse 1.1s ease-in-out infinite; }
    .status.idle          { background: var(--surface-3); color: var(--muted);    border-color: var(--line); }
    .status.running       { background: var(--brand-softer); color: var(--brand-strong); border-color: var(--brand-soft); }
    .status.running .status-ico svg { animation: spin 1.8s linear infinite; transform-origin: 50% 50%; }
    .status.success       { background: var(--ok-bg);    color: var(--ok-text);   border-color: var(--ok-border); }
    .status.warning       { background: var(--warn-bg);  color: var(--warn-text); border-color: var(--warn-border); }
    .status.error         { background: var(--err-bg);   color: var(--err-text);  border-color: var(--err-border); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* -----------------------------------------------------------------
       Result panel — compact idle, richer after a run
       ----------------------------------------------------------------- */
    .panel-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-heading h2 { font-size: 18px; }

    .idle-hint {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      margin-top: 18px;
      padding: 16px 18px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px dashed var(--border);
    }
    .idle-ico {
      flex-shrink: 0;
      display: inline-grid;
      place-items: center;
      width: 36px; height: 36px;
      border-radius: 10px;
      background: var(--brand-tint);
      color: var(--brand);
    }
    .idle-ico svg { width: 18px; height: 18px; }
    .idle-title { color: var(--ink); font-size: 14.5px; font-weight: 600; }
    .idle-body { margin-top: 2px; color: var(--muted); font-size: 13.5px; line-height: 1.5; }
    .idle-body strong { color: var(--ink-2); font-weight: 600; }

    .progress { margin: 18px 0 6px; }
    .progress-bar {
      height: 6px;
      border-radius: 999px;
      background: var(--brand-softer);
      overflow: hidden;
      position: relative;
    }
    .progress-bar::after {
      content: "";
      position: absolute;
      inset: 0;
      width: 38%;
      border-radius: 999px;
      background: var(--brand);
      opacity: 0.85;
      animation: indeterminate 1.35s ease-in-out infinite;
    }
    @keyframes indeterminate { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
    .progress-text {
      margin-top: 10px;
      color: var(--brand-strong);
      font-size: 13.5px;
      font-weight: 600;
    }

    .result-summary {
      margin: 18px 0 18px;
      padding: 16px 18px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-left: 3px solid var(--ink);
      color: var(--ink);
      font-size: 15.5px;
      font-weight: 500;
      line-height: 1.5;
    }
    .result-panel.is-success .result-summary { border-left-color: var(--ok-text); background: var(--ok-bg); border-color: var(--ok-border); color: var(--ok-text); }
    .result-panel.is-warning .result-summary { border-left-color: var(--warn-text); background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-text); }
    .result-panel.is-error   .result-summary { border-left-color: var(--err-text); background: var(--err-bg); border-color: var(--err-border); color: var(--err-text); }

    .stat-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .stat {
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--surface);
    }
    .stat-label { display: block; color: var(--muted); font-size: 12px; font-weight: 500; }
    .stat-value {
      display: block;
      margin-top: 6px;
      color: var(--ink);
      font-size: 26px;
      line-height: 1;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
    }
    .stat.is-attention { background: var(--warn-bg); border-color: var(--warn-border); }
    .stat.is-attention .stat-label, .stat.is-attention .stat-value { color: var(--warn-text); }
    .stat.is-error { background: var(--err-bg); border-color: var(--err-border); }
    .stat.is-error .stat-label, .stat.is-error .stat-value { color: var(--err-text); }

    .result-meta {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin: 18px 0 0;
      padding: 18px 0 4px;
      border-top: 1px solid var(--line);
    }
    .result-meta > div { min-width: 0; margin: 0; }
    .result-meta dt {
      margin: 0;
      color: var(--faint);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .result-meta dd {
      margin: 5px 0 0;
      color: var(--ink-2);
      font-size: 14px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tech-details {
      margin-top: 20px;
      border-top: 1px solid var(--line);
      padding-top: 14px;
    }
    .tech-details summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      list-style: none;
      cursor: pointer;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
    }
    .tech-details summary::-webkit-details-marker { display: none; }
    .tech-label::before { content: "▸"; display: inline-block; margin-right: 6px; color: var(--faint); transition: transform 160ms ease; }
    .tech-details[open] .tech-label::before { content: "▾"; }
    .tech-details pre {
      max-height: 340px;
      margin: 12px 0 0;
      overflow: auto;
      border-radius: var(--radius-xs);
      border: 1px solid #17110E;
      padding: 14px;
      background: #17110E;
      color: #E8D9CE;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* -----------------------------------------------------------------
       Table
       ----------------------------------------------------------------- */
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: var(--surface);
    }
    table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 13.5px; }
    th, td {
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      white-space: nowrap;
      vertical-align: middle;
    }
    th {
      background: var(--surface-2);
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
    tbody tr { transition: background 120ms ease; }
    tbody tr:hover { background: var(--surface-2); }
    tr:last-child td { border-bottom: none; }
    .cell-supplier { color: var(--ink); font-weight: 600; }
    .cell-date { color: var(--muted); }
    td.empty-cell, td.loading-cell {
      padding: 40px 18px;
      text-align: center;
      color: var(--muted);
      white-space: normal;
    }
    td.empty-cell strong { display: block; color: var(--ink); font-size: 14.5px; margin-bottom: 4px; font-weight: 600; }
    td.empty-cell span { display: block; color: var(--muted); font-size: 13px; }
    .mode-pill {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 10px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      border: 1px solid transparent;
    }
    .mode-pill.preview { background: var(--surface-3); color: var(--ink-2); border-color: var(--border); }
    .mode-pill.apply   { background: var(--brand-softer); color: var(--brand-strong); border-color: var(--brand-soft); }
    .cell-err { color: var(--err-text); font-weight: 700; }
    .skel {
      display: inline-block;
      height: 12px;
      width: 70%;
      border-radius: 6px;
      background: linear-gradient(90deg, var(--line) 25%, #ede7e1 37%, var(--line) 63%);
      background-size: 400% 100%;
      animation: shimmer 1.35s ease infinite;
    }
    @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

    /* -----------------------------------------------------------------
       Modal
       ----------------------------------------------------------------- */
    .modal-overlay {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(31,27,26,0.42);
      backdrop-filter: blur(3px);
      z-index: 50;
      animation: fade 140ms ease;
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    .modal {
      width: min(460px, 100%);
      background: var(--surface);
      border-radius: 18px;
      padding: 28px;
      box-shadow: var(--shadow-lg);
      animation: rise 180ms ease;
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .modal-icon {
      width: 42px; height: 42px;
      display: grid; place-items: center;
      border-radius: 12px;
      background: var(--warn-bg);
      color: var(--warn-text);
      margin-bottom: 14px;
    }
    .modal-icon svg { width: 22px; height: 22px; }
    .modal h3 { font-size: 19px; margin-bottom: 8px; }
    .modal-body { margin-bottom: 14px; color: var(--text); font-size: 14.5px; line-height: 1.55; }
    .modal-points { margin: 0 0 14px; padding: 0; list-style: none; display: grid; gap: 8px; }
    .modal-points li {
      position: relative;
      padding-left: 24px;
      color: var(--ink-2);
      font-size: 13.5px;
      line-height: 1.5;
    }
    .modal-points li.will::before { content: "✓"; position: absolute; left: 4px; top: 0; color: var(--ok-text); font-weight: 800; }
    .modal-points li.wont::before { content: "×"; position: absolute; left: 4px; top: -2px; color: var(--faint); font-weight: 800; font-size: 16px; line-height: 1; }
    .modal-hint {
      margin: 0 0 20px;
      padding: 10px 12px;
      border-radius: var(--radius-xs);
      background: var(--warn-bg);
      border: 1px solid var(--warn-border);
      color: var(--warn-text);
      font-size: 13px;
      line-height: 1.5;
    }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; }

    /* -----------------------------------------------------------------
       Focus / motion
       ----------------------------------------------------------------- */
    :focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: var(--radius-xs); }
    a.nav-item:focus-visible { border-radius: var(--radius-sm); }

    /* -----------------------------------------------------------------
       Responsive
       ----------------------------------------------------------------- */
    @media (max-width: 1080px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        flex-direction: row;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px 16px;
        padding: 14px 20px;
      }
      .sidebar-brand { border-bottom: none; padding: 0; margin-bottom: 0; }
      .nav { flex-direction: row; flex-wrap: wrap; gap: 4px; flex: 1 1 100%; margin-top: 4px; }
      .nav-label { display: none; }
      .nav-item { padding: 8px 12px; }
      .nav-item.active { box-shadow: inset 0 -2px 0 var(--brand); border-radius: var(--radius-xs); }
      .sidebar-foot { border-top: none; margin: 0; padding: 0; }
      .rail { padding: 12px 14px; }
    }
    @media (max-width: 820px) {
      .rail { flex-wrap: nowrap; }
      .rail-text { font-size: 13px; }
    }
    @media (max-width: 720px) {
      .main { padding: 22px 16px 44px; }
      .topbar { flex-direction: column; align-items: stretch; }
      .topbar form { align-self: flex-end; }
      .supplier-grid { grid-template-columns: 1fr; }
      .stat-row { grid-template-columns: 1fr; }
      .result-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .card-actions { grid-template-columns: 1fr; }
      .section-heading { align-items: flex-start; gap: 14px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  `;
}

function renderClientScript() {
  return `
    const statusBadge = document.getElementById('status-badge');
    const resultPanel = document.querySelector('.result-panel');
    const resultEmpty = document.getElementById('result-empty');
    const resultContent = document.getElementById('result-content');
    const resultSummaryEl = document.getElementById('result-summary');
    const progressEl = document.getElementById('result-progress');
    const progressTextEl = document.getElementById('progress-text');
    const logsEl = document.getElementById('logs');
    const copyLogButton = document.getElementById('copy-log');
    const runButtons = Array.from(document.querySelectorAll('button[data-supplier]'));
    const recentRunsEl = document.getElementById('recent-runs');
    const refreshRunsButton = document.getElementById('refresh-runs');

    const statPrimary = document.getElementById('stat-primary');
    const statPrimaryLabel = document.getElementById('stat-primary-label');
    const statPrimaryValue = document.getElementById('stat-primary-value');
    const statSkippedValue = document.getElementById('stat-skipped-value');
    const statAttention = document.getElementById('stat-attention');
    const statAttentionLabel = document.getElementById('stat-attention-label');
    const statAttentionValue = document.getElementById('stat-attention-value');
    const meta = {
      supplier: document.getElementById('meta-supplier'),
      mode: document.getElementById('meta-mode'),
      elapsed: document.getElementById('meta-elapsed'),
      finished: document.getElementById('meta-finished'),
    };

    const modal = document.getElementById('confirm-modal');
    const modalTitle = document.getElementById('confirm-title');
    const modalBody = document.getElementById('confirm-body');
    const modalPoints = document.getElementById('confirm-points');
    const modalHint = document.getElementById('confirm-hint');
    const modalOk = document.getElementById('confirm-ok');
    const modalCancel = document.getElementById('confirm-cancel');

    const SUPPLIER_NAMES = { megapap: 'Megapap', b2bmarkt: 'B2BMarkt' };
    let localRunning = false;
    let statusState = 'idle';

    const nf = new Intl.NumberFormat('bg-BG');
    function fmt(n) { return nf.format(Number(n) || 0); }
    function prod(n) { return Number(n) === 1 ? 'продукт' : 'продукта'; }
    function joinBg(arr) {
      if (arr.length <= 1) return arr[0] || '';
      return arr.slice(0, -1).join(', ') + ' и ' + arr[arr.length - 1];
    }

    function formatDate(value) {
      if (!value) return '—';
      try { return new Date(value).toLocaleString('bg-BG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
      catch (e) { return '—'; }
    }

    const STATUS_ICONS = {
      idle: ${JSON.stringify(IC.clock)},
      running: ${JSON.stringify(IC.spark)},
      success: ${JSON.stringify(IC.check)},
      warning: ${JSON.stringify(IC.warn)},
      error: ${JSON.stringify(IC.err)},
    };

    function setStatus(label, state) {
      statusState = state;
      const ico = STATUS_ICONS[state] || STATUS_ICONS.idle;
      statusBadge.className = 'status ' + state;
      statusBadge.innerHTML = '<span class="status-ico" aria-hidden="true">' + ico + '</span>' + label;
    }

    function setPanelTone(tone) {
      resultPanel.classList.remove('is-idle', 'is-success', 'is-warning', 'is-error', 'is-running');
      resultPanel.classList.add('is-' + (tone || 'idle'));
    }

    function setButtonsDisabled(disabled) {
      for (const button of runButtons) button.disabled = disabled;
    }

    function showProgress(show, text) {
      progressEl.hidden = !show;
      if (show && text) progressTextEl.textContent = text;
    }

    function setRunningCard(target, supplierKey) {
      clearRunningCards();
      const card = document.getElementById('card-' + (target || 'shopify') + '-' + supplierKey);
      if (!card) return;
      card.classList.add('is-running');
      const dot = card.querySelector('.health-dot');
      if (dot) {
        dot.className = 'health-dot running';
        dot.innerHTML = '<span class="dot" aria-hidden="true"></span>Изпълнява се…';
      }
    }
    function clearRunningCards() {
      document.querySelectorAll('.supplier-card.is-running').forEach((card) => {
        card.classList.remove('is-running');
        const dot = card.querySelector('.health-dot');
        if (dot) {
          dot.className = 'health-dot ok';
          dot.innerHTML = '<span class="dot" aria-hidden="true"></span>' + (dot.dataset.idle || 'В готовност');
        }
      });
    }

    function buildSentence(s) {
      if (!s) return '';
      if (s.dryRun) {
        if (Number(s.planned) === 0 && Number(s.errors) === 0) {
          return 'Прегледът приключи. Няма промени за прилагане — количествата са актуални.';
        }
        const parts = [fmt(s.planned) + ' ' + prod(s.planned) + ' за обновяване', fmt(s.skipped) + ' пропуснати'];
        if (s.errors > 0) parts.push(fmt(s.errors) + ' изискват внимание');
        return 'Прегледът е готов. Готови са ' + joinBg(parts) + '. Все още не са направени промени.';
      }
      if (Number(s.updated) === 0 && Number(s.errors) === 0) {
        return 'Синхронизацията приключи. Няма нови промени — количествата са актуални.';
      }
      const parts = [fmt(s.updated) + ' ' + prod(s.updated) + ' обновени', fmt(s.skipped) + ' пропуснати'];
      if (s.errors > 0) parts.push(fmt(s.errors) + ' с грешки');
      const tail = s.errors > 0 ? ' Прегледайте техническите детайли по-долу.' : '';
      return 'Синхронизацията приключи. ' + joinBg(parts) + '.' + tail;
    }

    function showEmptyResult() {
      resultEmpty.hidden = false;
      resultContent.hidden = true;
      setPanelTone(null);
    }

    function renderResult(summary) {
      if (!summary) { showEmptyResult(); return; }
      resultEmpty.hidden = true;
      resultContent.hidden = false;

      resultSummaryEl.textContent = buildSentence(summary);
      const dry = summary.dryRun;

      statPrimaryLabel.textContent = dry ? 'Готови за обновяване' : 'Обновени';
      statPrimaryValue.textContent = fmt(dry ? summary.planned : summary.updated);
      statSkippedValue.textContent = fmt(summary.skipped);
      statAttentionLabel.textContent = dry ? 'Изискват внимание' : 'Грешки';
      statAttentionValue.textContent = fmt(summary.errors);
      statAttention.classList.toggle(dry ? 'is-attention' : 'is-error', Number(summary.errors) > 0);
      statAttention.classList.toggle(dry ? 'is-error' : 'is-attention', false);

      meta.supplier.textContent = summary.supplier || '—';
      meta.mode.textContent = dry ? 'Преглед' : 'Приложено';
      meta.elapsed.textContent = (summary.elapsed != null) ? summary.elapsed + ' сек' : '—';
      meta.finished.textContent = formatDate(summary.finishedAt);
    }

    function showErrorResult(message, logs) {
      resultEmpty.hidden = true;
      resultContent.hidden = false;
      setPanelTone('error');
      resultSummaryEl.textContent = 'Изпълнението беше неуспешно. ' + (message || 'Възникна грешка.');
      statPrimaryLabel.textContent = 'Обновени';
      statPrimaryValue.textContent = '—';
      statSkippedValue.textContent = '—';
      statAttentionLabel.textContent = 'Грешки';
      statAttentionValue.textContent = '—';
      statAttention.classList.remove('is-attention'); statAttention.classList.add('is-error');
      meta.supplier.textContent = '—'; meta.mode.textContent = '—'; meta.elapsed.textContent = '—'; meta.finished.textContent = formatDate(Date.now());
      if (logs) setLogs(logs);
    }

    function setLogs(lines) {
      logsEl.textContent = Array.isArray(lines) && lines.length ? lines.join('\\n') : 'Няма записан лог.';
      logsEl.scrollTop = logsEl.scrollHeight;
    }

    function updateSupplierLastResult(summary) {
      if (!summary || !summary.supplierKey) return;
      const prefix = summary.target === 'b2bcenter' ? 'last-b2bcenter-' : 'last-';
      const el = document.getElementById(prefix + summary.supplierKey);
      if (!el) return;
      const kind = summary.dryRun ? 'Последен преглед' : 'Последна синхронизация';
      const head = summary.dryRun
        ? fmt(summary.planned) + ' за обновяване'
        : fmt(summary.updated) + ' обновени';
      let text = kind + ': ' + head + ', ' + fmt(summary.skipped) + ' пропуснати';
      if (summary.errors > 0) text += ', ' + fmt(summary.errors) + (summary.dryRun ? ' за проверка' : ' с грешки');
      el.textContent = text + '.';
    }

    function renderRecentRuns(runs) {
      if (!Array.isArray(runs) || runs.length === 0) {
        recentRunsEl.innerHTML = '<tr><td class="empty-cell" colspan="6"><strong>Няма записани изпълнения</strong><span>Стартирайте „Преглед“ за някой доставчик, за да се появи тук.</span></td></tr>';
        return;
      }
      recentRunsEl.innerHTML = runs.map((run) => {
        const modeLabel = run.mode === 'apply' ? 'Приложено' : 'Преглед';
        const modeClass = run.mode === 'apply' ? 'mode-pill apply' : 'mode-pill preview';
        const errCell = Number(run.errors) > 0 ? '<span class="cell-err">' + run.errors + '</span>' : run.errors;
        return '<tr>' +
          '<td class="cell-supplier">' + run.supplier + '</td>' +
          '<td><span class="' + modeClass + '">' + modeLabel + '</span></td>' +
          '<td class="num">' + run.updated + '</td>' +
          '<td class="num">' + run.skipped + '</td>' +
          '<td class="num">' + errCell + '</td>' +
          '<td class="cell-date">' + formatDate(run.finishedAt) + '</td>' +
        '</tr>';
      }).join('');
    }

    function showRecentSkeleton() {
      let rows = '';
      for (let i = 0; i < 3; i++) {
        rows += '<tr>' +
          '<td><span class="skel" style="width:60%"></span></td>' +
          '<td><span class="skel" style="width:50%"></span></td>' +
          '<td class="num"><span class="skel" style="width:40%"></span></td>' +
          '<td class="num"><span class="skel" style="width:40%"></span></td>' +
          '<td class="num"><span class="skel" style="width:40%"></span></td>' +
          '<td><span class="skel" style="width:70%"></span></td>' +
        '</tr>';
      }
      recentRunsEl.innerHTML = rows;
    }

    function updateCardsFromRecentRuns(runs) {
      const seen = new Set();
      for (const run of runs || []) {
        const dedupeKey = (run.target || 'shopify') + ':' + run.supplierKey;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        updateSupplierLastResult({
          target: run.target,
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
      try {
        const res = await fetch('/api/runs', { credentials: 'same-origin' });
        if (res.status === 401) { window.location.href = '/'; return; }
        const data = await res.json();
        renderRecentRuns(data.runs || []);
        updateCardsFromRecentRuns(data.runs || []);
      } catch (e) {
        recentRunsEl.innerHTML = '<tr><td class="empty-cell" colspan="6"><strong>Историята не можа да се зареди</strong><span>Опитайте да натиснете „Обнови“.</span></td></tr>';
      }
    }

    // Branded confirmation dialog. Returns a promise resolving true/false.
    // Preserves the original apply gating (no apply runs without an explicit confirm).
    function confirmApply(target, supplierKey) {
      const name = SUPPLIER_NAMES[supplierKey] || supplierKey;
      if (target === 'b2bcenter') {
        modalTitle.textContent = 'Синхронизация към портала?';
        modalBody.textContent = 'Ще бъдат обновени количествата в портала B2BCenter за ' + name + '.';
        modalPoints.innerHTML =
          '<li class="will">Обновява само наличните количества на артикулите</li>' +
          '<li class="wont">Не променя цени, имена, категории, снимки или видимост</li>';
      } else {
        modalTitle.textContent = 'Да приложа ли синхронизацията?';
        modalBody.textContent = 'Ще бъдат обновени складовите количества в онлайн магазина (Shopify) за ' + name + '.';
        modalPoints.innerHTML =
          '<li class="will">Обновява наличните количества на продуктите</li>' +
          '<li class="wont">Не променя цени, имена, категории или снимки</li>';
      }
      modalHint.textContent = 'Уверете се, че първо сте направили „Преглед“ и числата са очаквани.';
      modal.hidden = false;

      return new Promise((resolve) => {
        function cleanup(value) {
          modal.hidden = true;
          modalOk.removeEventListener('click', onOk);
          modalCancel.removeEventListener('click', onCancel);
          modal.removeEventListener('click', onBackdrop);
          document.removeEventListener('keydown', onKey);
          resolve(value);
        }
        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }
        function onBackdrop(e) { if (e.target === modal) cleanup(false); }
        function onKey(e) { if (e.key === 'Escape') cleanup(false); }
        modalOk.addEventListener('click', onOk);
        modalCancel.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
        modalOk.focus();
      });
    }

    async function refreshStatus() {
      try {
        const res = await fetch('/api/status', { credentials: 'same-origin' });
        if (res.status === 401) { window.location.href = '/'; return false; }
        const data = await res.json();
        const running = Boolean(data.running);
        if (!localRunning) setButtonsDisabled(running);
        if (running && data.run) {
          const dry = data.run.dryRun;
          setStatus('Изпълнява се…', 'running');
          setPanelTone('running');
          showProgress(true, dry ? 'Изготвя се преглед на промените…' : 'Промените се прилагат…');
          setRunningCard(data.run.target, data.run.supplierKey);
          if (data.run.logs) setLogs(data.run.logs);
          if (data.run.summary) renderResult(data.run.summary);
        } else if (!localRunning) {
          showProgress(false);
          clearRunningCards();
          if (statusState === 'running') setStatus('В готовност', 'idle');
        }
        return running;
      } catch (error) {
        if (!localRunning) setStatus('Грешка при връзката', 'error');
        return false;
      }
    }

    async function runSync(supplierKey, dryRun, target) {
      if (localRunning) return;
      const runTarget = target === 'b2bcenter' ? 'b2bcenter' : 'shopify';
      const isApply = !dryRun;

      if (isApply) {
        const confirmed = await confirmApply(runTarget, supplierKey);
        if (!confirmed) return;
      }

      const payload = { target: runTarget, supplierKey, dryRun };
      if (runTarget === 'b2bcenter' && isApply) {
        payload.confirm = true;
        payload.allowLargeApply = true;
      }

      const name = SUPPLIER_NAMES[supplierKey] || supplierKey;
      localRunning = true;
      setButtonsDisabled(true);
      setPanelTone('running');
      setStatus('Изпълнява се…', 'running');
      showEmptyResult();
      showProgress(true, (isApply ? 'Прилагат се промените за ' : 'Изготвя се преглед за ') + name + '…');
      setRunningCard(runTarget, supplierKey);
      setLogs(['Стартиране на ' + name + (isApply ? ' — синхронизация…' : ' — преглед…')]);

      try {
        const res = await fetch('/api/sync', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        showProgress(false);
        if (!res.ok) {
          setStatus('Неуспешно', 'error');
          showErrorResult(data.error, data.logs);
          if (data.summary) renderResult(data.summary);
          return;
        }
        const hasErrors = data.summary.errors > 0;
        if (data.summary.dryRun) {
          setStatus(hasErrors ? 'Приключи с предупреждения' : 'Прегледът е готов', hasErrors ? 'warning' : 'success');
        } else {
          setStatus(hasErrors ? 'Приключи с предупреждения' : 'Синхронизацията приключи', hasErrors ? 'warning' : 'success');
        }
        setPanelTone(hasErrors ? 'warning' : 'success');
        renderResult(data.summary);
        setLogs(data.logs);
        updateSupplierLastResult(data.summary);
        await loadRecentRuns();
      } catch (error) {
        showProgress(false);
        setStatus('Неуспешно', 'error');
        showErrorResult(error.message, ['Заявката не бе изпълнена: ' + error.message]);
      } finally {
        localRunning = false;
        clearRunningCards();
        const stillRunning = await refreshStatus();
        setButtonsDisabled(Boolean(stillRunning));
      }
    }

    for (const button of runButtons) {
      button.addEventListener('click', () => {
        runSync(
          button.dataset.supplier,
          button.dataset.dryRun === 'true',
          button.dataset.target || 'shopify',
        );
      });
    }
    if (copyLogButton) {
      copyLogButton.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(logsEl.textContent || '');
          const original = copyLogButton.textContent;
          copyLogButton.textContent = 'Копирано';
          setTimeout(() => { copyLogButton.textContent = original; }, 1200);
        } catch (err) { /* clipboard unavailable */ }
      });
    }
    refreshRunsButton.addEventListener('click', loadRecentRuns);

    showEmptyResult();
    showRecentSkeleton();
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

  const rawBody = await readRequestBody(req);
  const password = extractPassword(req, rawBody);
  const envPassword = getDashboardPassword();

  console.log(`[login] bodyType=${typeof req.body} bodyLen=${rawBody.length} enteredLen=${password.length} envLen=${envPassword.length}`);

  if (password !== envPassword) {
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

  const target = payload?.target === 'b2bcenter' ? 'b2bcenter' : 'shopify';
  const supplierKey = payload?.supplierKey;
  const dryRun = payload?.dryRun === true;

  let b2bConfirm = false;
  let b2bAllowLargeApply = false;
  if (target === 'b2bcenter') {
    // supplierKey "all" is rejected here: B2BCENTER_SUPPLIERS has no "all" key.
    if (!Object.hasOwn(B2BCENTER_SUPPLIERS, supplierKey)) {
      sendJson(res, 400, { error: 'B2BCenter supplierKey must be "megapap" or "b2bmarkt".' });
      return;
    }
    if (!dryRun) {
      if (payload?.confirm !== true) {
        sendJson(res, 400, {
          error: 'B2BCenter apply requires confirm: true.',
        });
        return;
      }
      b2bConfirm = true;
      b2bAllowLargeApply = payload?.allowLargeApply === true;
    }
  } else if (!Object.hasOwn(SUPPLIERS, supplierKey)) {
    sendJson(res, 400, { error: 'supplierKey must be "megapap" or "b2bmarkt".' });
    return;
  }

  currentRun = {
    running: true,
    target,
    supplierKey,
    dryRun,
    logs: [],
    summary: null,
  };

  const previousLogDir = process.env.LOG_DIR;
  process.env.LOG_DIR = getRuntimeLogDir();

  try {
    const onLog = (line) => {
      currentRun.logs.push(line);
    };
    const result =
      target === 'b2bcenter'
        ? await runB2BCenterSync({
            supplierKey,
            dryRun,
            confirm: b2bConfirm,
            allowLargeApply: b2bAllowLargeApply,
            onLog,
          })
        : await runInventorySync({ supplierKey, dryRun, onLog });

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
          target: source.target || 'shopify',
          supplierKey: source.supplierKey,
          dryRun: source.dryRun,
          logs: source.logs,
          summary: source.summary,
        }
      : null,
  });
}

function handleHealth(_req, res, debugCtx = {}) {
  sendJson(res, 200, {
    ok: true,
    hasDashboardPassword: Boolean(getDashboardPassword()),
    nodeEnv: process.env.NODE_ENV || 'development',
    vercel: isVercelRuntime(),
    ...debugCtx,
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
  const rawUrl = req.url || '/';
  const host = req.headers.host || req.headers['x-forwarded-host'] || 'localhost';
  let url;
  try {
    url = new URL(rawUrl, `http://${host}`);
  } catch {
    url = new URL('/', 'http://localhost');
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    handleHealth(req, res, { rawUrl, pathname: url.pathname });
    return;
  }

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

  console.log(`[404] method=${req.method} rawUrl=${rawUrl} pathname=${url.pathname}`);
  sendJson(res, 404, { error: 'Not found' });
}
