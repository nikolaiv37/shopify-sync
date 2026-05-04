#!/usr/bin/env node
/**
 * Export Megapap products that are missing from Shopify (by SKU = <model> comparison).
 *
 * Read-only: no writes to Shopify.
 *
 * Usage:
 *   node scripts/export_missing_megapap_products.js --out-base=missing-megapap-batch-1 --limit=20
 *   node scripts/export_missing_megapap_products.js --xml=megapap_en.xml --out-base=missing-megapap-batch-1
 *
 * If --xml is not provided and MEGAPAP_FEED_URL is set in .env, the feed is downloaded
 * to .tmp/megapap_feed.xml automatically.
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
  MEGAPAP_FEED_URL,
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

// ---------- Feed download ----------

async function downloadMegapapFeed() {
  if (!MEGAPAP_FEED_URL) {
    return null;
  }
  const tmpDir = path.resolve('.tmp');
  await fs.mkdir(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, 'megapap_feed.xml');

  log(`Downloading Megapap feed...`);
  const res = await fetch(MEGAPAP_FEED_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading Megapap feed`);
  }
  const buf = await res.arrayBuffer();
  await fs.writeFile(outPath, Buffer.from(buf));
  log(`Downloaded: ${(buf.byteLength / 1024).toFixed(1)} KB → ${outPath}`);
  return outPath;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    xmlPath: null,
    outBase: 'missing-megapap-products',
    category: null,
    limit: null,
    skip: 0,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--xml=')) {
      opts.xmlPath = a.slice('--xml='.length);
    } else if (a.startsWith('--out-base=')) {
      opts.outBase = a.slice('--out-base='.length);
    } else if (a.startsWith('--category=')) {
      opts.category = a.slice('--category='.length);
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

// ---------- Shopify: fetch all variants by SKU ----------

async function fetchAllVariantsBySku() {
  const bySku = new Map();
  let cursor = null;
  let page = 0;
  let totalNodes = 0;

  for (;;) {
    page++;
    const data = await gqlWithRetry(
      `query variants($cursor: String) {
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

function parseXmlProducts(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    attributesGroupName: '$attrs',
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, 'product');
  if (!products) {
    throw new Error('Could not find <product> elements in XML');
  }
  return products;
}

function getImages(productNode) {
  const images = [];
  const mainImg = extractText(productNode?.main_image);
  if (mainImg) images.push(mainImg);

  const imgsRaw = productNode?.images?.image;
  if (imgsRaw) {
    const arr = Array.isArray(imgsRaw) ? imgsRaw : [imgsRaw];
    for (const img of arr) {
      const url = extractText(img);
      if (url && !images.includes(url)) images.push(url);
    }
  }
  return images;
}

function getFilters(productNode) {
  const filters = [];
  const filtersRaw = productNode?.filters?.filter;
  if (!filtersRaw) return filters;
  const arr = Array.isArray(filtersRaw) ? filtersRaw : [filtersRaw];
  for (const f of arr) {
    const group = extractText(f?.group);
    const value = extractText(f?.value);
    if (group || value) filters.push({ group, value });
  }
  return filters;
}

function getAttributes(productNode) {
  const attrs = [];
  const attrsRaw = productNode?.attributes?.attribute;
  if (!attrsRaw) return attrs;
  const arr = Array.isArray(attrsRaw) ? attrsRaw : [attrsRaw];
  for (const a of arr) {
    const text = extractText(a);
    if (text) attrs.push(text);
  }
  return attrs;
}

function buildExportProduct(p) {
  const model = extractText(p?.model);
  const supplierSku = extractText(p?.sku);
  const ean = extractText(p?.ean);
  const name = extractText(p?.name);
  const description = extractText(p?.description);
  const category = extractText(p?.category);
  const categoryId = extractText(p?.category_id);
  const manufacturer = extractText(p?.manufacturer);
  const wholesalePrice = extractText(p?.wholesale_price_without_vat);
  const retailPrice = extractText(p?.retail_price_with_vat);
  const webOfferPrice = extractText(p?.weboffer_price_with_vat);
  const quantity = extractText(p?.quantity);
  const weight = extractText(p?.weight_item);
  const volume = extractText(p?.volume_item);
  const minimum = extractText(p?.minimum);
  const availability = extractText(p?.availability);
  const packagesPerItem = extractText(p?.packages_per_item);
  const combWidth = extractText(p?.comb_width_cm);
  const combLength = extractText(p?.comb_length_cm);
  const combHeight = extractText(p?.comb_height_cm);
  const images = getImages(p);
  const filters = getFilters(p);
  const attributes = getAttributes(p);

  return {
    sku: model,
    supplier_sku: supplierSku,
    ean,
    title: name,
    description,
    category,
    category_id: categoryId,
    manufacturer,
    wholesale_price_without_vat: wholesalePrice || null,
    retail_price_with_vat: retailPrice || null,
    weboffer_price_with_vat: webOfferPrice || null,
    quantity: quantity || null,
    weight_kg: weight || null,
    volume_m3: volume || null,
    minimum: minimum || null,
    availability,
    packages_per_item: packagesPerItem || null,
    dimensions: {
      width_cm: combWidth && combWidth !== '0' ? combWidth : null,
      length_cm: combLength && combLength !== '0' ? combLength : null,
      height_cm: combHeight && combHeight !== '0' ? combHeight : null,
    },
    images,
    filters,
    attributes,
    product_id_xml: extractText(p?.$attrs?.id),
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
    'supplier_sku',
    'ean',
    'title',
    'description',
    'category',
    'wholesale_price_without_vat',
    'retail_price_with_vat',
    'quantity',
    'weight_kg',
    'volume_m3',
    'images',
    'filters',
    'attributes',
  ];
  const lines = [headers.join(',')];
  for (const p of products) {
    const row = [
      escapeCsvField(String(p.sku)),
      escapeCsvField(p.supplier_sku),
      escapeCsvField(p.ean),
      escapeCsvField(p.title),
      escapeCsvField(p.description),
      escapeCsvField(p.category),
      escapeCsvField(p.wholesale_price_without_vat),
      escapeCsvField(p.retail_price_with_vat),
      escapeCsvField(p.quantity),
      escapeCsvField(p.weight_kg),
      escapeCsvField(p.volume_m3),
      escapeCsvField(p.images.join('; ')),
      escapeCsvField(p.filters.map((f) => `${f.group}: ${f.value}`).join(' | ')),
      escapeCsvField(p.attributes.join(' | ')),
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);

  // Resolve XML path: --xml takes priority, then download from MEGAPAP_FEED_URL, then fallback to local
  let xmlPathResolved;
  if (opts.xmlPath) {
    xmlPathResolved = path.resolve(opts.xmlPath);
  } else {
    xmlPathResolved = await downloadMegapapFeed();
    if (!xmlPathResolved) {
      xmlPathResolved = path.resolve('megapap_en.xml');
    }
  }

  log(`XML file: ${xmlPathResolved}`);
  if (opts.category) log(`Category filter: ${opts.category}`);
  if (opts.skip > 0) log(`Skip: ${opts.skip}`);
  if (opts.limit != null) log(`Limit: ${opts.limit}`);

  // Step 1: Fetch Shopify variants
  log('Fetching Shopify variants...');
  ACCESS_TOKEN = await fetchAccessToken();
  const shopifyBySku = await fetchAllVariantsBySku();
  log(`Shopify SKU count: ${shopifyBySku.size}`);

  // Step 2: Parse XML
  log('Parsing Megapap XML...');
  const xmlText = await fs.readFile(xmlPathResolved, 'utf8');
  const allProducts = parseXmlProducts(xmlText);
  log(`Products parsed from XML: ${allProducts.length}`);

  // Step 3: Filter by category if provided
  let filteredProducts = allProducts;
  if (opts.category) {
    filteredProducts = allProducts.filter((p) => {
      const cat = extractText(p?.category);
      return cat === opts.category || cat.includes(opts.category);
    });
    log(`Products in category "${opts.category}": ${filteredProducts.length}`);
  }

  // Step 4: Compare against Shopify (SKU = model)
  const missingProducts = [];
  for (const p of filteredProducts) {
    const sku = extractText(p?.model)?.trim();
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
    xmlSource: xmlPathResolved,
    category: opts.category || null,
    totalXmlProducts: allProducts.length,
    totalFilteredProducts: filteredProducts.length,
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
  console.log(`Filtered products:            ${filteredProducts.length}`);
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
