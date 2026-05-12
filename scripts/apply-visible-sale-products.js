#!/usr/bin/env node
/**
 * Apply a visible sale to all ACTIVE Shopify product variants.
 *
 * Updates variant price and compareAtPrice so the discount appears on
 * product pages and collection pages.
 *
 * Default discount: 5%
 *   oldPrice = Number(variant.price)
 *   newPrice = round(oldPrice * 0.95, 2)
 *   compareAtPrice = oldPrice
 *
 * Skips variants already on real sale (compareAtPrice > price).
 *
 * Defaults to DRY RUN. Pass --apply to perform writes.
 *
 * Usage:
 *   node scripts/apply-visible-sale-products.js
 *   node scripts/apply-visible-sale-products.js --apply --limit=5
 *   node scripts/apply-visible-sale-products.js --apply
 *   node scripts/apply-visible-sale-products.js --apply --percent=15
 *
 * Logs:  logs/apply-visible-sale-products-YYYY-MM-DD-HH-mm.json
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isAlreadyOnSale(variant) {
  const price = Number(variant.price);
  const compareAtPrice = Number(variant.compareAtPrice);
  return (
    variant.compareAtPrice != null &&
    Number.isFinite(price) &&
    Number.isFinite(compareAtPrice) &&
    compareAtPrice > price
  );
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
  log(`Access token acquired (scopes: ${json.scope || '(none)'}, expires in ${json.expires_in || '?'}s)`);
  return json.access_token;
}

// ---------- GraphQL with smart retry ----------

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

// ---------- Mutation ----------

async function bulkUpdateVariants(productId, variants) {
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
    { productId, variants },
    `bulk update ${productId}`,
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
  const opts = { apply: false, limit: null, percent: 5 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') opts.apply = true;
    else if (a.startsWith('--percent=')) {
      const v = Number.parseFloat(a.slice('--percent='.length));
      if (Number.isFinite(v) && v > 0 && v < 100) opts.percent = v;
    } else if (a === '--percent') {
      const v = Number.parseFloat(args[++i]);
      if (Number.isFinite(v) && v > 0 && v < 100) opts.percent = v;
    } else if (a.startsWith('--limit=')) {
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
  const discountFactor = opts.percent / 100;

  log(`Mode: ${mode}`);
  log(`Discount: ${opts.percent}%`);
  if (opts.limit) log(`Limit: ${opts.limit} variants`);

  ACCESS_TOKEN = await fetchAccessToken();

  // Scan all active products
  let totalActive = 0;
  let totalVariantsScanned = 0;
  const eligibleChanges = [];
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
            vendor
            productType
            status
            tags
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
      for (const v of product.variants.nodes) {
        totalVariantsScanned++;
        const price = Number(v.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        if (isAlreadyOnSale(v)) continue;

        const oldPrice = price;
        const newPrice = round2(oldPrice * (1 - discountFactor));
        const oldCompareAtPrice = v.compareAtPrice;
        const newCompareAtPrice = String(round2(oldPrice));

        eligibleChanges.push({
          productId: product.id,
          variantId: v.id,
          title: product.title,
          handle: product.handle,
          sku: v.sku || '',
          vendor: product.vendor || '',
          productType: product.productType || '',
          tags: product.tags || [],
          oldPrice: String(round2(oldPrice)),
          newPrice: String(newPrice),
          oldCompareAtPrice: v.compareAtPrice,
          newCompareAtPrice,
        });
      }
    }

    if (totalActive % 100 === 0 || !pageInfo.hasNextPage) {
      log(`Scanned ${totalActive} products, ${totalVariantsScanned} variants... (page ${page})`);
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await sleep(200);
  }

  // Group by product for bulk updates
  const productMap = new Map();
  for (const change of eligibleChanges) {
    if (!productMap.has(change.productId)) {
      productMap.set(change.productId, {
        productId: change.productId,
        title: change.title,
        handle: change.handle,
        vendor: change.vendor,
        productType: change.productType,
        tags: change.tags,
        variants: [],
      });
    }
    productMap.get(change.productId).variants.push(change);
  }

  const productsAffected = productMap.size;
  const totalEligible = eligibleChanges.length;

  // Write backup log (always)
  await fs.mkdir(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(LOG_DIR, `apply-visible-sale-products-${timestamp}.json`);
  await fs.writeFile(backupPath, JSON.stringify({
    mode,
    timestamp: nowIso(),
    discountPercent: opts.percent,
    totalActive,
    totalVariantsScanned,
    totalEligible,
    productsAffected,
    changes: eligibleChanges,
  }, null, 2));

  log(`Total active products scanned: ${totalActive}`);
  log(`Total variants scanned: ${totalVariantsScanned}`);
  log(`Total variants eligible for visible sale: ${totalEligible}`);
  log(`Total products affected: ${productsAffected}`);
  log(`Backup log: ${backupPath}`);

  if (totalEligible === 0) {
    log('No eligible variants. Nothing to do.');
    return;
  }

  // Print first 20 examples
  console.log();
  console.log('--- First 20 eligible variants ---');
  const examples = eligibleChanges.slice(0, 20);
  for (const ex of examples) {
    console.log(`  SKU: ${ex.sku.padEnd(16)} | ${ex.title.slice(0, 40)} | handle: ${ex.handle} | old: ${ex.oldPrice} → new: ${ex.newPrice} | compareAt: ${ex.oldCompareAtPrice} → ${ex.newCompareAtPrice}`);
  }

  if (!opts.apply) {
    console.log();
    console.log('DRY RUN: No changes made. Pass --apply to apply the sale.');
    return;
  }

  // Apply: bulk update per product
  console.log();
  log('APPLY: Updating prices and compareAtPrice...');

  const productsToUpdate = opts.limit
    ? Array.from(productMap.values()).slice(0, opts.limit)
    : Array.from(productMap.values());

  let updatedVariants = 0;
  let failedProducts = 0;
  const actionResults = [];
  let variantsApplied = 0;

  for (let i = 0; i < productsToUpdate.length; i++) {
    const p = productsToUpdate[i];
    const variantInputs = p.variants.map((v) => ({
      id: v.variantId,
      price: v.newPrice,
      compareAtPrice: v.newCompareAtPrice,
    }));

    try {
      const result = await bulkUpdateVariants(p.productId, variantInputs);
      if (!result.success) {
        failedProducts++;
        log(`  FAIL [${i + 1}/${productsToUpdate.length}] ${p.handle}: ${result.errors.join('; ')}`);
        actionResults.push({ ...p, status: 'failed', errors: result.errors });
      } else {
        updatedVariants += variantInputs.length;
        variantsApplied += variantInputs.length;
        log(`  OK [${i + 1}/${productsToUpdate.length}] ${p.handle}: ${variantInputs.length} variants updated`);
        actionResults.push({ ...p, status: 'updated', variantCount: variantInputs.length });
      }
    } catch (e) {
      failedProducts++;
      log(`  ERROR [${i + 1}/${productsToUpdate.length}] ${p.handle}: ${e.message.slice(0, 150)}`);
      actionResults.push({ ...p, status: 'error', error: String(e.message).slice(0, 200) });
      if (e.isSchemaError) {
        log('  SCHEMA ERROR: stopping immediately.');
        break;
      }
    }

    if (opts.limit && variantsApplied >= opts.limit) {
      log(`  Limit reached: ${variantsApplied} variants updated.`);
      break;
    }

    if ((i + 1) % 20 === 0) {
      log(`  Progress: ${i + 1}/${productsToUpdate.length} products processed...`);
    }

    await sleep(300);
  }

  console.log();
  console.log('========== Results ==========');
  console.log(`Mode:                  ${mode}`);
  console.log(`Discount:              ${opts.percent}%`);
  console.log(`Total active:          ${totalActive}`);
  console.log(`Variants scanned:      ${totalVariantsScanned}`);
  console.log(`Eligible variants:     ${totalEligible}`);
  console.log(`Products affected:     ${productsAffected}`);
  console.log(`Updated variants:      ${updatedVariants}`);
  console.log(`Failed products:       ${failedProducts}`);
  console.log(`Backup log:            ${backupPath}`);
  if (opts.limit) console.log(`Limit:                 ${opts.limit}`);
  console.log('=============================');

  // Append results to backup log
  const backupData = JSON.parse(await fs.readFile(backupPath, 'utf-8'));
  backupData.results = actionResults;
  backupData.updatedVariants = updatedVariants;
  backupData.failedProducts = failedProducts;
  await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2));
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
