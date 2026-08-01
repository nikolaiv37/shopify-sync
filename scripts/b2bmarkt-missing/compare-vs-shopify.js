#!/usr/bin/env node
/**
 * Compare scraped B2BMarkt new-products against Shopify variants.
 *
 * Read-only: no mutations, no creates, no uploads.
 *
 * Inputs:  missing-new-products.json (from scrape-new-products.js)
 * Outputs: logs/b2bmarkt-missing-products/<timestamp>/
 *            B_new_page_missing_in_shopify.{csv,json}
 *            C_already_in_shopify.{csv,json}
 *            D_uncertain.{csv,json}
 *
 * Match priority (first hit wins, written to `matchReason`):
 *   1. ProductCode/sku   vs Shopify SKU
 *   2. IdentificationCode vs Shopify SKU
 *   3. IdentificationCode vs Shopify barcode
 *   4. ProductCode/sku   vs Shopify barcode
 *
 * Usage:
 *   node scripts/b2bmarkt-missing/compare-vs-shopify.js
 *   node scripts/b2bmarkt-missing/compare-vs-shopify.js --in=missing-new-products.json
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2025-10',
} = process.env;

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  console.error('Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET in .env');
  process.exit(1);
}

const ENDPOINT = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
const TOKEN_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;
let ACCESS_TOKEN = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const log = (s) => console.log(`[${nowIso()}] ${s}`);

function parseArgs(argv) {
  const opts = { input: 'missing-new-products.json' };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--in=')) opts.input = a.slice(5);
  }
  return opts;
}

async function fetchAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SHOPIFY_CLIENT_ID,
    client_secret: SHOPIFY_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token HTTP ${res.status}: ${text.slice(0, 400)}`);
  const j = JSON.parse(text);
  if (!j.access_token) throw new Error(`token response missing access_token`);
  log(`Access token acquired (scopes: ${j.scope || '(none)'})`);
  return j.access_token;
}

async function gql(query, variables = {}) {
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
    const e = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
    e.status = res.status;
    throw e;
  }
  const j = JSON.parse(text);
  if (j.errors) {
    const msg = JSON.stringify(j.errors);
    const e = new Error(msg.slice(0, 400));
    e.throttled = msg.includes('THROTTLED');
    throw e;
  }
  return j.data;
}

async function gqlWithRetry(query, variables, label, maxTries = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await gql(query, variables);
    } catch (e) {
      if (attempt >= maxTries) throw e;
      const wait = e.throttled ? 5000 : Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.warn(`[${label}] ${e.throttled ? 'THROTTLED' : 'ERROR'} (${attempt}/${maxTries}), sleeping ${wait}ms: ${String(e.message).slice(0, 180)}`);
      await sleep(wait);
    }
  }
}

async function fetchAllVariants() {
  const bySku = new Map();      // key: sku -> array of variant rows
  const byBarcode = new Map();  // key: barcode -> array of variant rows
  let cursor = null;
  let page = 0;
  let total = 0;

  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query compareVariants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            barcode
            product { id title vendor handle }
          }
        }
      }`,
      { cursor },
      `variants page ${page}`,
    );
    for (const v of data.productVariants.nodes) {
      total++;
      const row = {
        variantId: v.id,
        productId: v.product.id,
        productTitle: v.product.title,
        productHandle: v.product.handle,
        vendor: v.product.vendor,
        sku: v.sku || '',
        barcode: v.barcode || '',
      };
      const sku = (v.sku || '').trim();
      const bc = (v.barcode || '').trim();
      if (sku) {
        const list = bySku.get(sku) || [];
        list.push(row);
        bySku.set(sku, list);
      }
      if (bc) {
        const list = byBarcode.get(bc) || [];
        list.push(row);
        byBarcode.set(bc, list);
      }
    }
    if (page % 20 === 0) log(`Variants fetched: ${total}`);
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
    await sleep(120);
  }
  log(`Variants fetched: ${total} (unique SKUs: ${bySku.size}, with barcode: ${byBarcode.size})`);
  return { bySku, byBarcode };
}

function matchProduct(p, { bySku, byBarcode }) {
  const productCode = (p.sku || '').trim();
  const idCode = (p.identification_code || p.item_code || '').trim();

  if (productCode && bySku.has(productCode)) {
    return { matched: true, reason: 'productCode==shopifySku', matches: bySku.get(productCode), matchedOn: productCode };
  }
  if (idCode && bySku.has(idCode)) {
    return { matched: true, reason: 'identificationCode==shopifySku', matches: bySku.get(idCode), matchedOn: idCode };
  }
  if (idCode && byBarcode.has(idCode)) {
    return { matched: true, reason: 'identificationCode==shopifyBarcode', matches: byBarcode.get(idCode), matchedOn: idCode };
  }
  if (productCode && byBarcode.has(productCode)) {
    return { matched: true, reason: 'productCode==shopifyBarcode', matches: byBarcode.get(productCode), matchedOn: productCode };
  }
  return { matched: false, reason: '', matches: [], matchedOn: '' };
}

function escapeCsvField(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toBucketCsv(rows) {
  const headers = [
    'matchReason', 'matchedOn',
    'sku', 'identification_code', 'title', 'source_url',
    'retail_price', 'images_count',
    'shopify_product_handle', 'shopify_variant_id', 'shopify_sku', 'shopify_barcode',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const m = r.matches?.[0] || {};
    lines.push([
      escapeCsvField(r.matchReason),
      escapeCsvField(r.matchedOn),
      escapeCsvField(r.product.sku),
      escapeCsvField(r.product.identification_code),
      escapeCsvField(r.product.title),
      escapeCsvField(r.product.source_url),
      escapeCsvField(r.product.retail_price),
      escapeCsvField((r.product.images || []).length),
      escapeCsvField(m.productHandle || ''),
      escapeCsvField(m.variantId || ''),
      escapeCsvField(m.sku || ''),
      escapeCsvField(m.barcode || ''),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

async function writeBucket(dir, name, rows) {
  const json = { count: rows.length, generatedAt: nowIso(), rows };
  await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(json, null, 2));
  await fs.writeFile(path.join(dir, `${name}.csv`), toBucketCsv(rows));
}

async function main() {
  const opts = parseArgs(process.argv);
  const inputPath = path.resolve(opts.input);
  log(`Input: ${inputPath}`);
  const inputJson = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const scraped = inputJson.products || [];
  log(`Scraped products in input: ${scraped.length}`);

  ACCESS_TOKEN = await fetchAccessToken();
  const indexes = await fetchAllVariants();

  const bucketB = []; // missing in Shopify
  const bucketC = []; // already in Shopify
  const bucketD = []; // uncertain (no usable codes)

  for (const p of scraped) {
    const hasProductCode = !!(p.sku && String(p.sku).trim());
    const hasIdCode = !!(p.identification_code && String(p.identification_code).trim());
    if (!hasProductCode && !hasIdCode) {
      bucketD.push({ matchReason: 'no_product_code_and_no_identification_code', matchedOn: '', matches: [], product: p });
      continue;
    }
    const r = matchProduct(p, indexes);
    if (r.matched) {
      bucketC.push({ matchReason: r.reason, matchedOn: r.matchedOn, matches: r.matches, product: p });
    } else {
      bucketB.push({ matchReason: 'no_match', matchedOn: '', matches: [], product: p });
    }
  }

  const stamp = nowIso().replace(/[:.]/g, '-');
  const outDir = path.resolve('logs/b2bmarkt-missing-products', stamp);
  await fs.mkdir(outDir, { recursive: true });

  await writeBucket(outDir, 'B_new_page_missing_in_shopify', bucketB);
  await writeBucket(outDir, 'C_already_in_shopify', bucketC);
  await writeBucket(outDir, 'D_uncertain', bucketD);

  await fs.writeFile(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        generatedAt: nowIso(),
        input: inputPath,
        shopifyDomain: SHOPIFY_STORE_DOMAIN,
        scrapedCount: scraped.length,
        missingCount: bucketB.length,
        alreadyInShopifyCount: bucketC.length,
        uncertainCount: bucketD.length,
        matchPriority: [
          'productCode==shopifySku',
          'identificationCode==shopifySku',
          'identificationCode==shopifyBarcode',
          'productCode==shopifyBarcode',
        ],
      },
      null,
      2,
    ),
  );

  console.log('\n========== Compare summary ==========');
  console.log(`Scraped:                  ${scraped.length}`);
  console.log(`B (missing in Shopify):   ${bucketB.length}`);
  console.log(`C (already in Shopify):   ${bucketC.length}`);
  console.log(`D (uncertain):            ${bucketD.length}`);
  console.log(`Output dir:               ${outDir}`);
  console.log('======================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
