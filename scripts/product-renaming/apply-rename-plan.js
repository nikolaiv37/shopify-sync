#!/usr/bin/env node
/**
 * Apply a rename plan to Shopify Admin API.
 *
 * Default mode is DRY-RUN. Real mutations only with --apply.
 *
 * Usage:
 *   node scripts/product-renaming/apply-rename-plan.js --plan=logs/product-renaming/rename-plan-*.json --dry-run --risk=low --limit=10
 *   node scripts/product-renaming/apply-rename-plan.js --plan=... --apply --risk=low --limit=5
 *   node scripts/product-renaming/apply-rename-plan.js --plan=... --apply --risk=low --include-medium --limit=20
 *
 * Safety rules:
 *   - High-risk items are NEVER applied.
 *   - --apply without --limit is refused.
 *   - --apply tries high-risk items -> refused.
 *   - Dry-run never mutates Shopify.
 *
 * Mutations:
 *   - title
 *   - seo.title (if newSeoTitle exists)
 *   - seo.description (if newSeoDescription exists)
 *   - descriptionHtml (only if descriptionReplacement exists, case-insensitive replace)
 *
 * Does NOT mutate:
 *   - handle, SKU, vendor, productType, tags, variants, price, inventory, images, status, collections
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2025-10',
  LOG_DIR = './logs',
} = process.env;

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error(
    'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in .env',
  );
  process.exit(1);
}

const ENDPOINT = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
const TOKEN_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;

let ACCESS_TOKEN = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  console.log(`[${nowIso()}] ${line}`);
}

async function fetchAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SHOPIFY_CLIENT_ID,
    client_secret: SHOPIFY_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Access-token request failed: HTTP ${res.status} ${text.slice(0, 400)}`,
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Access-token response not JSON: ${text.slice(0, 400)}`);
  }
  if (!json.access_token) {
    throw new Error(`Access-token response missing access_token: ${text.slice(0, 400)}`);
  }
  log(`Access token acquired (scopes: ${json.scope || '(none)'}, expires in ${json.expires_in || '?'}s)`);
  return json.access_token;
}

async function gql(query, variables = {}) {
  if (!ACCESS_TOKEN) throw new Error('gql() called before token acquired');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 400)}`);
  }
  if (json.errors) {
    const msg = JSON.stringify(json.errors);
    const err = new Error(`GraphQL errors: ${msg.slice(0, 800)}`);
    err.isSchemaError = msg.includes("Field ") && msg.includes("doesn't exist on type");
    throw err;
  }
  return json.data;
}

async function gqlWithRetry(query, variables, label, maxTries = 4) {
  let attempt = 0;
  for (;;) {
    try {
      return await gql(query, variables);
    } catch (e) {
      if (e.isSchemaError) throw e;
      attempt++;
      if (attempt > maxTries) throw e;
      const wait = e.message?.includes('THROTTLED') || e.message?.includes('rate limit')
        ? 5000
        : Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.warn(
        `[${label}] ${e.message?.includes('THROTTLED') ? 'THROTTLED' : 'ERROR'} (try ${attempt}/${maxTries}), sleeping ${wait}ms: ${String(e.message).slice(0, 180)}`,
      );
      await sleep(wait);
    }
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    plan: null,
    apply: false,
    dryRun: false,
    risk: 'low',
    includeMedium: false,
    limit: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--plan=')) opts.plan = a.slice('--plan='.length);
    else if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--risk=')) opts.risk = a.slice('--risk='.length);
    else if (a === '--include-medium') opts.includeMedium = true;
    else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a === '--limit') {
      const v = Number.parseInt(args[++i], 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    }
  }

  return opts;
}

function escapeModelNameForRegex(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyDescriptionReplacement(descriptionHtml, descriptionReplacement) {
  if (!descriptionHtml || !descriptionReplacement) return descriptionHtml;
  const { from, to } = descriptionReplacement;
  const escaped = escapeModelNameForRegex(from);
  const regex = new RegExp(escaped, 'gi');
  const count = (descriptionHtml.match(regex) || []).length;
  if (count === 0 || count > 20) return descriptionHtml;
  return descriptionHtml.replace(regex, to);
}

async function updateProduct(productId, newTitle, newSeoTitle, newSeoDescription, newDescriptionHtml) {
  const input = { id: productId, title: newTitle };

  if (newSeoTitle !== undefined && newSeoTitle !== null) {
    input.seo = input.seo || {};
    input.seo.title = newSeoTitle;
  }
  if (newSeoDescription !== undefined && newSeoDescription !== null) {
    input.seo = input.seo || {};
    input.seo.description = newSeoDescription;
  }

  const mutation = `mutation productUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        title
        handle
        seo { title description }
      }
      userErrors {
        field
        message
      }
    }
  }`;

  const data = await gqlWithRetry(mutation, { input }, `update ${productId.slice(-10)}`);

  if (newDescriptionHtml) {
    const descMutation = `mutation productUpdateDescription($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id descriptionHtml }
        userErrors { field message }
      }
    }`;
    await gqlWithRetry(
      descMutation,
      { input: { id: productId, descriptionHtml: newDescriptionHtml } },
      `update-desc ${productId.slice(-10)}`,
    );
  }

  return data.productUpdate;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.plan) {
    console.error('ERROR: --plan is required. Path to rename plan JSON.');
    process.exit(1);
  }

  if (opts.apply && !opts.dryRun) {
    if (!opts.limit) {
      console.error('ERROR: --apply requires --limit. Example: --apply --limit=5');
      process.exit(1);
    }
  }

  const mode = opts.apply ? 'APPLY' : 'DRY';
  log(`Mode: ${mode}`);
  log(`Plan: ${opts.plan}`);
  log(`Risk filter: ${opts.risk}${opts.includeMedium ? ' + medium' : ''}`);
  if (opts.limit) log(`Limit: ${opts.limit}`);

  const rawData = JSON.parse(await fs.readFile(opts.plan, 'utf-8'));
  const plan = rawData.plan || rawData;

  if (!Array.isArray(plan)) {
    console.error('ERROR: Plan JSON must contain a "plan" array or be an array.');
    process.exit(1);
  }

  const allowedRisks = new Set([opts.risk]);
  if (opts.includeMedium) allowedRisks.add('medium');

  const selectedItems = [];
  const skippedItems = [];
  const highRiskItems = [];

  for (const item of plan) {
    if (item.risk === 'high') {
      highRiskItems.push(item);
      skippedItems.push({
        ...item,
        selected: false,
        skippedReason: 'high-risk items are never applied',
      });
      continue;
    }

    if (!allowedRisks.has(item.risk)) {
      skippedItems.push({
        ...item,
        selected: false,
        skippedReason: `risk "${item.risk}" not in filter (${opts.risk}${opts.includeMedium ? '+medium' : ''})`,
      });
      continue;
    }

    selectedItems.push(item);
  }

  if (highRiskItems.length > 0 && opts.apply) {
    console.error(`ERROR: Plan contains ${highRiskItems.length} high-risk items. High-risk items are NEVER applied.`);
    console.error('Remove high-risk items from plan or fix them before applying.');
    process.exit(1);
  }

  if (opts.limit && opts.apply) {
    selectedItems.length = Math.min(selectedItems.length, opts.limit);
  }

  if (selectedItems.length === 0) {
    log('No items selected for apply. Exiting cleanly.');
    process.exit(0);
  }

  log(`Selected: ${selectedItems.length} items`);
  log(`Skipped:  ${skippedItems.length} items`);
  log(`High-risk (blocked): ${highRiskItems.length} items`);

  if (mode === 'APPLY') {
    ACCESS_TOKEN = await fetchAccessToken();
  }

  const renameBatchId = `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const applyLog = [];
  const rollbackData = [];

  for (const item of selectedItems) {
    let newDescriptionHtml = null;
    if (item.descriptionReplacement && item.descriptionReplacement.from) {
      newDescriptionHtml = applyDescriptionReplacement(
        item.oldDescriptionHtml || '',
        item.descriptionReplacement,
      );
      if (newDescriptionHtml === item.oldDescriptionHtml) {
        newDescriptionHtml = null;
      }
    }

    const logEntry = {
      renameBatchId,
      planPath: opts.plan,
      productId: item.productId,
      handle: item.handle,
      risk: item.risk,
      selected: true,
      skippedReason: null,
      oldTitle: item.oldTitle,
      newTitle: item.newTitle,
      oldSeoTitle: item.oldSeoTitle,
      newSeoTitle: item.newSeoTitle,
      oldSeoDescription: item.oldSeoDescription,
      newSeoDescription: item.newSeoDescription,
      descriptionReplacement: item.descriptionReplacement,
      oldDescriptionHtml: item.oldDescriptionHtml || null,
      newDescriptionHtml,
      mode: mode.toLowerCase(),
      mutationStatus: 'dry-selected',
      userErrors: null,
      appliedAt: null,
    };

    if (mode === 'DRY') {
      applyLog.push(logEntry);
      continue;
    }

    try {
      const result = await updateProduct(
        item.productId,
        item.newTitle,
        item.newSeoTitle,
        item.newSeoDescription,
        newDescriptionHtml,
      );

      const userErrors = result.userErrors || [];
      if (userErrors.length > 0) {
        logEntry.mutationStatus = 'failed';
        logEntry.userErrors = userErrors;
        log(`FAILED ${item.handle}: ${JSON.stringify(userErrors)}`);
      } else {
        logEntry.mutationStatus = 'success';
        logEntry.appliedAt = nowIso();
        log(`OK ${item.handle}: "${item.newTitle.slice(0, 50)}..."`);

        rollbackData.push({
          productId: item.productId,
          handle: item.handle,
          oldTitle: item.oldTitle,
          oldSeoTitle: item.oldSeoTitle,
          oldSeoDescription: item.oldSeoDescription,
          oldDescriptionHtml: item.oldDescriptionHtml || null,
        });
      }
    } catch (e) {
      logEntry.mutationStatus = 'failed';
      logEntry.userErrors = [{ message: String(e.message).slice(0, 500) }];
      log(`ERROR ${item.handle}: ${e.message.slice(0, 200)}`);
    }

    applyLog.push(logEntry);

    if (opts.limit && applyLog.filter((e) => e.mutationStatus === 'success').length >= opts.limit) {
      break;
    }

    await sleep(300);
  }

  for (const item of skippedItems) {
    applyLog.push({
      renameBatchId,
      planPath: opts.plan,
      productId: item.productId,
      handle: item.handle,
      risk: item.risk,
      selected: false,
      skippedReason: item.skippedReason,
      oldTitle: item.oldTitle,
      newTitle: item.newTitle,
      oldSeoTitle: item.oldSeoTitle,
      newSeoTitle: item.newSeoTitle,
      oldSeoDescription: item.oldSeoDescription,
      newSeoDescription: item.newSeoDescription,
      descriptionReplacement: item.descriptionReplacement,
      oldDescriptionHtml: item.oldDescriptionHtml || null,
      newDescriptionHtml: null,
      mode: mode.toLowerCase(),
      mutationStatus: 'skipped',
      userErrors: null,
      appliedAt: null,
    });
  }

  const outDir = path.join(LOG_DIR, 'product-renaming');
  await fs.mkdir(outDir, { recursive: true });

  const applyLogPath = path.join(outDir, `apply-rename-${renameBatchId}.json`);
  await fs.writeFile(applyLogPath, JSON.stringify({
    renameBatchId,
    planPath: opts.plan,
    mode: mode.toLowerCase(),
    timestamp: nowIso(),
    totalSelected: selectedItems.length,
    totalSkipped: skippedItems.length,
    totalHighRiskBlocked: highRiskItems.length,
    results: applyLog,
  }, null, 2));

  log(`Apply log: ${applyLogPath}`);

  if (mode === 'APPLY' && rollbackData.length > 0) {
    const rollbackPath = path.join(outDir, `rollback-${renameBatchId}.json`);
    await fs.writeFile(rollbackPath, JSON.stringify({
      renameBatchId,
      timestamp: nowIso(),
      rollbackItems: rollbackData,
    }, null, 2));
    log(`Rollback file: ${rollbackPath}`);
  }

  const successCount = applyLog.filter((e) => e.mutationStatus === 'success').length;
  const failedCount = applyLog.filter((e) => e.mutationStatus === 'failed').length;
  const dryCount = applyLog.filter((e) => e.mutationStatus === 'dry-selected').length;
  const skipCount = applyLog.filter((e) => e.mutationStatus === 'skipped').length;

  console.log();
  console.log('========== Apply Summary ==========');
  console.log(`Mode:            ${mode}`);
  console.log(`Selected:        ${selectedItems.length}`);
  console.log(`Success:         ${successCount}`);
  console.log(`Failed:          ${failedCount}`);
  console.log(`Dry-run (log):   ${dryCount}`);
  console.log(`Skipped:         ${skipCount}`);
  console.log(`High blocked:    ${highRiskItems.length}`);
  console.log(`Log file:        ${applyLogPath}`);
  if (mode === 'APPLY' && rollbackData.length > 0) {
    console.log(`Rollback file:   ${path.join(outDir, `rollback-${renameBatchId}.json`)}`);
  }
  console.log('===================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
