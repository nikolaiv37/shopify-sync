#!/usr/bin/env node
/**
 * Supplier XML → Shopify inventory sync.
 *
 * Auth: mints a fresh Admin API access token at the start of every run via
 *   POST https://<shop>/admin/oauth/access_token  (grant_type=client_credentials)
 * using SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET from .env. The minted
 * token is kept only in memory; nothing long-lived is written to disk.
 *
 * Usage:
 *   node sync.js                       # runs all suppliers, applies updates
 *   node sync.js all
 *   node sync.js megapap
 *   node sync.js b2bmarkt
 *
 *   node sync.js --dry-run             # runs all suppliers, no writes
 *   node sync.js megapap --dry-run     # per-supplier dry-run
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

// ---------- Config ----------

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2025-10',
  SHOPIFY_LOCATION_ID,
  LOG_DIR = './logs',
  BATCH_SIZE = '50',
  MEGAPAP_FEED_URL,
  B2BMARKT_FEED_URL,
} = process.env;

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error(
    'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in .env',
  );
  process.exit(1);
}

const BATCH = Number.parseInt(BATCH_SIZE, 10) || 50;
const ENDPOINT = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
const TOKEN_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;

// Populated at runtime by fetchAccessToken(). Used by gql().
let ACCESS_TOKEN = null;

const SUPPLIERS = {
  megapap: {
    key: 'megapap',
    vendor: 'Mebelcenter',
    feedUrl:
      MEGAPAP_FEED_URL ||
      'https://www.megapap.com/?route=extension/feed/csxml_feed&token=Njk5TFAzMzU=&lang=en',
    productTag: 'product',
    skuTag: 'model',
    stockTag: 'quantity',
    referenceUri: 'logistics://megapap-xml-sync',
  },
  b2bmarkt: {
    key: 'b2bmarkt',
    vendor: 'Europe',
    feedUrl:
      B2BMARKT_FEED_URL ||
      'https://www.b2bmarkt.gr/feeds?key=24480YxsmxIsJNNHezInLuaTOhbYrWnYVluOPJIj5&act=1003&lang=2',
    productTag: 'Product',
    skuTag: 'ProductCode',
    stockTag: 'Stock',
    referenceUri: 'logistics://b2bmarkt-xml-sync',
  },
};

// ---------- Utilities ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  console.log(`[${nowIso()}] ${line}`);
}

// ---------- Shopify auth ----------

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
  const scopes = json.scope || '(none)';
  const ttl = json.expires_in ? `${json.expires_in}s` : 'unknown';
  log(`Access token acquired (scopes: ${scopes}, expires in ${ttl})`);
  return json.access_token;
}

// ---------- Shopify GraphQL ----------

async function gql(query, variables = {}) {
  if (!ACCESS_TOKEN) throw new Error('gql() called before access token was acquired');
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
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`);
    err.status = res.status;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 400)}`);
  }
  if (json.errors) {
    const msg = JSON.stringify(json.errors);
    const err = new Error(msg.slice(0, 800));
    err.throttled = msg.includes('THROTTLED');
    throw err;
  }
  return json.data;
}

async function gqlWithRetry(query, variables, label, maxTries = 6) {
  let attempt = 0;
  for (;;) {
    try {
      return await gql(query, variables);
    } catch (e) {
      attempt++;
      if (attempt > maxTries) throw e;
      const wait = e.throttled ? 5000 : Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.warn(
        `[${label}] ${e.throttled ? 'THROTTLED' : 'ERROR'} (try ${attempt}/${maxTries}), sleeping ${wait}ms: ${String(e.message).slice(0, 180)}`,
      );
      await sleep(wait);
    }
  }
}

// ---------- XML ----------

async function fetchXml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'mebelcenter-supplier-sync/1.0' },
  });
  if (!res.ok) throw new Error(`XML fetch ${res.status} ${res.statusText} (${url})`);
  return res.text();
}

function extractText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return extractText(val[0]);
  if (typeof val === 'object') {
    // fast-xml-parser places CDATA / text in known props depending on options.
    return extractText(val['#text'] ?? val.__cdata ?? '');
  }
  return String(val).trim();
}

function findProductArray(node, productTag) {
  if (!node || typeof node !== 'object') return null;
  for (const key of Object.keys(node)) {
    if (key === productTag) {
      const v = node[key];
      return Array.isArray(v) ? v : [v];
    }
    const found = findProductArray(node[key], productTag);
    if (found) return found;
  }
  return null;
}

function parseSupplierFeed(xmlText, { productTag, skuTag, stockTag }) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, productTag);
  if (!products) throw new Error(`Could not find <${productTag}> elements in XML`);

  const map = new Map();
  let dupes = 0;
  for (const p of products) {
    const sku = extractText(p?.[skuTag]);
    if (!sku) continue;
    const rawStock = extractText(p?.[stockTag]);
    const stock = Number.parseInt(rawStock, 10);
    const qty = Number.isFinite(stock) ? stock : 0;
    if (map.has(sku)) dupes++;
    map.set(sku, qty);
  }
  return { map, dupes, rawCount: products.length };
}

// ---------- Shopify inventory ops ----------

async function discoverLocationId() {
  if (SHOPIFY_LOCATION_ID) return SHOPIFY_LOCATION_ID;
  const data = await gqlWithRetry(
    `query locations {
      locations(first: 20) {
        nodes { id name isActive fulfillsOnlineOrders }
      }
    }`,
    {},
    'locations',
  );
  const active = data.locations.nodes.filter((l) => l.isActive);
  if (active.length === 0) throw new Error('No active Shopify locations found');
  const primary = active.find((l) => l.fulfillsOnlineOrders) || active[0];
  log(`Using location ${primary.name} (${primary.id})`);
  return primary.id;
}

async function fetchVendorProductIds(vendor) {
  const ids = new Set();
  let cursor = null;
  let page = 0;
  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query vendorProducts($cursor: String, $q: String!) {
        products(first: 250, after: $cursor, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes { id vendor }
        }
      }`,
      { cursor, q: `vendor:${vendor}` },
      `vendor:${vendor} page ${page}`,
    );
    for (const p of data.products.nodes) {
      // Shopify's vendor search can be fuzzy; enforce exact match defensively.
      if (p.vendor === vendor) ids.add(p.id);
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
    await sleep(150);
  }
  log(`vendor "${vendor}": ${ids.size} products`);
  return ids;
}

async function fetchAllVariants() {
  const variants = [];
  let cursor = null;
  let page = 0;
  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query allVariants($cursor: String) {
        productVariants(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            inventoryQuantity
            inventoryItem { id tracked }
            product { id }
          }
        }
      }`,
      { cursor },
      `variants page ${page}`,
    );
    for (const v of data.productVariants.nodes) {
      const sku = v.sku?.trim();
      if (!sku || !v.inventoryItem?.id) continue;
      variants.push({
        variantId: v.id,
        productId: v.product.id,
        sku,
        tracked: !!v.inventoryItem.tracked,
        currentQty: v.inventoryQuantity ?? 0,
        inventoryItemId: v.inventoryItem.id,
      });
    }
    if (page % 10 === 0) log(`variants fetched: ${variants.length}`);
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
    await sleep(150);
  }
  log(`variants total: ${variants.length}`);
  return variants;
}

async function applyInventoryUpdates({ locationId, plan, referenceUri, runId }) {
  const mutation = `
    mutation setInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message code }
        inventoryAdjustmentGroup { id reason }
      }
    }`;

  let ok = 0;
  let errors = 0;
  const errorDetail = [];
  const totalBatches = Math.ceil(plan.length / BATCH);

  for (let i = 0; i < plan.length; i += BATCH) {
    const batch = plan.slice(i, i + BATCH);
    const input = {
      name: 'available',
      reason: 'correction',
      referenceDocumentUri: referenceUri,
      quantities: batch.map((row) => ({
        inventoryItemId: row.inventoryItemId,
        locationId,
        quantity: row.newQty,
        compareQuantity: row.currentQty,
      })),
    };
    const variables = { input };

    const batchNo = i / BATCH + 1;
    try {
      const data = await gqlWithRetry(mutation, variables, `apply batch ${batchNo}/${totalBatches}`);
      const userErrors = data.inventorySetQuantities?.userErrors || [];
      ok += batch.length - userErrors.length;
      errors += userErrors.length;
      if (userErrors.length) {
        errorDetail.push({ batchStart: i, userErrors });
      }
    } catch (e) {
      errors += batch.length;
      errorDetail.push({ batchStart: i, error: String(e.message).slice(0, 800) });
    }

    log(
      `[apply ${batchNo}/${totalBatches}] processed ${Math.min(i + BATCH, plan.length)}/${plan.length} | ok=${ok} | err=${errors}`,
    );
    await sleep(250);
  }

  return { ok, errors, errorDetail };
}

// ---------- Orchestration ----------

async function runSupplier(supplierKey, { dryRun = false } = {}) {
  const supplier = SUPPLIERS[supplierKey];
  if (!supplier) throw new Error(`Unknown supplier key: ${supplierKey}`);

  const startedAt = new Date();
  const runId = `${supplier.key}${dryRun ? '-DRYRUN' : ''}-${startedAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19)}`;

  log(`=== ${supplier.key} (vendor="${supplier.vendor}")${dryRun ? '  [DRY RUN]' : ''} ===`);

  log('Step 1/5  Fetching supplier XML feed…');
  const xmlText = await fetchXml(supplier.feedUrl);
  log(`  received ${(xmlText.length / 1024 / 1024).toFixed(2)} MB`);

  log('Step 2/5  Parsing XML…');
  const { map: supplierMap, dupes, rawCount } = parseSupplierFeed(xmlText, supplier);
  log(
    `  parsed ${rawCount} <${supplier.productTag}> entries → ${supplierMap.size} unique SKUs (dupes collapsed: ${dupes})`,
  );

  log(`Step 3/5  Fetching vendor product IDs + all variants…`);
  const [vendorIds, allVariants, locationId] = await Promise.all([
    fetchVendorProductIds(supplier.vendor),
    fetchAllVariants(),
    discoverLocationId(),
  ]);

  log('Step 4/5  Building update plan…');
  const vendorVariants = allVariants.filter((v) => vendorIds.has(v.productId));
  const plan = [];
  let notInXml = 0;
  let untracked = 0;
  let unchanged = 0;
  for (const v of vendorVariants) {
    const newQty = supplierMap.get(v.sku);
    if (newQty === undefined) {
      notInXml++;
      continue;
    }
    if (!v.tracked) {
      untracked++;
      continue;
    }
    if (v.currentQty === newQty) {
      unchanged++;
      continue;
    }
    plan.push({ ...v, newQty, delta: newQty - v.currentQty });
  }
  log(
    `  vendor variants: ${vendorVariants.length} | planned updates: ${plan.length} | unchanged: ${unchanged} | not in XML: ${notInXml} | untracked: ${untracked}`,
  );

  let applyResult;
  if (dryRun) {
    log(`Step 5/5  DRY RUN — skipping ${plan.length} write(s). No changes made.`);
    applyResult = { ok: 0, errors: 0, errorDetail: [], skipped: true };

    // Also print the first few planned rows so a dry-run is immediately useful.
    const preview = plan.slice(0, 10);
    if (preview.length) {
      log('Plan preview (first 10 rows):');
      for (const r of preview) {
        console.log(
          `  ${r.sku.padEnd(12)} ${String(r.currentQty).padStart(6)} -> ${String(r.newQty).padStart(6)}  (${r.delta >= 0 ? '+' : ''}${r.delta})`,
        );
      }
    }
  } else {
    log(`Step 5/5  Applying ${plan.length} updates (batches of ${BATCH})…`);
    applyResult =
      plan.length === 0
        ? { ok: 0, errors: 0, errorDetail: [] }
        : await applyInventoryUpdates({
            locationId,
            plan,
            referenceUri: supplier.referenceUri,
            runId,
          });
  }

  const finishedAt = new Date();
  const summary = {
    date: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedSeconds: Number(((finishedAt - startedAt) / 1000).toFixed(1)),
    dryRun,
    supplier: supplier.key,
    vendor: supplier.vendor,
    storeDomain: SHOPIFY_STORE_DOMAIN,
    apiVersion: SHOPIFY_API_VERSION,
    locationId,
    feedUrl: supplier.feedUrl,
    counts: {
      supplierSkus: supplierMap.size,
      vendorProducts: vendorIds.size,
      storeVariants: allVariants.length,
      vendorVariants: vendorVariants.length,
      planned: plan.length,
      updated: applyResult.ok,
      errors: applyResult.errors,
      skipped: {
        notInXml,
        untracked,
        unchanged,
        total: notInXml + untracked + unchanged,
      },
    },
    errorDetail: applyResult.errorDetail.slice(0, 200),
  };

  await fs.mkdir(LOG_DIR, { recursive: true });
  const jsonPath = path.join(LOG_DIR, `${runId}.json`);
  const textPath = path.join(LOG_DIR, `${runId}.log`);
  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));
  await fs.writeFile(
    textPath,
    [
      `Date:            ${summary.date}`,
      `Supplier:        ${summary.supplier}`,
      `Vendor:          ${summary.vendor}`,
      `Store:           ${summary.storeDomain} (API ${summary.apiVersion})`,
      `Location:        ${summary.locationId}`,
      `Feed:            ${summary.feedUrl}`,
      `Elapsed:         ${summary.elapsedSeconds}s`,
      '',
      `Supplier SKUs:   ${summary.counts.supplierSkus}`,
      `Vendor products: ${summary.counts.vendorProducts}`,
      `Store variants:  ${summary.counts.storeVariants}`,
      `Vendor variants: ${summary.counts.vendorVariants}`,
      `Planned:         ${summary.counts.planned}`,
      `Updated:         ${summary.counts.updated}`,
      `Errors:          ${summary.counts.errors}`,
      `Skipped:         ${summary.counts.skipped.total}  (notInXml=${summary.counts.skipped.notInXml}, untracked=${summary.counts.skipped.untracked}, unchanged=${summary.counts.skipped.unchanged})`,
      '',
      summary.errorDetail.length
        ? `First error detail:\n${JSON.stringify(summary.errorDetail[0], null, 2)}`
        : 'No errors.',
    ].join('\n'),
  );

  log(`  JSON log: ${jsonPath}`);
  log(`  Text log: ${textPath}`);
  log(
    `  Result → updated=${summary.counts.updated}, errors=${summary.counts.errors}, skipped=${summary.counts.skipped.total}`,
  );

  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const positional = args.filter((a) => !a.startsWith('-'));
  const arg = (positional[0] || 'all').toLowerCase();

  const targets =
    arg === 'all'
      ? Object.keys(SUPPLIERS)
      : arg in SUPPLIERS
        ? [arg]
        : null;

  if (!targets) {
    console.error(
      `Unknown supplier "${arg}". Valid: ${Object.keys(SUPPLIERS).join(', ')}, all`,
    );
    process.exit(2);
  }

  if (dryRun) log('Dry-run mode: no inventory writes will be performed.');

  log(`Requesting fresh Admin API access token for ${SHOPIFY_STORE_DOMAIN}…`);
  ACCESS_TOKEN = await fetchAccessToken();

  const results = [];
  for (const t of targets) {
    try {
      results.push(await runSupplier(t, { dryRun }));
    } catch (e) {
      console.error(`[${t}] FATAL: ${e.stack || e.message}`);
      results.push({ supplier: t, error: String(e.message) });
    }
  }

  const bad = results.some((r) => r.error || (r.counts && r.counts.errors > 0));
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
