#!/usr/bin/env node
/**
 * Count all ACTIVE Shopify products that are truly on sale.
 *
 * A product is "on sale" only if at least one variant has:
 *   Number(compareAtPrice) > Number(price)
 *
 * Read-only: no mutations.
 *
 * Usage:
 *   node scripts/count-real-sale-products.js
 */

import 'dotenv/config';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  console.log(`[${new Date().toISOString()}] ${line}`);
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
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 800)}`);
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

async function main() {
  ACCESS_TOKEN = await fetchAccessToken();

  let totalActive = 0;
  let saleProducts = 0;
  let saleVariants = 0;
  const examples = [];
  let cursor = null;
  let page = 0;

  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query products($cursor: String) {
        products(first: 100, after: $cursor, query: "status:ACTIVE") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            status
            variants(first: 100) {
              nodes {
                id
                sku
                price
                compareAtPrice
              }
            }
          }
        }
      }`,
      cursor ? { cursor } : {},
      `page ${page}`,
    );

    const pageInfo = data.products.pageInfo;
    const nodes = data.products.nodes;

    for (const product of nodes) {
      totalActive++;
      let productHasSale = false;
      let productSaleVariants = 0;

      for (const v of product.variants.nodes) {
        const price = Number(v.price);
        const compareAtPrice = Number(v.compareAtPrice);
        const isRealSale =
          v.compareAtPrice != null &&
          Number.isFinite(price) &&
          Number.isFinite(compareAtPrice) &&
          compareAtPrice > price;

        if (isRealSale) {
          productHasSale = true;
          productSaleVariants++;
          if (examples.length < 20) {
            examples.push({
              sku: v.sku || '(no sku)',
              title: product.title,
              handle: product.handle,
              price: v.price,
              compareAtPrice: v.compareAtPrice,
            });
          }
        }
      }

      if (productHasSale) {
        saleProducts++;
        saleVariants += productSaleVariants;
      }
    }

    if (totalActive % 100 === 0 || !pageInfo.hasNextPage) {
      log(`Scanned ${totalActive} products... (page ${page})`);
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await sleep(200);
  }

  console.log();
  console.log('========== Results ==========');
  console.log(`Total active products scanned: ${totalActive}`);
  console.log(`Total real sale products:      ${saleProducts}`);
  console.log(`Total real sale variants:      ${saleVariants}`);
  console.log();
  console.log('--- First 20 sale examples ---');
  for (const ex of examples) {
    console.log(`  SKU: ${ex.sku.padEnd(16)} | ${ex.title.slice(0, 50)} | handle: ${ex.handle} | price: ${ex.price} | compareAt: ${ex.compareAtPrice}`);
  }
  console.log('=============================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
