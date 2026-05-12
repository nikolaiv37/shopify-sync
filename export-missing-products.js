#!/usr/bin/env node
/**
 * Export products from B2BMarkt XML that belong to a specific category
 * and are missing from Shopify (by SKU comparison).
 *
 * Read-only: no writes to Shopify.
 *
 * Usage:
 *   node export-missing-products.js --feed=main --category="Παιδικό δωμάτιο"
 *   node export-missing-products.js --feed=symetron --category="Σαλόνια - γωνίες"
 *   node export-missing-products.js --xml=b2bmarkt_updated.xml --category="Παιδικό δωμάτιο"  # fallback
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Shopify auth (same as update-prices.js) ----------

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
    category: 'Παιδικό δωμάτιο',
    allCategories: false,
    outBase: 'missing-products',
    limit: null,
    skip: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--feed=')) {
      opts.feed = a.slice('--feed='.length);
    } else if (a.startsWith('--xml=')) {
      opts.xmlPath = a.slice('--xml='.length);
    } else if (a.startsWith('--category=')) {
      opts.category = a.slice('--category='.length);
    } else if (a === '--all-categories') {
      opts.allCategories = true;
    } else if (a.startsWith('--out-base=')) {
      opts.outBase = a.slice('--out-base='.length);
    } else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a.startsWith('--skip=')) {
      const v = Number.parseInt(a.slice('--skip='.length), 10);
      if (Number.isFinite(v) && v >= 0) opts.skip = v;
    }
  }

  return opts;
}

// ---------- Utilities (reused from update-prices.js) ----------

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

// ---------- Shopify: token + GraphQL (reused from update-prices.js) ----------

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

// ---------- Shopify: paginated variants (reused from update-prices.js) ----------

async function fetchAllVariantsBySku() {
  const bySku = new Map();
  let cursor = null;
  let page = 0;
  let totalNodes = 0;

  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query priceVariants($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            price
            product { id vendor }
          }
        }
      }`,
      { cursor },
      `variants page ${page}`,
    );

    for (const v of data.productVariants.nodes) {
      totalNodes++;
      const sku = v.sku?.trim();
      if (!sku) continue;
      const row = {
        variantId: v.id,
        productId: v.product.id,
        vendor: v.product.vendor,
        currentPrice: v.price,
      };
      const list = bySku.get(sku) ?? [];
      list.push(row);
      bySku.set(sku, list);
    }

    if (page % 20 === 0) {
      log(`Variants fetched: ${totalNodes}`);
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
    await sleep(120);
  }

  log(`Variants fetched: ${totalNodes}`);
  return bySku;
}

// ---------- XML parsing ----------

function parseXmlProducts(xmlText, productTag) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    attributesGroupName: '$attrs',
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, productTag);
  if (!products) {
    throw new Error(`Could not find <${productTag}> elements in XML`);
  }
  return products;
}

function getCategoryList(productNode) {
  const catsRaw = productNode?.Categories?.Category;
  if (!catsRaw) return [];
  const arr = Array.isArray(catsRaw) ? catsRaw : [catsRaw];
  return arr.map((c) => {
    const attrs = c?.$attrs ?? {};
    return {
      id: attrs.id ?? '',
      level: attrs.level ?? '',
      text: extractText(c),
    };
  });
}

function matchesCategory(productNode, targetCategory) {
  const categories = getCategoryList(productNode);
  return categories.some((c) => c.text === targetCategory);
}

function getImages(productNode) {
  const imgsRaw = productNode?.ImagesLocation?.image;
  if (!imgsRaw) return [];
  const arr = Array.isArray(imgsRaw) ? imgsRaw : [imgsRaw];
  return arr.map(extractText).filter(Boolean);
}

function getDimensions(productNode) {
  const packsRaw = productNode?.Packs?.Pack;
  if (!packsRaw) return null;
  const pack = Array.isArray(packsRaw) ? packsRaw[0] : packsRaw;
  const dimX = extractText(pack?.DimX);
  const dimY = extractText(pack?.DimY);
  const dimZ = extractText(pack?.DimZ);
  const weight = extractText(pack?.GrossWeight);
  const volume = extractText(pack?.MainVolume);
  if (!dimX && !dimY && !dimZ) return null;
  return {
    length_m: dimX || null,
    width_m: dimY || null,
    height_m: dimZ || null,
    gross_weight_kg: weight || null,
    volume_m3: volume || null,
  };
}

function buildExportProduct(p) {
  const sku = extractText(p?.ProductCode);
  const name = extractText(p?.Name);
  const description = extractText(p?.ExtendedDescription);
  const wholesalePrice = extractText(p?.ZoneFourUnitPrice);
  const retailPrice = extractText(p?.RetailCurrentPrice);
  const marketPrice = extractText(p?.MarketPrice);
  const stock = extractText(p?.Stock);
  const availability = extractText(p?.AvailabilityTypeName);
  const weight = extractText(p?.Weight);
  const itemCode = extractText(p?.ItemCode);
  const barcode = extractText(p?.BarcodeMain);
  const categories = getCategoryList(p);
  const images = getImages(p);
  const dimensions = getDimensions(p);

  return {
    sku,
    title: name,
    description,
    wholesale_price: wholesalePrice || null,
    retail_price: retailPrice || null,
    market_price: marketPrice || null,
    stock: stock || null,
    availability,
    weight_kg: weight || null,
    item_code: itemCode,
    barcode,
    images,
    categories: categories.map((c) => ({ level: c.level, text: c.text })),
    dimensions,
    product_id_xml: extractText(p?.ProductId),
    min_quantity: extractText(p?.MinQuantity) || null,
  };
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

function toCsv(products) {
  const headers = [
    'sku',
    'title',
    'description',
    'wholesale_price',
    'retail_price',
    'market_price',
    'stock',
    'availability',
    'weight_kg',
    'item_code',
    'barcode',
    'images',
    'categories',
    'dimensions',
  ];
  const lines = [headers.join(',')];
  for (const p of products) {
    const row = [
      escapeCsvField(String(p.sku)),
      escapeCsvField(p.title),
      escapeCsvField(p.description),
      escapeCsvField(p.wholesale_price),
      escapeCsvField(p.retail_price),
      escapeCsvField(p.market_price),
      escapeCsvField(p.stock),
      escapeCsvField(p.availability),
      escapeCsvField(p.weight_kg),
      escapeCsvField(p.item_code),
      escapeCsvField(p.barcode),
      escapeCsvField(p.images.join('; ')),
      escapeCsvField(p.categories.map((c) => `[L${c.level}] ${c.text}`).join(' > ')),
      escapeCsvField(p.dimensions ? `L:${p.dimensions.length_m} W:${p.dimensions.width_m} H:${p.dimensions.height_m} Weight:${p.dimensions.gross_weight_kg}kg Vol:${p.dimensions.volume_m3}m3` : ''),
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);

  // Resolve XML path: --feed takes priority, then --xml, then default
  let xmlPathResolved;
  if (opts.feed) {
    xmlPathResolved = await resolveFeedXml(opts.feed);
    log(`Feed: ${opts.feed}`);
  } else if (opts.xmlPath) {
    xmlPathResolved = path.resolve(opts.xmlPath);
  } else {
    xmlPathResolved = path.resolve('b2bmarkt_updated.xml');
  }

  const targetCategory = opts.category;

  log(`XML file: ${xmlPathResolved}`);
  if (opts.allCategories) {
    log('Mode: ALL CATEGORIES (no category filter)');
  } else {
    log(`Target category: ${targetCategory}`);
  }
  if (opts.skip > 0) log(`Skip: ${opts.skip}`);
  if (opts.limit != null) log(`Limit: ${opts.limit}`);

  // Step 1: Fetch Shopify variants
  log('Fetching Shopify variants...');
  ACCESS_TOKEN = await fetchAccessToken();
  const shopifyBySku = await fetchAllVariantsBySku();
  log(`Shopify SKU count: ${shopifyBySku.size}`);

  // Step 2: Parse XML
  log('Parsing XML...');
  const xmlText = await fs.readFile(xmlPathResolved, 'utf8');
  const allProducts = parseXmlProducts(xmlText, 'Product');
  log(`Products parsed from XML: ${allProducts.length}`);

  // Step 3: Filter by category (or skip filter in all-categories mode)
  let categoryProducts;
  let categoryLabel;
  if (opts.allCategories) {
    categoryProducts = allProducts;
    categoryLabel = '__ALL__';
    log(`Products (all categories): ${categoryProducts.length}`);
  } else {
    categoryProducts = allProducts.filter((p) => matchesCategory(p, targetCategory));
    categoryLabel = targetCategory;
    log(`Products in ${targetCategory}: ${categoryProducts.length}`);
  }

  // Step 4: Compare against Shopify
  const missingProducts = [];
  for (const p of categoryProducts) {
    const sku = extractText(p?.ProductCode)?.trim();
    if (!sku) continue;
    if (!shopifyBySku.has(sku)) {
      missingProducts.push(buildExportProduct(p));
    }
  }
  log(`Missing in Shopify: ${missingProducts.length}`);

  // Step 5: Apply skip/limit
  const sliced = missingProducts.slice(opts.skip, opts.skip + (opts.limit ?? missingProducts.length));
  log(`Exporting ${sliced.length} products (skip=${opts.skip}, limit=${opts.limit ?? 'all'})`);

  // Step 6: Export
  const jsonPath = `${opts.outBase}.json`;
  const csvPath = `${opts.outBase}.csv`;

  const exportData = {
    exportedAt: nowIso(),
    category: categoryLabel,
    allCategories: opts.allCategories,
    xmlSource: xmlPathResolved,
    totalXmlProducts: allProducts.length,
    totalInCategory: categoryProducts.length,
    shopifySkuCount: shopifyBySku.size,
    totalMissing: missingProducts.length,
    exportedCount: sliced.length,
    skip: opts.skip,
    limit: opts.limit,
    products: sliced,
  };

  await fs.writeFile(jsonPath, JSON.stringify(exportData, null, 2));
  log(`Exported to ${jsonPath}`);

  await fs.writeFile(csvPath, toCsv(sliced));
  log(`Exported to ${csvPath}`);

  // Summary
  console.log('\n========== Summary ==========');
  console.log(`Total XML products:           ${allProducts.length}`);
  if (opts.allCategories) {
    console.log(`Mode:                         ALL CATEGORIES`);
  } else {
    console.log(`Products in target category:  ${categoryProducts.length}`);
  }
  console.log(`Shopify SKU count:            ${shopifyBySku.size}`);
  console.log(`Missing in Shopify:           ${missingProducts.length}`);
  console.log(`Exported (after skip/limit):  ${sliced.length}`);
  console.log(`Output:                       ${jsonPath}, ${csvPath}`);
  console.log('===============================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
