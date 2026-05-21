#!/usr/bin/env node
/**
 * Reduce current Shopify variant prices for ACTIVE products.
 *
 * This script intentionally does not mutate compareAtPrice. It reads
 * compareAtPrice only for logging/rollback verification.
 *
 * Formula:
 *   newPrice = round(current variant.price * (1 - percent / 100), 2)
 *
 * Defaults to DRY RUN. Real writes require --apply.
 *
 * Usage:
 *   node scripts/apply-current-price-discount.js --percent=35 --limit=10
 *   node scripts/apply-current-price-discount.js --percent 35 --limit 100
 *   node scripts/apply-current-price-discount.js --percent=35
 *   node scripts/apply-current-price-discount.js --apply --percent=35 --concurrency=2
 *
 * Logs: logs/current-price-discount-YYYY-MM-DDTHH-mm-ss-sssZ.json
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parsePercent(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
    throw new Error('--percent must be greater than 0 and less than 100');
  }
  return parsed;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    apply: false,
    percent: null,
    limit: null,
    concurrency: 2,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--dry-run' || arg === '-n') {
      opts.apply = false;
    } else if (arg.startsWith('--percent=')) {
      opts.percent = parsePercent(arg.slice('--percent='.length));
    } else if (arg === '--percent') {
      opts.percent = parsePercent(args[++i]);
    } else if (arg.startsWith('--limit=')) {
      opts.limit = parsePositiveInt(arg.slice('--limit='.length), '--limit');
    } else if (arg === '--limit') {
      opts.limit = parsePositiveInt(args[++i], '--limit');
    } else if (arg.startsWith('--concurrency=')) {
      opts.concurrency = parsePositiveInt(arg.slice('--concurrency='.length), '--concurrency');
    } else if (arg === '--concurrency') {
      opts.concurrency = parsePositiveInt(args[++i], '--concurrency');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (opts.percent == null) {
    throw new Error('Missing required --percent. Example: --percent=35');
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
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Access-token request failed: HTTP ${res.status} ${text.slice(0, 400)}`);
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
    err.isSchemaError = msg.includes('Field ') && msg.includes("doesn't exist on type");
    err.isThrottled = msg.includes('THROTTLED') || msg.includes('rate limit');
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
      const throttled = e.isThrottled || e.message?.includes('THROTTLED') || e.message?.includes('rate limit');
      const wait = throttled ? 5000 : Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.warn(
        `[${label}] ${throttled ? 'THROTTLED' : 'ERROR'} (try ${attempt}/${maxTries}), sleeping ${wait}ms: ${String(e.message).slice(0, 180)}`,
      );
      await sleep(wait);
    }
  }
}

async function bulkUpdateVariantPrices(productId, variants) {
  const data = await gqlWithRetry(
    `mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        product { id }
        productVariants {
          id
          sku
          price
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

async function runWithConcurrency(items, concurrency, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const current = index++;
      if (current >= items.length) return;
      await fn(items[current], current);
    }
  });
  await Promise.all(workers);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  }

  const mode = opts.apply ? 'APPLY' : 'DRY';
  const discountFactor = opts.percent / 100;
  const multiplier = 1 - discountFactor;
  const formula = `new_price = current_variant.price * ${multiplier.toFixed(4)}`;

  log(`Mode: ${mode}`);
  log(`Percent: ${opts.percent}%`);
  log(`Formula: ${formula}`);
  log('CompareAtPrice touched: NO');
  log(`Concurrency: ${opts.concurrency}`);
  if (opts.limit) log(`Limit: ${opts.limit} selected variant(s)`);

  ACCESS_TOKEN = await fetchAccessToken();

  let totalActiveProducts = 0;
  let totalVariantsChecked = 0;
  let skippedInvalidPrice = 0;
  let skippedUnchanged = 0;
  const selectedChanges = [];
  let cursor = null;
  let page = 0;
  let reachedLimit = false;

  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query activeProducts($cursor: String) {
        products(first: 100, after: $cursor, query: "status:ACTIVE") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            handle
            variants(first: 250) {
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
      { cursor },
      `page ${page}`,
    );

    const pageInfo = data.products.pageInfo;
    for (const product of data.products.nodes) {
      totalActiveProducts++;
      for (const variant of product.variants.nodes) {
        totalVariantsChecked++;

        const oldPriceNumber = Number(variant.price);
        if (!Number.isFinite(oldPriceNumber) || oldPriceNumber <= 0) {
          skippedInvalidPrice++;
          continue;
        }

        const newPriceNumber = round2(oldPriceNumber * multiplier);
        if (round2(oldPriceNumber) === newPriceNumber) {
          skippedUnchanged++;
          continue;
        }

        selectedChanges.push({
          productId: product.id,
          productTitle: product.title,
          handle: product.handle,
          variantId: variant.id,
          sku: variant.sku || '',
          oldPrice: moneyString(oldPriceNumber),
          newPrice: moneyString(newPriceNumber),
          oldCompareAtPrice: variant.compareAtPrice,
          compareAtPriceUnchanged: true,
        });

        if (opts.limit && selectedChanges.length >= opts.limit) {
          reachedLimit = true;
          break;
        }
      }
      if (reachedLimit) break;
    }

    if (totalActiveProducts % 100 === 0 || !pageInfo.hasNextPage || reachedLimit) {
      log(`Scanned ${totalActiveProducts} active products, ${totalVariantsChecked} variants... (page ${page})`);
    }

    if (reachedLimit || !pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await sleep(200);
  }

  const selectedByProduct = new Map();
  for (const change of selectedChanges) {
    const product = selectedByProduct.get(change.productId) || {
      productId: change.productId,
      productTitle: change.productTitle,
      handle: change.handle,
      variants: [],
    };
    product.variants.push(change);
    selectedByProduct.set(change.productId, product);
  }

  await fs.mkdir(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(LOG_DIR, `current-price-discount-${timestamp}.json`);

  const logData = {
    mode,
    timestamp: nowIso(),
    store: SHOPIFY_STORE_DOMAIN,
    apiVersion: SHOPIFY_API_VERSION,
    percent: opts.percent,
    formula,
    compareAtPriceTouched: false,
    options: {
      apply: opts.apply,
      limit: opts.limit,
      concurrency: opts.concurrency,
    },
    counts: {
      totalActiveProducts,
      totalVariantsChecked,
      variantsSelected: selectedChanges.length,
      variantsUpdated: 0,
      variantsSkipped: skippedInvalidPrice + skippedUnchanged,
      skippedInvalidPrice,
      skippedUnchanged,
      failedProducts: 0,
    },
    rollback: selectedChanges,
    results: [],
  };

  await fs.writeFile(logPath, JSON.stringify(logData, null, 2));

  console.log();
  console.log('--- First 20 selected variants ---');
  for (const change of selectedChanges.slice(0, 20)) {
    console.log(
      `  SKU: ${change.sku.padEnd(16)} | ${change.productTitle.slice(0, 40)} | old: ${change.oldPrice} | new: ${change.newPrice} | compareAt unchanged: ${change.oldCompareAtPrice ?? 'null'}`,
    );
  }

  let variantsUpdated = 0;
  let failedProducts = 0;
  const results = [];

  if (!opts.apply) {
    console.log();
    console.log('DRY RUN: No changes made. Pass --apply to write price changes.');
  } else if (selectedChanges.length === 0) {
    log('APPLY: No selected variants. Nothing to update.');
  } else {
    const jobs = Array.from(selectedByProduct.values());
    log(`APPLY: Updating ${selectedChanges.length} variant price(s) across ${jobs.length} product(s).`);

    await runWithConcurrency(jobs, opts.concurrency, async (product, index) => {
      const variantInputs = product.variants.map((variant) => ({
        id: variant.variantId,
        price: variant.newPrice,
      }));

      try {
        const result = await bulkUpdateVariantPrices(product.productId, variantInputs);
        if (!result.success) {
          failedProducts++;
          results.push({ ...product, status: 'failed', errors: result.errors });
          log(`  FAIL [${index + 1}/${jobs.length}] ${product.handle}: ${result.errors.join('; ')}`);
        } else {
          variantsUpdated += variantInputs.length;
          results.push({ ...product, status: 'updated', variantCount: variantInputs.length });
          log(`  OK [${index + 1}/${jobs.length}] ${product.handle}: ${variantInputs.length} variant(s) updated`);
        }
      } catch (e) {
        failedProducts++;
        results.push({ ...product, status: 'error', error: String(e.message).slice(0, 300) });
        log(`  ERROR [${index + 1}/${jobs.length}] ${product.handle}: ${String(e.message).slice(0, 150)}`);
      }

      await sleep(300);
    });
  }

  logData.counts.variantsUpdated = variantsUpdated;
  logData.counts.failedProducts = failedProducts;
  logData.results = results;
  await fs.writeFile(logPath, JSON.stringify(logData, null, 2));

  console.log();
  console.log('========== Summary ==========');
  console.log(`Mode:                    ${mode}`);
  console.log(`Percent:                 ${opts.percent}%`);
  console.log(`Formula:                 ${formula}`);
  console.log(`Total variants checked:  ${totalVariantsChecked}`);
  console.log(`Variants selected:       ${selectedChanges.length}`);
  console.log(`Variants updated:        ${variantsUpdated}`);
  console.log(`Variants skipped:        ${skippedInvalidPrice + skippedUnchanged}`);
  console.log(`Skipped invalid price:   ${skippedInvalidPrice}`);
  console.log(`Skipped unchanged price: ${skippedUnchanged}`);
  console.log('CompareAtPrice touched:  NO');
  console.log(`Log file:                ${logPath}`);
  console.log('=============================');

  process.exit(failedProducts > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
