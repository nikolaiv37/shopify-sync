#!/usr/bin/env node
/**
 * Export product data from Shopify Admin GraphQL for renaming preview.
 *
 * READ-ONLY. No mutations.
 *
 * Usage:
 *   node scripts/product-renaming/export-products-for-rename.js
 *   node scripts/product-renaming/export-products-for-rename.js --vendor=Europe --limit=100
 *   node scripts/product-renaming/export-products-for-rename.js --vendor=Mebelcenter --status=ACTIVE --limit=50
 *   node scripts/product-renaming/export-products-for-rename.js --query="tag:градински" --limit=200
 *   node scripts/product-renaming/export-products-for-rename.js --out=my-export.json
 *
 * Output: logs/product-renaming/export-products-YYYY-MM-DDTHH-mm-ss.json
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

async function gqlWithRetry(query, variables, label, maxTries = 6) {
  let attempt = 0;
  for (;;) {
    try {
      return await gql(query, variables);
    } catch (e) {
      if (e.isSchemaError) {
        console.error(`[${label}] SCHEMA ERROR (not retrying): ${e.message.slice(0, 300)}`);
        throw e;
      }
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
    vendor: null,
    query: null,
    limit: null,
    status: 'ACTIVE',
    out: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--vendor=')) opts.vendor = a.slice('--vendor='.length);
    else if (a.startsWith('--query=')) opts.query = a.slice('--query='.length);
    else if (a.startsWith('--status=')) opts.status = a.slice('--status='.length);
    else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a === '--limit') {
      const v = Number.parseInt(args[++i], 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);

  log(`Status filter: ${opts.status}`);
  if (opts.vendor) log(`Vendor filter: ${opts.vendor}`);
  if (opts.query) log(`Query filter: ${opts.query}`);
  if (opts.limit) log(`Limit: ${opts.limit}`);

  ACCESS_TOKEN = await fetchAccessToken();

  const baseQuery = `status:${opts.status}`;
  const vendorQuery = opts.vendor ? ` ${baseQuery} product.vendor:${opts.vendor}` : ` ${baseQuery}`;
  const fullQuery = opts.query ? opts.query : vendorQuery;

  const products = [];
  let cursor = null;
  let page = 0;
  let totalScanned = 0;

  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query products($cursor: String, $query: String!) {
        products(first: 100, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            handle
            title
            descriptionHtml
            vendor
            productType
            tags
            status
            seo { title description }
            variants(first: 5) {
              nodes {
                id
                sku
                title
              }
            }
          }
        }
      }`,
      { cursor, query: fullQuery },
      `page ${page}`,
    );

    const pageInfo = data.products.pageInfo;
    const nodes = data.products.nodes;

    for (const p of nodes) {
      products.push({
        id: p.id,
        handle: p.handle,
        title: p.title,
        descriptionHtml: p.descriptionHtml,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags,
        status: p.status,
        seoTitle: p.seo?.title || null,
        seoDescription: p.seo?.description || null,
        variantSkus: (p.variants?.nodes || []).map((v) => ({
          id: v.id,
          sku: v.sku,
          title: v.title,
        })),
      });
      totalScanned++;

      if (opts.limit && totalScanned >= opts.limit) break;
    }

    if (opts.limit && totalScanned >= opts.limit) break;
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;

    if (totalScanned % 200 === 0) {
      log(`Exported ${totalScanned} products... (page ${page})`);
    }

    await sleep(150);
  }

  // Summary
  const vendors = new Set(products.map((p) => p.vendor).filter(Boolean));
  const productTypeCounts = {};
  for (const p of products) {
    const pt = p.productType || '(empty)';
    productTypeCounts[pt] = (productTypeCounts[pt] || 0) + 1;
  }
  const topTypes = Object.entries(productTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // Write output
  const outDir = path.join(LOG_DIR, 'product-renaming');
  await fs.mkdir(outDir, { recursive: true });

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(outDir, `export-products-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  await fs.writeFile(outPath, JSON.stringify({
    timestamp: nowIso(),
    filters: {
      status: opts.status,
      vendor: opts.vendor,
      query: opts.query,
      limit: opts.limit,
    },
    totalExported: products.length,
    vendors: Array.from(vendors),
    topProductTypes: Object.fromEntries(topTypes),
    products,
  }, null, 2));

  const currentDir = path.join(outDir, 'current');
  await fs.mkdir(currentDir, { recursive: true });
  await fs.writeFile(path.join(currentDir, 'export.json'), JSON.stringify({
    timestamp: nowIso(),
    filters: {
      status: opts.status,
      vendor: opts.vendor,
      query: opts.query,
      limit: opts.limit,
    },
    totalExported: products.length,
    vendors: Array.from(vendors),
    topProductTypes: Object.fromEntries(topTypes),
    products,
  }, null, 2));

  console.log();
  console.log('========== Summary ==========');
  console.log(`Exported count:    ${products.length}`);
  console.log(`Vendors found:     ${Array.from(vendors).join(', ') || '(none)'}`);
  console.log(`Top product types:`);
  for (const [type, count] of topTypes) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`Output path:       ${outPath}`);
  console.log('=============================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
