#!/usr/bin/env node
/**
 * READ-ONLY audit: Find Shopify vendor=Europe products/SKUs NOT in B2BMarkt XML feed.
 *
 * Outputs:
 *   reports/europe-not-in-feed.csv
 *   reports/europe-not-in-feed.json
 *
 * Does NOT delete, archive, unpublish, or mutate anything.
 *
 * Usage:
 *   node scripts/audit_europe_not_in_feed.js
 *   node scripts/audit_europe_not_in_feed.js --xml=b2bmarkt_updated.xml
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

// ---------- Shopify auth (same pattern as export-missing-products.js) ----------

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2025-10',
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

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    xmlPath: './b2bmarkt_updated.xml',
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--xml=')) {
      opts.xmlPath = a.slice('--xml='.length);
    }
  }

  return opts;
}

// ---------- Utilities ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  console.log(`[${nowIso()}] ${line}`);
}

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

// ---------- Shopify: fetch vendor=Europe products with variants ----------

async function fetchEuropeProducts() {
  const products = [];
  let cursor = null;
  let page = 0;

  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query europeProducts($cursor: String) {
        products(first: 100, after: $cursor, query: "vendor:Europe") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            status
            vendor
            variants(first: 50) {
              nodes {
                id
                sku
                price
                inventoryQuantity
              }
            }
          }
        }
      }`,
      { cursor },
      `europe products page ${page}`,
    );

    for (const p of data.products.nodes) {
      const productVariants = p.variants.nodes.map((v) => ({
        productId: p.id,
        productTitle: p.title,
        productHandle: p.handle,
        productStatus: p.status,
        vendor: p.vendor,
        variantId: v.id,
        sku: v.sku?.trim() || '',
        currentPrice: v.price,
        inventoryQuantity: v.inventoryQuantity,
      }));
      products.push(...productVariants);
    }

    if (page % 10 === 0) {
      log(`Europe products fetched: ${products.length} variant rows`);
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
    await sleep(120);
  }

  log(`Europe products fetched: ${products.length} variant rows`);
  return products;
}

// ---------- XML parsing ----------

function parseXmlSkus(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    attributesGroupName: '$attrs',
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, 'Product');
  if (!products) {
    throw new Error('Could not find <Product> elements in XML');
  }
  const skus = new Set();
  for (const p of products) {
    const sku = extractText(p?.ProductCode);
    if (sku) skus.add(sku);
  }
  return skus;
}

// ---------- CSV helper ----------

function escapeCsvField(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsv(rows) {
  const headers = [
    'sku',
    'product_title',
    'product_id',
    'variant_id',
    'vendor',
    'current_price',
    'inventory_quantity',
    'product_status',
    'product_handle',
    'admin_product_url',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const row = [
      escapeCsvField(r.sku),
      escapeCsvField(r.productTitle),
      escapeCsvField(r.productId),
      escapeCsvField(r.variantId),
      escapeCsvField(r.vendor),
      escapeCsvField(r.currentPrice),
      escapeCsvField(r.inventoryQuantity),
      escapeCsvField(r.productStatus),
      escapeCsvField(r.productHandle),
      escapeCsvField(r.adminUrl),
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);
  const xmlPathResolved = path.resolve(opts.xmlPath);

  log(`XML file: ${xmlPathResolved}`);

  // Step 1: Parse XML supplier SKUs
  log('Parsing B2BMarkt XML for all ProductCodes...');
  const xmlText = await fs.readFile(xmlPathResolved, 'utf8');
  const supplierSkus = parseXmlSkus(xmlText);
  log(`Total supplier SKUs in XML: ${supplierSkus.size}`);

  // Step 2: Fetch Shopify vendor=Europe products
  log('Fetching Shopify vendor=Europe products...');
  ACCESS_TOKEN = await fetchAccessToken();
  const europeVariants = await fetchEuropeProducts();

  // Step 3: Compare
  const europeSkus = europeVariants.map((v) => v.sku).filter(Boolean);
  const uniqueEuropeSkus = new Set(europeSkus);

  // Check for duplicate SKUs in Shopify
  const skuCounts = new Map();
  for (const sku of europeSkus) {
    skuCounts.set(sku, (skuCounts.get(sku) || 0) + 1);
  }
  const duplicateSkus = [];
  for (const [sku, count] of skuCounts) {
    if (count > 1) {
      duplicateSkus.push({ sku, count });
    }
  }

  // Find SKUs not in feed
  const notInFeed = [];
  let foundCount = 0;
  for (const v of europeVariants) {
    if (!v.sku) continue;
    if (supplierSkus.has(v.sku)) {
      foundCount++;
    } else {
      const storeDomain = SHOPIFY_STORE_DOMAIN.replace(/\/+$/, '');
      v.adminUrl = `https://${storeDomain}/admin/products/${v.productId.split('/').pop()}`;
      notInFeed.push(v);
    }
  }

  // Step 4: Ensure reports directory exists
  const reportsDir = path.resolve('reports');
  try {
    await fs.mkdir(reportsDir, { recursive: true });
  } catch {
    // already exists
  }

  // Step 5: Write CSV
  const csvPath = path.join(reportsDir, 'europe-not-in-feed.csv');
  await fs.writeFile(csvPath, toCsv(notInFeed));
  log(`CSV written: ${csvPath} (${notInFeed.length} rows)`);

  // Step 6: Write JSON
  const jsonPath = path.join(reportsDir, 'europe-not-in-feed.json');
  const reportData = {
    generatedAt: nowIso(),
    xmlSource: xmlPathResolved,
    summary: {
      totalSupplierSkus: supplierSkus.size,
      totalEuropeShopifySkus: uniqueEuropeSkus.size,
      totalEuropeShopifyVariantRows: europeVariants.length,
      foundInFeed: foundCount,
      notInFeed: notInFeed.length,
      duplicateSkus: duplicateSkus.length,
    },
    duplicateSkuDetails: duplicateSkus,
    notInFeed,
  };
  await fs.writeFile(jsonPath, JSON.stringify(reportData, null, 2));
  log(`JSON written: ${jsonPath}`);

  // Summary
  console.log('\n========== Audit Summary ==========');
  console.log(`Total supplier SKUs (XML):       ${supplierSkus.size}`);
  console.log(`Total Europe Shopify SKUs:       ${uniqueEuropeSkus.size}`);
  console.log(`Total Europe Shopify variants:   ${europeVariants.length}`);
  console.log(`Found in feed:                   ${foundCount}`);
  console.log(`Not in feed:                     ${notInFeed.length}`);
  console.log(`Duplicate SKUs in Shopify:       ${duplicateSkus.length}`);
  if (duplicateSkus.length > 0) {
    console.log('\nDuplicate SKU details:');
    for (const d of duplicateSkus.slice(0, 20)) {
      console.log(`  ${d.sku} → ${d.count} variants`);
    }
  }
  console.log('\nReports:');
  console.log(`  CSV:  ${csvPath}`);
  console.log(`  JSON: ${jsonPath}`);
  console.log('===================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
