#!/usr/bin/env node
/**
 * Enrich scraped B2BMarkt new-products with full feed data when the SKU
 * (ProductCode) exists in the B2BMarkt XML feed.
 *
 * Read-only: no Shopify calls, no mutations, no translation.
 *
 * Inputs:
 *   --in=missing-new-products-only.json   (canonical scrape JSON; default below)
 *   --feed=main                           (default; resolves via scripts/resolve_b2bmarkt_feed.js + .env)
 *   --feed=symetron                       (alternate feed)
 *   --xml=path/to.xml                     (explicit override — may be stale; prints warning)
 *
 * Outputs (same canonical shape as export-missing-products.js):
 *   missing-new-products-enriched.json
 *   missing-new-products-enriched.csv
 *   logs/b2bmarkt-missing-products/<timestamp>/feed-enrichment-summary.json
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const log = (s) => console.log(`[${nowIso()}] ${s}`);

function parseArgs(argv) {
  const opts = {
    input: 'missing-new-products-only.json',
    xmlPath: null,
    feed: null,
    outBase: 'missing-new-products-enriched',
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--in=')) opts.input = a.slice(5);
    else if (a.startsWith('--xml=')) opts.xmlPath = a.slice(6);
    else if (a.startsWith('--feed=')) opts.feed = a.slice(7);
    else if (a.startsWith('--out-base=')) opts.outBase = a.slice(11);
  }
  // Default to --feed=main when neither --feed nor --xml supplied
  if (!opts.xmlPath && !opts.feed) opts.feed = 'main';
  return opts;
}

function resolveFeedXml(feed) {
  // Resolver prints feed/env/URL info to STDERR (inherited so user sees it without secrets)
  // and writes the resolved local path to STDOUT.
  const out = execSync(`node scripts/resolve_b2bmarkt_feed.js --feed=${feed}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return out.trim();
}

// ---------- XML helpers (mirror of export-missing-products.js) ----------

function extractText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return extractText(val[0]);
  if (typeof val === 'object') return extractText(val['#text'] ?? val.__cdata ?? '');
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

function getCategoryList(p) {
  const raw = p?.Categories?.Category;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((c) => ({
    level: c?.$attrs?.level ?? '',
    text: extractText(c),
  }));
}

function getImages(p) {
  const raw = p?.ImagesLocation?.image;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(extractText).filter(Boolean);
}

function getDimensions(p) {
  const raw = p?.Packs?.Pack;
  if (!raw) return null;
  const pack = Array.isArray(raw) ? raw[0] : raw;
  const dimX = extractText(pack?.DimX);
  const dimY = extractText(pack?.DimY);
  const dimZ = extractText(pack?.DimZ);
  if (!dimX && !dimY && !dimZ) return null;
  return {
    length_m: dimX || null,
    width_m: dimY || null,
    height_m: dimZ || null,
    gross_weight_kg: extractText(pack?.GrossWeight) || null,
    volume_m3: extractText(pack?.MainVolume) || null,
  };
}

function feedProductToCanonical(p, scrapedExtras) {
  return {
    sku: extractText(p?.ProductCode),
    title: extractText(p?.Name),
    description: extractText(p?.ExtendedDescription),
    wholesale_price: extractText(p?.ZoneFourUnitPrice) || null,
    retail_price: extractText(p?.RetailCurrentPrice) || null,
    market_price: extractText(p?.MarketPrice) || null,
    stock: extractText(p?.Stock) || null,
    availability: extractText(p?.AvailabilityTypeName),
    weight_kg: extractText(p?.Weight) || null,
    item_code: extractText(p?.ItemCode),
    barcode: extractText(p?.BarcodeMain),
    images: getImages(p),
    categories: getCategoryList(p),
    dimensions: getDimensions(p),
    product_id_xml: extractText(p?.ProductId),
    min_quantity: extractText(p?.MinQuantity) || null,
    // Preserve scraped traceability
    source: 'b2bmarkt-feed',
    source_url: scrapedExtras.source_url || '',
    identification_code: scrapedExtras.identification_code || extractText(p?.ItemCode) || '',
    json_ld_sku: scrapedExtras.json_ld_sku || '',
    dimensions_html: scrapedExtras.dimensions_html || '',
    source_used: 'feed',
  };
}

function passthroughScraped(p) {
  return { ...p, source_used: 'scraped' };
}

// ---------- CSV ----------

function escapeCsv(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(products) {
  const headers = [
    'sku', 'title', 'description', 'wholesale_price', 'retail_price', 'market_price',
    'stock', 'availability', 'weight_kg', 'item_code', 'barcode',
    'images', 'categories', 'dimensions',
  ];
  const lines = [headers.join(',')];
  for (const p of products) {
    const dimStr = p.dimensions
      ? `L:${p.dimensions.length_m} W:${p.dimensions.width_m} H:${p.dimensions.height_m} Weight:${p.dimensions.gross_weight_kg}kg Vol:${p.dimensions.volume_m3}m3`
      : '';
    lines.push([
      escapeCsv(p.sku),
      escapeCsv(p.title),
      escapeCsv(p.description),
      escapeCsv(p.wholesale_price),
      escapeCsv(p.retail_price),
      escapeCsv(p.market_price),
      escapeCsv(p.stock),
      escapeCsv(p.availability),
      escapeCsv(p.weight_kg),
      escapeCsv(p.item_code),
      escapeCsv(p.barcode),
      escapeCsv((p.images || []).join('; ')),
      escapeCsv((p.categories || []).map((c) => `[L${c.level}] ${c.text}`).join(' > ')),
      escapeCsv(dimStr),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);

  let xmlPath;
  let feedSource;
  if (opts.xmlPath) {
    xmlPath = path.resolve(opts.xmlPath);
    feedSource = 'xml-override';
    log(`WARNING: Using local XML override (--xml=${opts.xmlPath}); this may be stale.`);
  } else {
    log(`Resolving feed via scripts/resolve_b2bmarkt_feed.js --feed=${opts.feed} (config/b2bmarkt-feeds.json + .env)`);
    xmlPath = resolveFeedXml(opts.feed);
    feedSource = opts.feed;
  }

  let xmlStat = null;
  try { xmlStat = await fs.stat(xmlPath); } catch {}
  const xmlMtimeIso = xmlStat ? xmlStat.mtime.toISOString() : null;
  const xmlSizeBytes = xmlStat ? xmlStat.size : null;

  log(`Input scrape:   ${path.resolve(opts.input)}`);
  log(`Feed source:    ${feedSource}`);
  log(`Resolved XML:   ${xmlPath}`);
  log(`XML modified:   ${xmlMtimeIso || '(unknown)'}`);
  if (xmlSizeBytes != null) log(`XML size:       ${(xmlSizeBytes / 1024 / 1024).toFixed(2)} MB`);

  const input = JSON.parse(await fs.readFile(opts.input, 'utf8'));
  const scraped = input.products || [];
  log(`Scraped products: ${scraped.length}`);

  log('Parsing XML (this can take a few seconds for the main feed)...');
  const xmlText = await fs.readFile(xmlPath, 'utf8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    attributesGroupName: '$attrs',
  });
  const parsed = parser.parse(xmlText);
  const feedProducts = findProductArray(parsed, 'Product') || [];
  log(`Feed products parsed: ${feedProducts.length}`);

  // Indexes
  const byProductCode = new Map();
  const byItemCode = new Map();
  const byBarcode = new Map();
  for (const fp of feedProducts) {
    const pc = extractText(fp?.ProductCode).trim();
    const ic = extractText(fp?.ItemCode).trim();
    const bc = extractText(fp?.BarcodeMain).trim();
    if (pc) byProductCode.set(pc, fp);
    if (ic) byItemCode.set(ic, fp);
    if (bc) byBarcode.set(bc, fp);
  }
  log(`Indexed: ProductCode=${byProductCode.size}, ItemCode=${byItemCode.size}, Barcode=${byBarcode.size}`);

  let matchedByProductCode = 0;
  let matchedByIdentificationCode = 0;
  let unmatched = 0;
  const matchDetails = [];
  const enriched = [];

  for (const sp of scraped) {
    const productCode = (sp.sku || '').trim();
    const idCode = (sp.identification_code || sp.item_code || '').trim();

    let feedNode = null;
    let matchedOn = '';

    if (productCode && byProductCode.has(productCode)) {
      feedNode = byProductCode.get(productCode);
      matchedOn = 'productCode==feedProductCode';
      matchedByProductCode++;
    } else if (idCode && byItemCode.has(idCode)) {
      feedNode = byItemCode.get(idCode);
      matchedOn = 'identificationCode==feedItemCode';
      matchedByIdentificationCode++;
    } else if (idCode && byBarcode.has(idCode)) {
      feedNode = byBarcode.get(idCode);
      matchedOn = 'identificationCode==feedBarcode';
      matchedByIdentificationCode++;
    }

    if (feedNode) {
      enriched.push(feedProductToCanonical(feedNode, sp));
      matchDetails.push({
        sku: productCode,
        identification_code: idCode,
        matchedOn,
        source_used: 'feed',
      });
    } else {
      enriched.push(passthroughScraped(sp));
      unmatched++;
      matchDetails.push({
        sku: productCode,
        identification_code: idCode,
        matchedOn: '',
        source_used: 'scraped',
      });
    }
  }

  // Outputs in canonical shape
  const outJson = {
    exportedAt: nowIso(),
    category: '__NEW_PRODUCTS_ENRICHED__',
    allCategories: true,
    xmlSource: xmlPath,
    feedSource,
    resolvedXmlPath: xmlPath,
    xmlMtime: xmlMtimeIso,
    xmlSizeBytes,
    totalXmlProducts: feedProducts.length,
    totalInCategory: scraped.length,
    shopifySkuCount: 0,
    totalMissing: enriched.length,
    exportedCount: enriched.length,
    skip: 0,
    limit: null,
    products: enriched,
  };
  const jsonPath = path.resolve(`${opts.outBase}.json`);
  const csvPath = path.resolve(`${opts.outBase}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify(outJson, null, 2));
  await fs.writeFile(csvPath, toCsv(enriched));
  log(`Wrote: ${jsonPath}`);
  log(`Wrote: ${csvPath}`);

  // Summary log
  const stamp = nowIso().replace(/[:.]/g, '-');
  const logDir = path.resolve('logs/b2bmarkt-missing-products', stamp);
  await fs.mkdir(logDir, { recursive: true });
  const summary = {
    generatedAt: nowIso(),
    inputScrape: path.resolve(opts.input),
    feedSource,
    resolvedXmlPath: xmlPath,
    xmlMtime: xmlMtimeIso,
    xmlSizeBytes,
    totals: {
      scraped: scraped.length,
      matchedInFeed: matchedByProductCode + matchedByIdentificationCode,
      matchedByProductCode,
      matchedByIdentificationCode,
      notFoundInFeed: unmatched,
    },
    output: { json: jsonPath, csv: csvPath },
    details: matchDetails,
  };
  await fs.writeFile(path.join(logDir, 'feed-enrichment-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n========== Feed enrichment summary ==========');
  console.log(`Scraped products:               ${scraped.length}`);
  console.log(`Matched in feed:                ${matchedByProductCode + matchedByIdentificationCode}`);
  console.log(`  by ProductCode:               ${matchedByProductCode}`);
  console.log(`  by IdentificationCode:        ${matchedByIdentificationCode}`);
  console.log(`Not found in feed:              ${unmatched}`);
  console.log(`Output JSON:                    ${jsonPath}`);
  console.log(`Output CSV:                     ${csvPath}`);
  console.log(`Summary log:                    ${path.join(logDir, 'feed-enrichment-summary.json')}`);
  console.log('==============================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
