#!/usr/bin/env node
/**
 * Delete (or archive) ACTIVE Shopify products that are truly on sale.
 *
 * A product is targeted only if at least one variant has:
 *   compareAtPrice != null && Number(compareAtPrice) > Number(price)
 *
 * Defaults to DRY RUN.
 *
 * Delete mode:
 *   --apply --confirm-delete-sale-products
 *
 * Archive mode (safer):
 *   --archive --confirm-archive-sale-products
 *
 * Usage:
 *   node scripts/delete-real-sale-products.js
 *   node scripts/delete-real-sale-products.js --apply --confirm-delete-sale-products --limit=5
 *   node scripts/delete-real-sale-products.js --apply --confirm-delete-sale-products
 *   node scripts/delete-real-sale-products.js --archive --confirm-archive-sale-products --limit=5
 *   node scripts/delete-real-sale-products.js --archive --confirm-archive-sale-products
 *
 * Logs:  logs/delete-real-sale-products-YYYY-MM-DD-HH-mm.json
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

function isRealSaleVariant(variant) {
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

// ---------- Mutations ----------

async function deleteProduct(productId) {
  const data = await gqlWithRetry(
    `mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }`,
    { input: { id: productId } },
    `delete ${productId}`,
  );
  const result = data.productDelete;
  const errors = result.userErrors || [];
  if (errors.length > 0) {
    return { success: false, errors: errors.map((e) => `${e.field?.join('.') || ''}: ${e.message}`) };
  }
  return { success: true, deletedId: result.deletedProductId };
}

async function archiveProduct(productId) {
  const data = await gqlWithRetry(
    `mutation productUpdateStatus($input: ProductStatusInput!) {
      productUpdateStatus(input: $input) {
        product { id status }
        userErrors { field message }
      }
    }`,
    { input: { id: productId, status: 'ARCHIVED' } },
    `archive ${productId}`,
  );
  const result = data.productUpdateStatus;
  const errors = result.userErrors || [];
  if (errors.length > 0) {
    return { success: false, errors: errors.map((e) => `${e.field?.join('.') || ''}: ${e.message}`) };
  }
  return { success: true, archivedId: result.product?.id };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { apply: false, archive: false, limit: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--archive') opts.archive = true;
    else if (a === '--confirm-delete-sale-products') opts.confirmDelete = true;
    else if (a === '--confirm-archive-sale-products') opts.confirmArchive = true;
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

  if (opts.apply && opts.archive) {
    console.error('ERROR: --apply and --archive cannot be used together. Choose one.');
    process.exit(1);
  }

  const isDelete = opts.apply;
  const isArchive = opts.archive;
  const isDry = !isDelete && !isArchive;

  if (isDelete && !opts.confirmDelete) {
    console.error('ERROR: --apply requires --confirm-delete-sale-products for safety.');
    console.error('Usage: node scripts/delete-real-sale-products.js --apply --confirm-delete-sale-products');
    process.exit(1);
  }

  if (isArchive && !opts.confirmArchive) {
    console.error('ERROR: --archive requires --confirm-archive-sale-products for safety.');
    console.error('Usage: node scripts/delete-real-sale-products.js --archive --confirm-archive-sale-products');
    process.exit(1);
  }

  const mode = isDelete ? 'DELETE' : isArchive ? 'ARCHIVE' : 'DRY';

  log(`Mode: ${mode}`);
  if (opts.limit) log(`Limit: ${opts.limit} products`);

  ACCESS_TOKEN = await fetchAccessToken();

  // Scan all active products
  let totalActive = 0;
  const targetedProducts = [];
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
      const saleVariants = product.variants.nodes.filter(isRealSaleVariant);
      if (saleVariants.length > 0) {
        targetedProducts.push({
          productId: product.id,
          title: product.title,
          handle: product.handle,
          vendor: product.vendor || '',
          productType: product.productType || '',
          tags: product.tags || [],
          allVariants: product.variants.nodes.map((v) => ({
            id: v.id,
            sku: v.sku || '',
            price: v.price,
            compareAtPrice: v.compareAtPrice,
          })),
          saleVariants: saleVariants.map((v) => ({
            id: v.id,
            sku: v.sku || '',
            price: v.price,
            compareAtPrice: v.compareAtPrice,
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

  // Write backup log (always, even for dry run)
  await fs.mkdir(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(LOG_DIR, `delete-real-sale-products-${timestamp}.json`);
  await fs.writeFile(backupPath, JSON.stringify({
    mode,
    timestamp: nowIso(),
    totalActive,
    targetedCount: targetedProducts.length,
    totalSaleVariants: targetedProducts.reduce((sum, p) => sum + p.saleVariants.length, 0),
    targetedProducts,
  }, null, 2));

  const totalSaleVariants = targetedProducts.reduce((sum, p) => sum + p.saleVariants.length, 0);

  log(`Total active products scanned: ${totalActive}`);
  log(`Total products targeted: ${targetedProducts.length}`);
  log(`Total sale variants found: ${totalSaleVariants}`);
  log(`Backup log: ${backupPath}`);

  if (targetedProducts.length === 0) {
    log('No products targeted. Nothing to do.');
    return;
  }

  // Print first 30 examples
  console.log();
  console.log('--- First 30 targeted products ---');
  const examples = targetedProducts.slice(0, 30);
  for (const p of examples) {
    const sv = p.saleVariants[0];
    console.log(`  ${p.handle.padEnd(24)} | ${p.title.slice(0, 45)} | sku: ${sv.sku.padEnd(14)} | price: ${sv.price} | compareAt: ${sv.compareAtPrice}`);
  }

  if (isDry) {
    console.log();
    console.log('DRY RUN: No changes made.');
    console.log('To delete:  node scripts/delete-real-sale-products.js --apply --confirm-delete-sale-products');
    console.log('To archive: node scripts/delete-real-sale-products.js --archive --confirm-archive-sale-products');
    return;
  }

  // Apply: delete or archive
  console.log();
  const actionLabel = isDelete ? 'Deleting' : 'Archiving';
  log(`${actionLabel} products...`);

  const productsToDelete = opts.limit ? targetedProducts.slice(0, opts.limit) : targetedProducts;
  let successCount = 0;
  let failCount = 0;
  const actionResults = [];

  for (let i = 0; i < productsToDelete.length; i++) {
    const p = productsToDelete[i];

    try {
      let result;
      if (isDelete) {
        result = await deleteProduct(p.productId);
      } else {
        result = await archiveProduct(p.productId);
      }

      if (!result.success) {
        failCount++;
        log(`  FAIL [${i + 1}/${productsToDelete.length}] ${p.handle}: ${result.errors.join('; ')}`);
        actionResults.push({ ...p, status: 'failed', errors: result.errors });
      } else {
        successCount++;
        log(`  OK [${i + 1}/${productsToDelete.length}] ${p.handle}`);
        actionResults.push({ ...p, status: isDelete ? 'deleted' : 'archived' });
      }
    } catch (e) {
      failCount++;
      log(`  ERROR [${i + 1}/${productsToDelete.length}] ${p.handle}: ${e.message.slice(0, 150)}`);
      actionResults.push({ ...p, status: 'error', error: String(e.message).slice(0, 200) });
      if (e.isSchemaError) {
        log('  SCHEMA ERROR: stopping immediately.');
        break;
      }
    }

    if ((i + 1) % 20 === 0) {
      log(`  Progress: ${i + 1}/${productsToDelete.length} products processed...`);
    }

    await sleep(300);
  }

  console.log();
  console.log('========== Results ==========');
  console.log(`Mode:              ${mode}`);
  console.log(`Total active:      ${totalActive}`);
  console.log(`Targeted:          ${targetedProducts.length}`);
  console.log(`Processed:         ${productsToDelete.length}`);
  console.log(`${isDelete ? 'Deleted' : 'Archived'}:          ${successCount}`);
  console.log(`Failed:            ${failCount}`);
  console.log(`Backup log:        ${backupPath}`);
  if (opts.limit) console.log(`Limit:             ${opts.limit}`);
  console.log('=============================');

  // Append results to backup log
  const backupData = JSON.parse(await fs.readFile(backupPath, 'utf-8'));
  backupData.results = actionResults;
  backupData.successCount = successCount;
  backupData.failCount = failCount;
  await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2));
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
