#!/usr/bin/env tsx
/**
 * Apply Shopify URL redirects from a GSC 404 audit's redirects-ready.csv.
 *
 * SAFE BY DESIGN:
 *   - Dry-run is the DEFAULT. Nothing is written unless --apply is passed.
 *   - Idempotent: an existing redirect with the same target is skipped.
 *   - Never deletes or overwrites: an existing redirect with a different
 *     target is reported as a conflict and left untouched.
 *   - Sequential writes (--concurrency=1) to stay well under API limits.
 *
 * Usage:
 *   npm run seo:gsc404:apply:dry -- --input=logs/gsc-404-redirect-audit/<ts>/redirects-ready.csv
 *   npm run seo:gsc404:apply     -- --input=logs/gsc-404-redirect-audit/<ts>/redirects-ready.csv
 *   (optional) --limit=N
 *
 * Env (reused from the rest of the repo, see .env.example):
 *   SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
 *   SHOPIFY_API_VERSION (optional, defaults to 2025-10)
 *
 * REQUIRED ADMIN API SCOPES on the custom app for URL redirects:
 *   read_online_store_navigation, write_online_store_navigation
 * (In some Shopify versions these are surfaced as read_url_redirects /
 * write_url_redirects. Whichever your app shows under "Online Store" / URL
 * redirects is the one to enable.) Run `--check-access` to see exactly which
 * app this repo's credentials resolve to and which scopes it currently has.
 */

import 'dotenv/config';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  input: string | null;
  apply: boolean;
  limit: number | null;
  concurrency: number;
  checkAccess: boolean;
}

const USAGE = `
GSC 404 redirect apply — creates Shopify URL redirects from an audit CSV.

Usage:
  tsx scripts/seo/apply-gsc-404-redirects.ts --input=<redirects-ready.csv> [options]
  tsx scripts/seo/apply-gsc-404-redirects.ts --check-access

Options:
  --input=PATH      Required (except with --check-access). Path to redirects-ready.csv.
  --dry-run         Default. Report what would happen; create nothing.
  --apply           Explicitly create redirects. Without this flag, dry-run.
  --limit=N         Process at most N rows (for testing).
  --concurrency=1   Sequential writes only (value is informational).
  --check-access    Print which app the credentials resolve to and its granted
                    scopes, then exit. Does not require --input.

URL redirects need the scope read_online_store_navigation / write_online_store_navigation
(shown as read_url_redirects / write_url_redirects in some Shopify versions).
`.trim();

function parseArgs(argv: string[]): Options {
  const opts: Options = { input: null, apply: false, limit: null, concurrency: 1, checkAccess: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--input=')) opts.input = a.slice('--input='.length);
    else if (a === '--apply') opts.apply = true;
    else if (a === '--check-access') opts.checkAccess = true;
    else if (a === '--dry-run') opts.apply = false;
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length)) || null;
    else if (a.startsWith('--concurrency=')) {
      const c = Number(a.slice('--concurrency='.length));
      if (c !== 1) {
        console.warn('WARNING: only --concurrency=1 (sequential) is supported; forcing 1.');
      }
      opts.concurrency = 1;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Shopify Admin GraphQL client (reuses the repo's client-credentials pattern)
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ExistingRedirect { id: string; path: string; target: string }

interface UrlRedirectsResponse {
  urlRedirects: { nodes: ExistingRedirect[] };
}

interface UrlRedirectCreateResponse {
  urlRedirectCreate: {
    urlRedirect: { id: string; path: string; target: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

function createShopifyClient() {
  const {
    SHOPIFY_STORE_DOMAIN,
    SHOPIFY_CLIENT_ID,
    SHOPIFY_CLIENT_SECRET,
    SHOPIFY_API_VERSION = '2025-10',
  } = process.env;
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in .env');
  }
  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const tokenUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;
  let accessToken: string | null = null;

  async function ensureToken(): Promise<void> {
    if (accessToken) return;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SHOPIFY_CLIENT_ID!,
        client_secret: SHOPIFY_CLIENT_SECRET!,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Access-token request failed: HTTP ${res.status} ${text.slice(0, 400)}`);
    const json = JSON.parse(text);
    if (!json.access_token) throw new Error(`Access-token response missing access_token: ${text.slice(0, 400)}`);
    accessToken = json.access_token as string;
  }

  async function gql<T>(query: string, variables: Record<string, unknown>, label: string): Promise<T> {
    await ensureToken();
    const maxTries = 6;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken!,
            Accept: 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`);
        const json = JSON.parse(text);
        if (json.errors) {
          const errStr = JSON.stringify(json.errors);
          // Permission / schema errors are permanent — never retry them.
          if (/ACCESS_DENIED|Access denied|doesn't exist on type/i.test(errStr)) {
            const fatal = new Error(`GraphQL errors: ${errStr.slice(0, 600)}`);
            (fatal as Error & { fatal?: boolean }).fatal = true;
            throw fatal;
          }
          throw new Error(`GraphQL errors: ${errStr.slice(0, 600)}`);
        }
        return json.data as T;
      } catch (e) {
        if (e instanceof Error && (e as Error & { fatal?: boolean }).fatal) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt > maxTries) throw e;
        const throttled = msg.includes('THROTTLED') || msg.includes('rate limit') || msg.includes('HTTP 429');
        const wait = throttled ? 5000 : Math.min(1000 * 2 ** (attempt - 1), 15000);
        console.warn(`[${label}] retry ${attempt}/${maxTries} after ${wait}ms: ${msg.slice(0, 160)}`);
        await sleep(wait);
      }
    }
  }

  /** Find an existing redirect whose path exactly equals `sourcePath`, if any. */
  async function findRedirect(sourcePath: string): Promise<ExistingRedirect | null> {
    // The urlRedirects `query` arg does a fuzzy search; we still match exactly.
    const data = await gql<UrlRedirectsResponse>(
      `query findRedirect($q: String!) {
        urlRedirects(first: 50, query: $q) {
          nodes { id path target }
        }
      }`,
      { q: `path:${sourcePath}` },
      `find ${sourcePath}`,
    );
    return data.urlRedirects.nodes.find((n) => normalizePath(n.path) === normalizePath(sourcePath)) ?? null;
  }

  async function createRedirect(sourcePath: string, targetPath: string): Promise<{
    redirect: { id: string; path: string; target: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  }> {
    const data = await gql<UrlRedirectCreateResponse>(
      `mutation urlRedirectCreate($redirect: UrlRedirectInput!) {
        urlRedirectCreate(urlRedirect: $redirect) {
          urlRedirect { id path target }
          userErrors { field message }
        }
      }`,
      { redirect: { path: sourcePath, target: targetPath } },
      `create ${sourcePath}`,
    );
    return {
      redirect: data.urlRedirectCreate.urlRedirect,
      userErrors: data.urlRedirectCreate.userErrors,
    };
  }

  /**
   * Report which app these credentials resolve to and what scopes it has.
   * Uses gqlRaw so a missing scope shows up as data rather than a thrown error.
   */
  async function checkAccess(): Promise<AccessCheck> {
    const data = await gql<AccessCheckResponse>(
      `query accessCheck {
        currentAppInstallation {
          app { title apiKey }
          accessScopes { handle }
        }
        shop { name myshopifyDomain }
      }`,
      {},
      'access-check',
    );
    return {
      appTitle: data.currentAppInstallation?.app?.title ?? '(unknown)',
      appApiKey: data.currentAppInstallation?.app?.apiKey ?? '(unknown)',
      shopName: data.shop?.name ?? '(unknown)',
      shopDomain: data.shop?.myshopifyDomain ?? SHOPIFY_STORE_DOMAIN!,
      scopes: (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle).sort(),
    };
  }

  return { findRedirect, createRedirect, checkAccess, clientId: SHOPIFY_CLIENT_ID!, domain: SHOPIFY_STORE_DOMAIN };
}

interface AccessCheckResponse {
  currentAppInstallation: {
    app: { title: string; apiKey: string } | null;
    accessScopes: Array<{ handle: string }> | null;
  } | null;
  shop: { name: string; myshopifyDomain: string } | null;
}

interface AccessCheck {
  appTitle: string;
  appApiKey: string;
  shopName: string;
  shopDomain: string;
  scopes: string[];
}

/**
 * Scope pairs that grant urlRedirect read+write. Shopify surfaces this access
 * under the Online Store Navigation scopes; older apps may instead show it as
 * the legacy url_redirects pair. Either pair works for urlRedirect queries.
 */
const REDIRECT_SCOPE_PAIRS = [
  ['read_online_store_navigation', 'write_online_store_navigation'],
  ['read_url_redirects', 'write_url_redirects'],
];

async function runAccessCheck(client: ReturnType<typeof createShopifyClient>): Promise<void> {
  console.log('=== Shopify access check ===');
  console.log(`Credentials in .env:  SHOPIFY_CLIENT_ID=${client.clientId}`);
  console.log(`Store domain in .env: ${client.domain}`);
  console.log('');
  const info = await client.checkAccess();
  console.log(`Resolved app:   ${info.appTitle}  (apiKey ${info.appApiKey})`);
  console.log(`Resolved shop:  ${info.shopName}  (${info.shopDomain})`);
  console.log(`Granted scopes (${info.scopes.length}):`);
  for (const s of info.scopes) console.log(`  - ${s}`);
  console.log('');
  const grantedPair = REDIRECT_SCOPE_PAIRS.find(([r, w]) => info.scopes.includes(r) && info.scopes.includes(w));
  if (grantedPair) {
    console.log(`OK: this app HAS URL-redirect read+write scopes (${grantedPair.join(' + ')}).`);
    console.log('    The apply script can query and create urlRedirects.');
  } else {
    console.log('PROBLEM: this app is MISSING URL-redirect scopes.');
    console.log('  Enable one of these read+write pairs on the app, then re-release it:');
    for (const [r, w] of REDIRECT_SCOPE_PAIRS) console.log(`    ${r} + ${w}`);
    console.log(`  Then confirm the .env credentials (CLIENT_ID ${client.clientId}, app "${info.appTitle}")`);
    console.log('  belong to the SAME app you edit in Shopify admin.');
  }
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function csvCell(value: string | number): string {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path: string, header: string[], rows: Array<Record<string, string | number>>): void {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map((h) => csvCell(r[h] ?? '')).join(','));
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Path normalisation
// ---------------------------------------------------------------------------

/**
 * Canonical form of a URL path for equality checks only. Shopify may store a
 * redirect target with percent-encoded Cyrillic (/collections/%D0%BF%D0...)
 * while the audit CSV carries the decoded form (/collections/помощни-маси) —
 * these are the SAME URL. We decode each segment, apply Unicode NFC, and drop
 * a trailing slash. The ORIGINAL (un-normalised) path is still used when
 * actually creating a redirect; this is purely for comparison.
 */
function normalizePath(p: string): string {
  const decoded = p.trim().split('/').map((seg) => {
    try { return decodeURIComponent(seg); } catch { return seg; }
  }).join('/');
  return decoded.normalize('NFC').replace(/\/+$/, '') || '/';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_SOURCE_PREFIXES = ['/product/', '/category/', '/article/', '/vendor/', '/selection/'];
const VALID_TARGET_PREFIXES = ['/products/', '/collections/', '/blogs/', '/pages/'];

function validSource(path: string): boolean {
  return VALID_SOURCE_PREFIXES.some((p) => path.startsWith(p));
}
function validTarget(path: string): boolean {
  return path === '/' || VALID_TARGET_PREFIXES.some((p) => path.startsWith(p));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface ReadyRow {
  sourcePath: string;
  targetPath: string;
  targetType: string;
  matchConfidence: string;
  matchReason: string;
  shopifyId: string;
  shopifyTitle: string;
  shopifyHandle: string;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  // --check-access is a standalone diagnostic: no CSV required.
  if (opts.checkAccess) {
    await runAccessCheck(createShopifyClient());
    return;
  }

  if (!opts.input) {
    console.error(USAGE);
    console.error('\nERROR: --input=<redirects-ready.csv> is required.');
    process.exit(1);
  }
  if (!existsSync(opts.input)) {
    console.error(USAGE);
    console.error(`\nERROR: input file not found: ${opts.input}`);
    process.exit(1);
  }

  const startedAt = new Date();
  const mode = opts.apply ? 'APPLY' : 'DRY-RUN';
  console.log(`=== GSC 404 redirect apply — ${mode} ===`);
  console.log(`Input: ${opts.input}`);
  if (!opts.apply) console.log('Mode:  dry-run (default) — no redirects will be created. Pass --apply to write.');
  console.log('');

  // --- Parse CSV -----------------------------------------------------------
  const rows = parseCsv(readFileSync(opts.input, 'utf8'));
  if (rows.length < 2) throw new Error(`No data rows in ${opts.input}`);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name);
  const iSource = col('source_path');
  const iTarget = col('target_path');
  if (iSource === -1 || iTarget === -1) {
    throw new Error(`CSV missing source_path/target_path columns. Found: ${header.join(', ')}`);
  }
  const iType = col('target_type');
  const iConf = col('match_confidence');
  const iReason = col('match_reason');
  const iId = col('shopify_id');
  const iTitle = col('shopify_title');
  const iHandle = col('shopify_handle');
  const cell = (r: string[], idx: number): string => (idx >= 0 ? (r[idx] || '').trim() : '');

  let dataRows = rows.slice(1);
  if (opts.limit !== null) dataRows = dataRows.slice(0, opts.limit);

  const applied: Array<Record<string, string | number>> = [];
  const skipped: Array<Record<string, string | number>> = [];
  const conflicts: Array<Record<string, string | number>> = [];
  const errors: Array<Record<string, string | number>> = [];

  const client = createShopifyClient();
  console.log(`Shop: ${client.domain}`);
  console.log(`Rows to process: ${dataRows.length}`);
  console.log('');

  // --- Process rows sequentially ------------------------------------------
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const row: ReadyRow = {
      sourcePath: cell(r, iSource),
      targetPath: cell(r, iTarget),
      targetType: cell(r, iType),
      matchConfidence: cell(r, iConf),
      matchReason: cell(r, iReason),
      shopifyId: cell(r, iId),
      shopifyTitle: cell(r, iTitle),
      shopifyHandle: cell(r, iHandle),
    };
    const tag = `[${i + 1}/${dataRows.length}]`;

    // Rule 5: skip missing source/target.
    if (!row.sourcePath || !row.targetPath) {
      skipped.push({ source_path: row.sourcePath, target_path: row.targetPath, reason: 'missing_source_or_target' });
      console.log(`${tag} SKIP missing source/target`);
      continue;
    }
    // Rule 6: skip source === target.
    if (row.sourcePath === row.targetPath) {
      skipped.push({ source_path: row.sourcePath, target_path: row.targetPath, reason: 'source_equals_target' });
      console.log(`${tag} SKIP ${row.sourcePath} (source equals target)`);
      continue;
    }
    // Rule 3: validate source prefix.
    if (!validSource(row.sourcePath)) {
      skipped.push({ source_path: row.sourcePath, target_path: row.targetPath, reason: 'invalid_source_prefix' });
      console.log(`${tag} SKIP ${row.sourcePath} (invalid source prefix)`);
      continue;
    }
    // Rule 4: validate target prefix.
    if (!validTarget(row.targetPath)) {
      skipped.push({ source_path: row.sourcePath, target_path: row.targetPath, reason: 'invalid_target_prefix' });
      console.log(`${tag} SKIP ${row.sourcePath} -> ${row.targetPath} (invalid target prefix)`);
      continue;
    }

    try {
      // Rule 7: check for an existing redirect on this path.
      const existing = await client.findRedirect(row.sourcePath);

      if (existing) {
        // Compare via normalized paths: percent-encoded Cyrillic and decoded
        // Cyrillic are the same URL and must count as skip_existing_same.
        if (normalizePath(existing.target) === normalizePath(row.targetPath)) {
          // Rule 8: already correct — idempotent skip.
          skipped.push({
            source_path: row.sourcePath,
            target_path: row.targetPath,
            reason: 'skip_existing_same',
          });
          console.log(`${tag} SKIP ${row.sourcePath} (already redirects to ${row.targetPath})`);
        } else {
          // Rule 9 + 11: different target — conflict, never overwrite.
          conflicts.push({
            source_path: row.sourcePath,
            desired_target_path: row.targetPath,
            existing_target_path: existing.target,
            existing_redirect_id: existing.id,
            status: 'conflict_existing_different',
          });
          console.log(`${tag} CONFLICT ${row.sourcePath} exists -> ${existing.target} (wanted ${row.targetPath})`);
        }
        await sleep(120);
        continue;
      }

      // Rule 10: no redirect exists — create it (or simulate in dry-run).
      if (!opts.apply) {
        applied.push({
          source_path: row.sourcePath,
          target_path: row.targetPath,
          target_type: row.targetType,
          status: 'would_create',
          redirect_id: '',
          match_confidence: row.matchConfidence,
          match_reason: row.matchReason,
          shopify_title: row.shopifyTitle,
        });
        console.log(`${tag} WOULD CREATE ${row.sourcePath} -> ${row.targetPath}`);
      } else {
        const result = await client.createRedirect(row.sourcePath, row.targetPath);
        if (result.userErrors.length > 0 || !result.redirect) {
          const msg = result.userErrors.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; ')
            || 'urlRedirectCreate returned no redirect';
          errors.push({ source_path: row.sourcePath, target_path: row.targetPath, error: msg });
          console.log(`${tag} ERROR ${row.sourcePath}: ${msg}`);
        } else {
          applied.push({
            source_path: row.sourcePath,
            target_path: row.targetPath,
            target_type: row.targetType,
            status: 'created',
            redirect_id: result.redirect.id,
            match_confidence: row.matchConfidence,
            match_reason: row.matchReason,
            shopify_title: row.shopifyTitle,
          });
          console.log(`${tag} CREATED ${row.sourcePath} -> ${row.targetPath}`);
        }
        await sleep(250);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ source_path: row.sourcePath, target_path: row.targetPath, error: msg.slice(0, 400) });
      console.log(`${tag} ERROR ${row.sourcePath}: ${msg.slice(0, 200)}`);
    }
  }

  // --- Write outputs -------------------------------------------------------
  const ts = startedAt.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const outDir = join('logs', 'gsc-404-redirect-apply', ts);
  mkdirSync(outDir, { recursive: true });

  writeCsv(join(outDir, 'applied.csv'),
    ['source_path', 'target_path', 'target_type', 'status', 'redirect_id',
      'match_confidence', 'match_reason', 'shopify_title'],
    applied);
  writeCsv(join(outDir, 'skipped.csv'),
    ['source_path', 'target_path', 'reason'],
    skipped);
  writeCsv(join(outDir, 'conflicts.csv'),
    ['source_path', 'desired_target_path', 'existing_target_path', 'existing_redirect_id', 'status'],
    conflicts);
  writeCsv(join(outDir, 'errors.csv'),
    ['source_path', 'target_path', 'error'],
    errors);

  const createdCount = applied.filter((a) => a.status === 'created').length;
  const wouldCreateCount = applied.filter((a) => a.status === 'would_create').length;
  const summary = {
    generatedAt: startedAt.toISOString(),
    mode: opts.apply ? 'apply' : 'dry-run',
    input: opts.input,
    shopDomain: client.domain,
    options: opts,
    totals: {
      rowsProcessed: dataRows.length,
      created: createdCount,
      wouldCreate: wouldCreateCount,
      skipped: skipped.length,
      conflicts: conflicts.length,
      errors: errors.length,
    },
    outputDir: outDir,
  };
  writeFileSync(join(outDir, 'apply-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  // --- Console summary -----------------------------------------------------
  console.log('');
  console.log(`=== ${mode} summary ===`);
  console.log(`Rows processed: ${dataRows.length}`);
  if (opts.apply) console.log(`Created:        ${createdCount}`);
  else console.log(`Would create:   ${wouldCreateCount}`);
  console.log(`Skipped:        ${skipped.length}`);
  console.log(`Conflicts:      ${conflicts.length}`);
  console.log(`Errors:         ${errors.length}`);
  console.log('');
  console.log(`Output written to: ${outDir}/`);
  console.log('  apply-summary.json  applied.csv  skipped.csv  conflicts.csv  errors.csv');
  if (!opts.apply) {
    console.log('');
    console.log('DRY-RUN complete. No redirects were created. Re-run with --apply to write them.');
  }
}

main().catch((e: unknown) => {
  console.error('FATAL:', e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
