#!/usr/bin/env node
/**
 * Update existing Shopify product images by handle using Admin GraphQL API.
 *
 * Reads a images-only CSV (Handle, Image Src, Image Position, Image Alt Text)
 * and replaces product media for each handle.
 *
 * Defaults to DRY RUN. Pass --apply to perform writes.
 *
 * Usage:
 *   node update-product-images.js --dry-run --limit=3
 *   node update-product-images.js --apply --limit=3
 *   node update-product-images.js --dry-run
 *   node update-product-images.js --apply
 *
 * Input: symetron-all-missing-shopify-import-clean-images-only.csv (default)
 * Logs:  logs/image-update-DRY-<timestamp>.json
 *        logs/image-update-APPLY-<timestamp>.json
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

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

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    apply: false,
    limit: null,
    input: 'symetron-all-missing-shopify-import-images-only.csv',
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') {
      opts.apply = true;
    } else if (a === '--dry-run' || a === '-n') {
      opts.apply = false;
    } else if (a === '--limit') {
      const v = Number.parseInt(args[++i], 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a.startsWith('--input=')) {
      opts.input = a.slice('--input='.length);
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

// ---------- Read CSV ----------

async function readImagesCsv(inputPath) {
  const content = await fs.readFile(inputPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Parse header
  const header = parseCsvLine(lines[0]);
  const colMap = {};
  for (const name of ['Handle', 'Image Src', 'Image Position', 'Image Alt Text']) {
    const idx = header.indexOf(name);
    if (idx >= 0) colMap[name] = idx;
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const handle = (fields[colMap['Handle']] || '').trim();
    const src = (fields[colMap['Image Src']] || '').trim();
    const pos = Number.parseInt(fields[colMap['Image Position']] || '0', 10) || 0;
    const alt = (fields[colMap['Image Alt Text']] || '').trim();
    if (handle && src) {
      rows.push({ handle, src, pos, alt });
    }
  }
  return rows;
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ---------- Validate image URL ----------

const VALID_IMAGE_RE = /\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i;

function validateImageUrl(url) {
  if (!url) return { valid: false, reason: 'empty URL' };
  if (!VALID_IMAGE_RE.test(url)) return { valid: false, reason: 'not a recognized image extension' };
  return { valid: true };
}

// ---------- Find product by handle ----------

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
              image {
                url
              }
            }
          }
        }
      }
    }`,
    { handle },
    `find ${handle}`,
  );
  return data.productByHandle;
}

// ---------- Delete all media for a product ----------

async function deleteAllMedia(productId, mediaIds) {
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

// ---------- Create media for a product ----------

async function createMedia(productId, images) {
  if (!images.length) return { success: true, created: 0 };
  const mediaInput = images.map((img) => ({
    alt: img.alt || '',
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

  log(`Mode: ${mode}`);
  log(`Input: ${opts.input}`);
  if (opts.limit) log(`Limit: ${opts.limit}`);

  // Read CSV
  const allRows = await readImagesCsv(opts.input);
  log(`Total image rows in CSV: ${allRows.length}`);

  // Group by handle, normalize URLs, deduplicate, renumber
  const handleMap = new Map();
  for (const row of allRows) {
    if (!handleMap.has(row.handle)) {
      handleMap.set(row.handle, []);
    }
    handleMap.get(row.handle).push(row);
  }

  // Normalize per handle: handle /.jpg, deduplicate, renumber, cap at 10
  const handles = [];
  for (const [handle, imgs] of handleMap) {
    // Check if -1.jpg exists for this handle
    const hasMinus1 = imgs.some((img) => img.src.includes('/-1.jpg'));

    // Normalize: skip /.jpg, replace with -1.jpg only if -1.jpg already exists
    const normalized = [];
    for (const img of imgs) {
      if (img.src.endsWith('/.jpg') || img.src.includes('/.jpg?')) {
        // Skip /.jpg entirely; if -1.jpg exists, it will serve as position 1
        continue;
      }
      const validation = validateImageUrl(img.src);
      if (!validation.valid) {
        log(`  SKIP invalid URL: ${handle} — ${img.src} (${validation.reason})`);
        continue;
      }
      normalized.push(img);
    }

    // Deduplicate by URL
    const seen = new Set();
    const unique = [];
    for (const img of normalized) {
      if (!seen.has(img.src)) {
        seen.add(img.src);
        unique.push(img);
      }
    }

    // Sort by original position, then by URL
    unique.sort((a, b) => a.pos - b.pos || a.src.localeCompare(b.src));

    // Cap at MAX_SHOPIFY_IMAGES
    const capped = unique.slice(0, 10);

    // Renumber positions from 1
    for (let j = 0; j < capped.length; j++) {
      capped[j].pos = j + 1;
    }

    handleMap.set(handle, capped);
    handles.push(handle);
  }

  if (opts.limit) {
    handles.splice(opts.limit);
  }

  log(`Handles to process: ${handles.length}`);

  // Auth
  ACCESS_TOKEN = await fetchAccessToken();

  // Process each handle
  const results = [];
  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    const newImages = handleMap.get(handle);
    const result = {
      handle,
      status: 'pending',
      productId: null,
      productTitle: null,
      currentImageCount: 0,
      newImageCount: newImages.length,
      newImageUrls: newImages.slice(0, 3).map((img) => img.src),
      errors: [],
    };

    try {
      // Find product
      const product = await findProductByHandle(handle);
      if (!product) {
        result.status = 'not_found';
        skipCount++;
        log(`  [${i + 1}/${handles.length}] SKIP ${handle}: product not found`);
        results.push(result);
        continue;
      }

      result.productId = product.id;
      result.productTitle = product.title;
      result.currentImageCount = (product.media?.nodes || []).length;

      if (!opts.apply) {
        // DRY RUN
        result.status = 'dry_run';
        successCount++;
        log(`  [${i + 1}/${handles.length}] DRY ${handle} "${product.title}": ${result.currentImageCount} → ${result.newImageCount} images`);
        log(`    First URLs: ${result.newImageUrls.join(', ')}`);
      } else {
        // APPLY: delete existing media, create new
        const existingNodes = product.media?.nodes || [];
        const failedMedia = existingNodes.filter((m) => m.status === 'FAILED');
        if (failedMedia.length > 0) {
          log(`  [${i + 1}/${handles.length}] WARN ${handle}: ${failedMedia.length} failed media from previous runs detected`);
        }
        const existingIds = existingNodes.map((m) => m.id);
        if (existingIds.length > 0) {
          const delResult = await deleteAllMedia(product.id, existingIds);
          if (!delResult.success) {
            result.status = 'delete_failed';
            result.errors = delResult.errors;
            errorCount++;
            log(`  [${i + 1}/${handles.length}] FAIL ${handle}: delete failed — ${delResult.errors.join('; ')}`);
            results.push(result);
            continue;
          }
          await sleep(200);
        }

        if (newImages.length > 0) {
          const createResult = await createMedia(product.id, newImages);
          if (!createResult.success) {
            result.status = 'create_failed';
            result.errors = createResult.errors;
            errorCount++;
            log(`  [${i + 1}/${handles.length}] FAIL ${handle}: create failed — ${createResult.errors.join('; ')}`);
            results.push(result);
            continue;
          }
        }

        result.status = 'updated';
        successCount++;
        log(`  [${i + 1}/${handles.length}] OK ${handle} "${product.title}": ${result.currentImageCount} → ${result.newImageCount} images`);
      }

      results.push(result);
    } catch (e) {
      result.status = 'error';
      result.errors = [String(e.message).slice(0, 200)];
      errorCount++;
      log(`  [${i + 1}/${handles.length}] ERROR ${handle}: ${e.message.slice(0, 150)}`);
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
  const reportPath = path.join(LOG_DIR, `image-update-${mode}-${timestamp}.json`);
  const report = {
    mode,
    timestamp: nowIso(),
    input: opts.input,
    limit: opts.limit,
    totalHandles: handles.length,
    success: successCount,
    skipped: skipCount,
    errors: errorCount,
    results,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  log(`Report: ${reportPath}`);

  // Summary
  console.log();
  console.log('========== Summary ==========');
  console.log(`Mode:          ${mode}`);
  console.log(`Handles:       ${handles.length}`);
  console.log(`Success:       ${successCount}`);
  console.log(`Skipped:       ${skipCount}`);
  console.log(`Errors:        ${errorCount}`);
  console.log(`Report:        ${reportPath}`);
  console.log('===============================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
