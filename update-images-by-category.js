#!/usr/bin/env node
/**
 * Update Shopify product images for existing products from a supplier XML category.
 *
 * Finds products by category in the XML feed, matches them to existing Shopify
 * products by SKU (or handle "mc-{SKU}"), and replaces their images.
 *
 * Defaults to DRY RUN. Pass --apply to perform writes.
 *
 * Usage:
 *   node update-images-by-category.js --feed=symetron --category="Daybeds" --dry-run --limit=3
 *   node update-images-by-category.js --feed=main --category="Παιδικό δωμάτιο" --dry-run --limit=3
 *   node update-images-by-category.js --feed=main --category="Σαλόνια - γωνίες" --apply
 *   node update-images-by-category.js --feed=symetron --category="Daybeds" --apply
 *
 * Logs:  logs/category-image-update-DRY-<timestamp>.json
 *        logs/category-image-update-APPLY-<timestamp>.json
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

// ---------- Shopify auth ----------

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

// ---------- Feed resolution ----------

async function resolveFeedXml(feed) {
  if (!feed) return null;
  const { execSync } = await import('node:child_process');
  try {
    const result = execSync(
      `node scripts/resolve_b2bmarkt_feed.js --feed=${feed}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] }
    );
    return result.trim();
  } catch (e) {
    console.error(`ERROR: Could not resolve feed "${feed}".`);
    process.exit(1);
  }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    feed: null,
    xmlPath: null,
    category: null,
    apply: false,
    limit: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--feed=')) {
      opts.feed = a.slice('--feed='.length);
    } else if (a.startsWith('--xml=')) {
      opts.xmlPath = a.slice('--xml='.length);
    } else if (a.startsWith('--category=')) {
      opts.category = a.slice('--category='.length);
    } else if (a === '--apply') {
      opts.apply = true;
    } else if (a === '--dry-run' || a === '-n') {
      opts.apply = false;
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
  if (Array.isArray(node)) {
    if (node.length > 0 && node[0] && node[0][productTag]) return node[0][productTag];
    if (node.length > 0 && typeof node[0] === 'object' && node[0].Product) return node[0].Product;
    return null;
  }
  if (node[productTag]) return node[productTag];
  if (node.Product) return node.Product;
  for (const key of Object.keys(node)) {
    const result = findProductArray(node[key], productTag);
    if (result) return result;
  }
  return null;
}

function parseXmlProducts(xmlText, productTag) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    attributesGroupName: '$attrs',
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, productTag || 'Product');
  if (!products || !Array.isArray(products)) {
    throw new Error(`No <${productTag || 'Product'}> array found in XML`);
  }
  return products;
}

function getCategoryList(productNode) {
  const cats = productNode?.Categories;
  if (!cats) return [];
  const list = cats.Category || [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((c) => ({
    id: c?.$attrs?.id || '',
    level: c?.$attrs?.level || '',
    text: extractText(c),
  }));
}

function normalizeCategory(cat) {
  if (!cat) return '';
  return cat.replace(/\[L\d*\]\s*/gi, '').trim();
}

function getImages(productNode) {
  const loc = productNode?.ImagesLocation;
  if (!loc) return [];
  const imgs = loc.image || [];
  const arr = Array.isArray(imgs) ? imgs : [imgs];
  return arr.map(extractText).filter(Boolean);
}

// ---------- Validate image URL ----------

const VALID_IMAGE_RE = /\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i;

function validateImageUrl(url) {
  if (!url) return { valid: false, reason: 'empty URL' };
  if (!VALID_IMAGE_RE.test(url)) return { valid: false, reason: 'not a recognized image extension' };
  return { valid: true };
}

// ---------- Process images for a product ----------

function processImages(rawImages) {
  const normalized = [];
  for (const src of rawImages) {
    if (src.endsWith('/.jpg') || src.includes('/.jpg?')) {
      continue;
    }
    const validation = validateImageUrl(src);
    if (!validation.valid) continue;
    normalized.push(src);
  }

  const seen = new Set();
  const unique = [];
  for (const src of normalized) {
    if (!seen.has(src)) {
      seen.add(src);
      unique.push(src);
    }
  }

  const capped = unique.slice(0, 10);
  return capped.map((src, i) => ({ src, pos: i + 1 }));
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
    err.throttled = msg.includes('THROTTLED') || msg.includes('rate limit');
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

// ---------- Find product by SKU or handle ----------

async function findProductBySku(sku) {
  const data = await gqlWithRetry(
    `query productBySku($sku: String!) {
      productVariants(first: 1, query: $sku) {
        nodes {
          id
          sku
          product {
            id
            title
            handle
            media(first: 50) {
              nodes {
                id
                alt
                status
                mediaContentType
                ... on MediaImage {
                  image { url }
                }
              }
            }
          }
        }
      }
    }`,
    { sku },
    `find sku ${sku}`,
  );
  const nodes = data.productVariants?.nodes || [];
  if (nodes.length > 0) return nodes[0].product;
  return null;
}

async function findProductByHandle(handle) {
  const data = await gqlWithRetry(
    `query productByHandle($handle: String!) {
      productByHandle(handle: $handle) {
        id
        title
        handle
        media(first: 50) {
          nodes {
            id
            alt
            status
            mediaContentType
            ... on MediaImage {
              image { url }
            }
          }
        }
      }
    }`,
    { handle },
    `find handle ${handle}`,
  );
  return data.productByHandle;
}

async function findProduct(sku) {
  let product = await findProductBySku(sku);
  if (product) return product;
  const handle = `mc-${sku}`;
  product = await findProductByHandle(handle);
  if (product) return product;
  return null;
}

// ---------- Delete media ----------

async function deleteMedia(productId, mediaIds) {
  if (!mediaIds.length) return { success: true, deleted: 0 };
  const data = await gqlWithRetry(
    `mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
        deletedMediaIds
        userErrors { field message }
      }
    }`,
    { productId, mediaIds },
    `delete media ${productId}`,
  );
  const result = data.productDeleteMedia;
  const errors = result.userErrors || [];
  if (errors.length > 0) {
    return { success: false, deleted: 0, errors: errors.map((e) => e.message) };
  }
  return { success: true, deleted: (result.deletedMediaIds || []).length };
}

// ---------- Create media ----------

async function createMedia(productId, images) {
  if (!images.length) return { success: true, created: 0 };
  const mediaInput = images.map((img) => ({
    alt: '',
    mediaContentType: 'IMAGE',
    originalSource: img.src,
  }));
  const data = await gqlWithRetry(
    `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          id
          alt
          mediaContentType
          ... on MediaImage {
            image { url }
          }
        }
        userErrors { field message }
      }
    }`,
    { productId, media: mediaInput },
    `create media ${productId}`,
  );
  const result = data.productCreateMedia;
  const errors = result.userErrors || [];
  if (errors.length > 0) {
    return { success: false, created: 0, errors: errors.map((e) => e.message) };
  }
  return { success: true, created: (result.media || []).length };
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);
  const mode = opts.apply ? 'APPLY' : 'DRY';

  if (!opts.category) {
    console.error('ERROR: --category is required');
    process.exit(1);
  }

  log(`Mode: ${mode}`);
  log(`Category: ${opts.category}`);
  if (opts.feed) log(`Feed: ${opts.feed}`);
  if (opts.xmlPath) log(`XML: ${opts.xmlPath}`);
  if (opts.limit) log(`Limit: ${opts.limit}`);

  // Resolve feed
  let xmlPath = opts.xmlPath;
  if (!xmlPath && opts.feed) {
    xmlPath = await resolveFeedXml(opts.feed);
  }
  if (!xmlPath) {
    console.error('ERROR: No feed or XML path provided. Use --feed=main|symetron or --xml=path');
    process.exit(1);
  }

  // Parse XML
  log(`Reading XML: ${xmlPath}`);
  const xmlText = await fs.readFile(xmlPath, 'utf-8');
  const allProducts = parseXmlProducts(xmlText, 'Product');
  log(`Total products in XML: ${allProducts.length}`);

  // Filter by category
  const categoryProducts = [];
  for (const p of allProducts) {
    const cats = getCategoryList(p);
    for (const cat of cats) {
      const normalized = normalizeCategory(cat.text);
      if (normalized === opts.category || cat.text === opts.category) {
        categoryProducts.push(p);
        break;
      }
    }
  }
  log(`Products in category "${opts.category}": ${categoryProducts.length}`);

  if (categoryProducts.length === 0) {
    log('No products found in this category. Exiting.');
    process.exit(0);
  }

  // Auth
  ACCESS_TOKEN = await fetchAccessToken();

  // Process each product
  const productsToProcess = opts.limit ? categoryProducts.slice(0, opts.limit) : categoryProducts;
  const results = [];
  let matchedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < productsToProcess.length; i++) {
    const p = productsToProcess[i];
    const sku = extractText(p.ProductCode);
    const rawImages = getImages(p);
    const images = processImages(rawImages);

    const result = {
      sku,
      handle: null,
      productTitle: null,
      productId: null,
      status: 'pending',
      currentImageCount: 0,
      newImageCount: images.length,
      newImageUrls: images.slice(0, 3).map((img) => img.src),
      errors: [],
    };

    if (!sku) {
      result.status = 'no_sku';
      skippedCount++;
      log(`  [${i + 1}/${productsToProcess.length}] SKIP: no ProductCode`);
      results.push(result);
      continue;
    }

    try {
      // Find product in Shopify
      const product = await findProduct(sku);
      if (!product) {
        result.status = 'not_found';
        skippedCount++;
        log(`  [${i + 1}/${productsToProcess.length}] SKIP ${sku}: not found in Shopify`);
        results.push(result);
        continue;
      }

      result.productId = product.id;
      result.handle = product.handle;
      result.productTitle = product.title;
      result.currentImageCount = (product.media?.nodes || []).length;
      matchedCount++;

      if (!opts.apply) {
        // DRY RUN
        result.status = 'dry_run';
        log(`  [${i + 1}/${productsToProcess.length}] DRY ${sku} (${product.handle}) "${product.title}": ${result.currentImageCount} → ${result.newImageCount} images`);
        if (result.newImageUrls.length > 0) {
          log(`    First URLs: ${result.newImageUrls.join(', ')}`);
        }
      } else {
        // APPLY: delete existing media, create new
        const existingNodes = product.media?.nodes || [];
        const failedMedia = existingNodes.filter((m) => m.status === 'FAILED');
        if (failedMedia.length > 0) {
          log(`  [${i + 1}/${productsToProcess.length}] WARN ${sku}: ${failedMedia.length} failed media from previous runs`);
        }
        const existingIds = existingNodes.map((m) => m.id);

        if (existingIds.length > 0) {
          const delResult = await deleteMedia(product.id, existingIds);
          if (!delResult.success) {
            result.status = 'delete_failed';
            result.errors = delResult.errors;
            errorCount++;
            log(`  [${i + 1}/${productsToProcess.length}] FAIL ${sku}: delete failed — ${delResult.errors.join('; ')}`);
            results.push(result);
            continue;
          }
          await sleep(200);
        }

        if (images.length > 0) {
          const createResult = await createMedia(product.id, images);
          if (!createResult.success) {
            result.status = 'create_failed';
            result.errors = createResult.errors;
            errorCount++;
            log(`  [${i + 1}/${productsToProcess.length}] FAIL ${sku}: create failed — ${createResult.errors.join('; ')}`);
            results.push(result);
            continue;
          }
        }

        result.status = 'updated';
        log(`  [${i + 1}/${productsToProcess.length}] OK ${sku} (${product.handle}) "${product.title}": ${result.currentImageCount} → ${result.newImageCount} images`);
      }

      results.push(result);
    } catch (e) {
      result.status = 'error';
      result.errors = [String(e.message).slice(0, 200)];
      errorCount++;
      log(`  [${i + 1}/${productsToProcess.length}] ERROR ${sku}: ${e.message.slice(0, 150)}`);
      results.push(result);
    }

    // Rate limit pause
    if (!opts.apply) {
      await sleep(100);
    } else {
      await sleep(500);
    }
  }

  // Write report
  await fs.mkdir(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(LOG_DIR, `category-image-update-${mode}-${timestamp}.json`);
  const report = {
    mode,
    category: opts.category,
    feed: opts.feed,
    timestamp: nowIso(),
    totalXmlProductsInCategory: categoryProducts.length,
    matched: matchedCount,
    skipped: skippedCount,
    errors: errorCount,
    results,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  log(`Report: ${reportPath}`);

  // Summary
  console.log();
  console.log('========== Summary ==========');
  console.log(`Mode:          ${mode}`);
  console.log(`Category:      ${opts.category}`);
  console.log(`Feed:          ${opts.feed || opts.xmlPath}`);
  console.log(`XML products:  ${categoryProducts.length}`);
  console.log(`Matched:       ${matchedCount}`);
  console.log(`Skipped:       ${skippedCount}`);
  console.log(`Errors:        ${errorCount}`);
  console.log(`Report:        ${reportPath}`);
  console.log('===============================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
