#!/usr/bin/env node
/**
 * Remove compareAtPrice from all ACTIVE products where at least one variant has:
 *   Number(compareAtPrice) > Number(price)
 *
 * Defaults to DRY RUN. Pass --apply to perform writes.
 *
 * Usage:
 *   node scripts/remove-real-sale-compare-at-prices.js
 *   node scripts/remove-real-sale-compare-at-prices.js --apply
 *
 * Logs:  logs/remove-real-sale-compare-at-prices-YYYY-MM-DD-HH-mm.json
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
    err.isValidationError = msg.includes('message') && !msg.includes('THROTTLED') && !msg.includes('rate limit');
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

// Mutation: productVariantsBulkUpdate
// Only sets compareAtPrice to null on specified variant IDs.
// Does NOT touch price, sku, inventory, or any other field.
async function bulkClearCompareAtPrice(productId, variantIds) {
  const input = variantIds.map((id) => ({
    id,
    compareAtPrice: null,
  }));
  const data = await gqlWithRetry(
    `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product { id }
        productVariants {
          id
          sku
          price
          compareAtPrice
        }
        userErrors { field message }
      }
    }`,
    { productId, variants: input },
    `bulk clear ${productId}`,
  );
  const result = data.productVariantsBulkUpdate;
  const errors = result.userErrors || [];
  if (errors.length > 0) {
    return { success: false, errors: errors.map((e) => `${e.field?.join('.') || ''}: ${e.message}`) };
  }
  return { success: true, updated: (result.productVariants || []).length };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { apply: false, limit: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') opts.apply = true;
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

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);
  const mode = opts.apply ? 'APPLY' : 'DRY';

  log(`Mode: ${mode}`);
  if (opts.limit) log(`Limit: ${opts.limit} variants`);

  ACCESS_TOKEN = await fetchAccessToken();

  let totalActive = 0;
  let saleProducts = 0;
  let saleVariants = 0;
  const examples = [];
  const allChanges = [];
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
      let productSaleVariants = [];

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
          productSaleVariants.push(v);
          if (examples.length < 20) {
            examples.push({
              sku: v.sku || '(no sku)',
              title: product.title,
              handle: product.handle,
              price: v.price,
              compareAtPrice: v.compareAtPrice,
              variantId: v.id,
              productId: product.id,
            });
          }
        }
      }

      if (productHasSale) {
        saleProducts++;
        saleVariants += productSaleVariants.length;
        allChanges.push({
          productId: product.id,
          productTitle: product.title,
          handle: product.handle,
          variants: productSaleVariants.map((v) => ({
            variantId: v.id,
            sku: v.sku || '',
            price: v.price,
            oldCompareAtPrice: v.compareAtPrice,
            newCompareAtPrice: null,
          })),
        });
      }
    }

    if (totalActive % 100 === 0 || !pageInfo.hasNextPage) {
      log(`Scanned ${totalActive} products... (page ${page})`);
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await sleep(200);
  }

  log(`Total active products scanned: ${totalActive}`);
  log(`Total products with real sale variants: ${saleProducts}`);
  log(`Total sale variants found: ${saleVariants}`);

  if (saleVariants === 0) {
    log('No sale variants found. Nothing to do.');
    return;
  }

  console.log();
  console.log('--- First 20 sale examples ---');
  for (const ex of examples) {
    console.log(`  SKU: ${ex.sku.padEnd(16)} | ${ex.title.slice(0, 50)} | handle: ${ex.handle} | price: ${ex.price} | compareAt: ${ex.compareAtPrice}`);
  }

  if (!opts.apply) {
    console.log();
    console.log('DRY RUN: No changes made. Pass --apply to clear compareAtPrice.');
    // Still write log for dry run
    await fs.mkdir(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(LOG_DIR, `remove-real-sale-compare-at-prices-${timestamp}.json`);
    await fs.writeFile(reportPath, JSON.stringify({
      mode: 'DRY',
      timestamp: nowIso(),
      totalActive,
      saleProducts,
      saleVariants,
      examples,
      allChanges,
    }, null, 2));
    log(`Report: ${reportPath}`);
    return;
  }

  // APPLY: clear compareAtPrice in batches (one batch per product)
  console.log();
  log('APPLY: Clearing compareAtPrice on sale variants...');

  let updatedProducts = 0;
  let updatedVariants = 0;
  let errorCount = 0;
  const appliedResults = [];
  let variantsApplied = 0;

  for (let i = 0; i < allChanges.length; i++) {
    const change = allChanges[i];
    let variantIds = change.variants.map((v) => v.variantId);

    if (opts.limit) {
      const remaining = opts.limit - variantsApplied;
      if (remaining <= 0) break;
      if (variantIds.length > remaining) {
        variantIds = variantIds.slice(0, remaining);
      }
    }

    try {
      const result = await bulkClearCompareAtPrice(change.productId, variantIds);
      if (!result.success) {
        errorCount++;
        log(`  FAIL [${i + 1}/${allChanges.length}] ${change.handle}: ${result.errors.join('; ')}`);
        appliedResults.push({ ...change, status: 'failed', errors: result.errors, variantIdsApplied: variantIds });
      } else {
        updatedProducts++;
        updatedVariants += variantIds.length;
        variantsApplied += variantIds.length;
        log(`  OK [${i + 1}/${allChanges.length}] ${change.handle}: ${variantIds.length} variants cleared`);
        appliedResults.push({ ...change, status: 'updated', variantIdsApplied: variantIds });
      }
    } catch (e) {
      errorCount++;
      log(`  ERROR [${i + 1}/${allChanges.length}] ${change.handle}: ${e.message.slice(0, 150)}`);
      appliedResults.push({ ...change, status: 'error', error: String(e.message).slice(0, 200), variantIdsApplied: variantIds });
      if (e.isSchemaError) {
        log('  SCHEMA ERROR: stopping immediately.');
        break;
      }
    }

    if (opts.limit && variantsApplied >= opts.limit) {
      log(`  Limit reached: ${variantsApplied}/${opts.limit} variants updated.`);
      break;
    }

    if ((i + 1) % 20 === 0) {
      log(`  Progress: ${i + 1}/${allChanges.length} products processed...`);
    }

    await sleep(300);
  }

  console.log();
  console.log('========== Results ==========');
  console.log(`Total active products scanned: ${totalActive}`);
  console.log(`Products with sale variants:   ${saleProducts}`);
  console.log(`Sale variants found:           ${saleVariants}`);
  console.log(`Updated products:              ${updatedProducts}`);
  console.log(`Updated variants:              ${updatedVariants}`);
  console.log(`Errors:                        ${errorCount}`);
  if (opts.limit) console.log(`Limit:                       ${opts.limit}`);
  console.log('=============================');

  // Write log
  await fs.mkdir(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(LOG_DIR, `remove-real-sale-compare-at-prices-${timestamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify({
    mode: 'APPLY',
    timestamp: nowIso(),
    totalActive,
    saleProducts,
    saleVariants,
    updatedProducts,
    updatedVariants,
    errors: errorCount,
    limit: opts.limit || null,
    results: appliedResults,
  }, null, 2));
  log(`Report: ${reportPath}`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
