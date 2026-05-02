#!/usr/bin/env node
/**
 * Bulk-update Shopify variant prices from local supplier XML feeds (B2BMarkt + Megapap).
 *
 * Auth: same client-credentials flow as sync.js (SHOPIFY_* in .env).
 * Required scope: read_products, write_products
 *
 * Defaults to DRY RUN. Pass --apply to perform writes.
 *
 * Usage:
 *   node update-prices.js                    # dry-run, both feeds
 *   node update-prices.js b2bmarkt           # dry-run, one feed
 *   node update-prices.js megapap --apply    # live run, one feed
 *   node update-prices.js --apply --limit 25 --concurrency 2
 *
 * XML paths default to ./b2bmarkt.xml and ./megapap_en.xml (override via env or flags).
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

// ---------- Shopify auth (fill via .env — same as sync.js) ----------

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2025-10',
  LOG_DIR = './logs',
  B2BMARKT_XML_PATH,
  MEGAPAP_XML_PATH,
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

// ---------- Per-supplier feed config (adjust tags / formulas here) ----------

const FEEDS = {
  b2bmarkt: {
    key: 'b2bmarkt',
    label: 'B2BMarkt (b2bmarkt.xml)',
    vendor: 'Europe',
    xmlPath: B2BMARKT_XML_PATH || './b2bmarkt.xml',
    productTag: 'Product',
    skuTag: 'ProductCode',
    sourcePriceTag: 'ZoneFourUnitPrice',
    /** Applied to parsed source price before rounding to 2 decimals. */
    priceMultiplier: 3.1,
  },
  megapap: {
    key: 'megapap',
    label: 'Megapap (megapap_en.xml)',
    vendor: 'Mebelcenter',
    xmlPath: MEGAPAP_XML_PATH || './megapap_en.xml',
    productTag: 'product',
    skuTag: 'model',
    sourcePriceTag: 'wholesale_price_without_vat',
    priceMultiplier: 1.7,
  },
};

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    apply: false,
    limit: null,
    concurrency: 3,
    variantsPerBulk: 100,
    xmlB2b: null,
    xmlMegapap: null,
  };
  const positional = [];
  const unknownFlags = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') {
      opts.apply = true;
      continue;
    }
    if (a === '--dry-run' || a === '-n') {
      opts.apply = false;
      continue;
    }
    if (a === '--limit') {
      const v = Number.parseInt(args[++i], 10);
      if (!Number.isFinite(v) || v < 1) {
        console.error('--limit requires a positive integer');
        process.exit(2);
      }
      opts.limit = v;
      continue;
    }
    if (a === '--concurrency') {
      const v = Number.parseInt(args[++i], 10);
      if (!Number.isFinite(v) || v < 1) {
        console.error('--concurrency requires a positive integer');
        process.exit(2);
      }
      opts.concurrency = v;
      continue;
    }
    if (a === '--batch-size' || a === '--variants-per-bulk') {
      const v = Number.parseInt(args[++i], 10);
      if (!Number.isFinite(v) || v < 1 || v > 250) {
        console.error('--batch-size must be between 1 and 250');
        process.exit(2);
      }
      opts.variantsPerBulk = v;
      continue;
    }
    if (a === '--xml-b2b') {
      opts.xmlB2b = args[++i];
      continue;
    }
    if (a === '--xml-megapap') {
      opts.xmlMegapap = args[++i];
      continue;
    }
    if (a.startsWith('-')) {
      unknownFlags.push(a);
      continue;
    }
    positional.push(a);
  }

  let target = (positional[0] || 'all').toLowerCase();
  if (target === 'b2b') target = 'b2bmarkt';

  return { opts, target, unknownFlags };
}

// ---------- Utilities ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  console.log(`[${nowIso()}] ${line}`);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function moneyString(n) {
  return round2(n).toFixed(2);
}

function parseSourcePrice(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(',', '.');
  if (!s) return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parseShopifyMoney(val) {
  if (val == null) return null;
  const n = Number.parseFloat(String(val));
  return Number.isFinite(n) ? n : null;
}

// ---------- Shopify: token + GraphQL ----------

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

function extractText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return extractText(val[0]);
  if (typeof val === 'object') {
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

/**
 * @returns {{ feedBySku: Map<string, { sourcePrice: number, computedPrice: number }>, stats: object, issues: object[] }}
 */
function buildFeedPriceMap(xmlText, feed) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, feed.productTag);
  if (!products) {
    throw new Error(`Could not find <${feed.productTag}> elements in XML`);
  }

  const feedBySku = new Map();
  const issues = [];
  let invalidPrice = 0;
  let emptySku = 0;
  let dupes = 0;

  for (const p of products) {
    const skuRaw = extractText(p?.[feed.skuTag]);
    const sku = skuRaw ? skuRaw.trim() : '';
    if (!sku) {
      emptySku++;
      issues.push({ type: 'xml_empty_sku', detail: 'missing sku tag' });
      continue;
    }

    const src = parseSourcePrice(extractText(p?.[feed.sourcePriceTag]));
    if (src == null) {
      invalidPrice++;
      issues.push({ type: 'xml_invalid_price', sku, detail: `missing/invalid ${feed.sourcePriceTag}` });
      continue;
    }

    const computed = round2(src * feed.priceMultiplier);
    if (feedBySku.has(sku)) dupes++;
    feedBySku.set(sku, { sourcePrice: src, computedPrice: computed });
  }

  return {
    feedBySku,
    stats: {
      xmlRows: products.length,
      uniqueSkus: feedBySku.size,
      xmlDupesCollapsed: dupes,
      xmlEmptySku: emptySku,
      xmlInvalidPrice: invalidPrice,
    },
    issues,
  };
}

// ---------- Shopify: paginated variants ----------

async function fetchAllVariantsBySku() {
  /** @type {Map<string, Array<{ variantId: string, productId: string, vendor: string, currentPrice: number | null }>>} */
  const bySku = new Map();
  let cursor = null;
  let page = 0;
  let totalNodes = 0;

  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query priceVariants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            price
            product { id vendor }
          }
        }
      }`,
      { cursor },
      `variants page ${page}`,
    );

    for (const v of data.productVariants.nodes) {
      totalNodes++;
      const sku = v.sku?.trim();
      if (!sku) continue;
      const row = {
        variantId: v.id,
        productId: v.product.id,
        vendor: v.product.vendor,
        currentPrice: parseShopifyMoney(v.price),
      };
      const list = bySku.get(sku) ?? [];
      list.push(row);
      bySku.set(sku, list);
    }

    if (page % 20 === 0) log(`variants fetched: ${totalNodes} nodes, ${bySku.size} unique SKUs`);
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
    await sleep(120);
  }

  log(`variants total: ${totalNodes} nodes, ${bySku.size} unique SKUs`);
  return bySku;
}

// ---------- Matching & updates ----------

const BULK_MUTATION = `
  mutation priceBulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

async function applyBulkForProduct(productId, variantInputs, label) {
  const data = await gqlWithRetry(
    BULK_MUTATION,
    { productId, variants: variantInputs },
    label,
  );
  const errors = data.productVariantsBulkUpdate?.userErrors || [];
  return { errors };
}

async function runWithConcurrency(items, limit, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function runFeed(feed, shopifyBySku, options) {
  const { apply, limit, concurrency, variantsPerBulk, xmlB2b, xmlMegapap } = options;

  const xmlPathResolved = path.resolve(
    feed.key === 'b2bmarkt' && xmlB2b
      ? xmlB2b
      : feed.key === 'megapap' && xmlMegapap
        ? xmlMegapap
        : feed.xmlPath,
  );

  log(`Reading XML: ${xmlPathResolved}`);
  const xmlText = await fs.readFile(xmlPathResolved, 'utf8');
  const { feedBySku, stats: xmlStats, issues: xmlIssues } = buildFeedPriceMap(xmlText, feed);

  const detailLog = xmlIssues.map((row) => ({ feed: feed.key, ...row }));
  let matchedRows = 0;
  /** @type {Set<string>} */
  const matchedSkus = new Set();
  let unchanged = 0;
  let vendorMismatch = 0;
  let missingInShopify = 0;
  /** @type {{ sku: string, variantId: string, productId: string, vendor: string, sourcePrice: number, multiplier: number, oldPrice: number|null, newPrice: number }[]} */
  const toUpdate = [];

  for (const [sku, { sourcePrice, computedPrice: newPrice }] of feedBySku) {
    const rows = shopifyBySku.get(sku);
    if (!rows || rows.length === 0) {
      missingInShopify++;
      detailLog.push({
        type: 'missing_in_shopify',
        sku,
        expectedVendor: feed.vendor,
        targetPrice: moneyString(newPrice),
        sourcePrice: moneyString(sourcePrice),
      });
      continue;
    }

    for (const row of rows) {
      if (row.vendor !== feed.vendor) {
        vendorMismatch++;
        detailLog.push({
          type: 'vendor_mismatch',
          sku,
          variantId: row.variantId,
          productId: row.productId,
          shopifyVendor: row.vendor,
          expectedVendor: feed.vendor,
        });
        continue;
      }

      matchedRows++;
      matchedSkus.add(sku);
      const old = row.currentPrice;
      if (old != null && round2(old) === newPrice) {
        unchanged++;
        continue;
      }

      toUpdate.push({
        sku,
        variantId: row.variantId,
        productId: row.productId,
        vendor: row.vendor,
        sourcePrice,
        multiplier: feed.priceMultiplier,
        oldPrice: old,
        newPrice,
      });
    }
  }

  const capped = limit != null ? toUpdate.slice(0, limit) : toUpdate;
  const limitNote =
    limit != null && toUpdate.length > limit
      ? ` (cap ${limit} of ${toUpdate.length})`
      : '';

  let updated = 0;
  let failed = 0;

  if (!apply) {
    log(
      `DRY RUN ${feed.key}: would update ${capped.length} variant(s)${limitNote}; skipping API writes.`,
    );
    updated = 0;
  } else if (capped.length === 0) {
    log(`APPLY ${feed.key}: nothing to update.`);
  } else {
    /** @type {Map<string, Array<{ id: string, price: string }>>} */
    const byProduct = new Map();
    for (const u of capped) {
      const list = byProduct.get(u.productId) ?? [];
      list.push({ id: u.variantId, price: moneyString(u.newPrice) });
      byProduct.set(u.productId, list);
    }

    const jobs = [];
    for (const [productId, vars] of byProduct) {
      for (let i = 0; i < vars.length; i += variantsPerBulk) {
        const chunk = vars.slice(i, i + variantsPerBulk);
        jobs.push({ productId, chunk, label: `${feed.key} ${productId} chunk ${i / variantsPerBulk + 1}` });
      }
    }

    log(`APPLY ${feed.key}: ${jobs.length} bulk mutation job(s) for ${capped.length} variant(s)${limitNote}.`);

    let doneJobs = 0;
    await runWithConcurrency(jobs, concurrency, async (job) => {
      const variantInputs = job.chunk.map((c) => ({ id: c.id, price: c.price }));
      try {
        const { errors } = await applyBulkForProduct(job.productId, variantInputs, job.label);
        if (errors.length) {
          failed += job.chunk.length;
          detailLog.push({
            type: 'mutation_user_errors',
            productId: job.productId,
            errors,
            variantIds: job.chunk.map((c) => c.id),
          });
        } else {
          updated += job.chunk.length;
        }
      } catch (e) {
        failed += job.chunk.length;
        detailLog.push({
          type: 'mutation_failed',
          productId: job.productId,
          message: String(e.message).slice(0, 500),
          variantIds: job.chunk.map((c) => c.id),
        });
      }
      doneJobs++;
      if (doneJobs % 5 === 0) log(`  … progress ${doneJobs}/${jobs.length} bulk job(s)`);
      await sleep(200);
    });
  }

  const summary = {
    feed: feed.key,
    label: feed.label,
    xmlPath: xmlPathResolved,
    expectedVendor: feed.vendor,
    dryRun: !apply,
    options: {
      limit: limit ?? null,
      concurrency,
      variantsPerBulk,
    },
    counts: {
      parsedFromXml: xmlStats.xmlRows,
      uniqueSkusInXml: xmlStats.uniqueSkus,
      xmlDupesCollapsed: xmlStats.xmlDupesCollapsed,
      xmlEmptySku: xmlStats.xmlEmptySku,
      xmlInvalidPrice: xmlStats.xmlInvalidPrice,
      matchedSkusInShopify: matchedSkus.size,
      matchedVariantRows: matchedRows,
      missingSkuInShopify: missingInShopify,
      vendorMismatches: vendorMismatch,
      unchanged,
      needsUpdate: toUpdate.length,
      updatesAttempted: capped.length,
      updated,
      failed,
    },
    formulas: {
      sourceTag: feed.sourcePriceTag,
      multiplier: feed.priceMultiplier,
    },
  };

  return { summary, detailLog, previewUpdates: capped.slice(0, 15) };
}

// ---------- Main ----------

async function main() {
  const { opts, target, unknownFlags } = parseArgs(process.argv);
  if (unknownFlags.length) {
    console.warn('Unknown flags ignored:', unknownFlags.join(', '));
  }

  const targets =
    target === 'all' ? Object.keys(FEEDS) : target in FEEDS ? [target] : null;

  if (!targets) {
    console.error(`Unknown target "${target}". Use: b2bmarkt | megapap | all`);
    process.exit(2);
  }

  if (!opts.apply) {
    log('Dry-run mode (default): no price writes. Pass --apply to update Shopify.');
  } else {
    log('APPLY mode: prices will be written to Shopify.');
  }

  log(`Requesting Admin API access token for ${SHOPIFY_STORE_DOMAIN}…`);
  ACCESS_TOKEN = await fetchAccessToken();

  log('Fetching all product variants (paginated)…');
  const shopifyBySku = await fetchAllVariantsBySku();

  const runOpts = {
    apply: opts.apply,
    limit: opts.limit,
    concurrency: opts.concurrency,
    variantsPerBulk: opts.variantsPerBulk,
    xmlB2b: opts.xmlB2b,
    xmlMegapap: opts.xmlMegapap,
  };

  const allSummaries = [];
  const allDetails = [];

  for (const key of targets) {
    const feed = FEEDS[key];

    log(`\n========== ${feed.label} ==========`);
    const { summary, detailLog, previewUpdates } = await runFeed(feed, shopifyBySku, runOpts);
    allSummaries.push(summary);
    allDetails.push(...detailLog);

    console.log('\n--- Summary ---');
    console.log(`Parsed from XML (rows):     ${summary.counts.parsedFromXml}`);
    console.log(`Unique SKUs in XML:         ${summary.counts.uniqueSkusInXml}`);
    console.log(`XML duplicate SKUs:         ${summary.counts.xmlDupesCollapsed}`);
    console.log(`XML empty SKU rows:         ${summary.counts.xmlEmptySku}`);
    console.log(`XML invalid/missing price:  ${summary.counts.xmlInvalidPrice}`);
    console.log(`Matched SKUs (vendor OK):   ${summary.counts.matchedSkusInShopify}`);
    console.log(`Matched variant rows:       ${summary.counts.matchedVariantRows}`);
    console.log(`Missing SKU in Shopify:     ${summary.counts.missingSkuInShopify}`);
    console.log(`Vendor mismatches (skipped): ${summary.counts.vendorMismatches}`);
    console.log(`Unchanged price:            ${summary.counts.unchanged}`);
    console.log(`Needs price update:         ${summary.counts.needsUpdate}`);
    console.log(`Updates attempted:          ${summary.counts.updatesAttempted}`);
    console.log(`Updated (API success):      ${summary.counts.updated}`);
    console.log(`Failed:                     ${summary.counts.failed}`);

    if (previewUpdates.length && !opts.apply) {
      console.log('\nPreview (first rows):');
      for (const r of previewUpdates) {
        const mult = Number(r.multiplier);
        const multStr = Number.isFinite(mult) ? mult.toFixed(2) : String(r.multiplier);
        console.log(
          `  ${r.sku}  current: ${r.oldPrice == null ? 'null' : moneyString(r.oldPrice)}  source: ${moneyString(r.sourcePrice)}  multiplier: ${multStr}  new: ${moneyString(r.newPrice)}`,
        );
      }
    }
  }

  const startedAt = new Date();
  const runId = `price-sync-${opts.apply ? 'APPLY' : 'DRY'}-${startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  await fs.mkdir(LOG_DIR, { recursive: true });
  const jsonPath = path.join(LOG_DIR, `${runId}.json`);
  const detailPath = path.join(LOG_DIR, `${runId}.detail.jsonl`);

  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        runId,
        startedAt: startedAt.toISOString(),
        store: SHOPIFY_STORE_DOMAIN,
        apiVersion: SHOPIFY_API_VERSION,
        dryRun: !opts.apply,
        summaries: allSummaries,
      },
      null,
      2,
    ),
  );

  const lines = allDetails.map((d) => JSON.stringify(d));
  await fs.writeFile(detailPath, `${lines.join('\n')}\n`);

  log(`\nWrote summary: ${jsonPath}`);
  log(`Wrote detail log (skipped/failed): ${detailPath}`);

  const fatalFailures = allSummaries.some((s) => s.counts.failed > 0);
  process.exit(fatalFailures ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
