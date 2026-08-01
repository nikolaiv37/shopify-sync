#!/usr/bin/env node
/**
 * Filter B2BMarkt vendor feeds down to a hand-picked list of product codes.
 *
 * Unlike export-missing-products.js this does NOT diff against Shopify. It pulls
 * exactly the requested ProductCodes from the vendor feeds, regardless of what
 * already exists in Shopify. Codes may be spread across the `main` and
 * `symetron` feeds, so both are checked by default. On a code appearing in both,
 * `main` wins and the collision is logged.
 *
 * URL-ONLY: every requested feed must have its URL env var set (see
 * config/b2bmarkt-feeds.json). If a requested feed has no URL, this fails loudly
 * rather than silently falling back to a stale local XML file.
 *
 * Output is byte-for-byte the same CSV/JSON schema that export-missing-products.js
 * emits, so translate_b2bmarkt_missing.py consumes it with no changes.
 *
 * NOTE ON CODE REUSE: export-missing-products.js is an executable script — it
 * runs main() on import (which requires Shopify credentials and does a full
 * Shopify fetch) and exports nothing. Per the "do not modify existing scripts"
 * rule it cannot be turned into an importable module here. The field-extraction
 * and CSV helpers below are therefore transcribed verbatim from that file so the
 * output schema stays identical; the actual XML parser (fast-xml-parser's
 * XMLParser) and the feed resolver (scripts/resolve_b2bmarkt_feed.js) are reused
 * directly rather than reimplemented.
 *
 * Usage:
 *   node scripts/filter_feeds_by_codes.js --codes-file=data/targeted-codes.txt --out-base=targeted-25
 *   node scripts/filter_feeds_by_codes.js --codes-file=data/targeted-codes.txt --out-base=targeted-25 --feeds=main,symetron
 *   node scripts/filter_feeds_by_codes.js --codes-file=data/targeted-codes.txt --out-base=targeted-25 --limit=3
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    codesFile: 'data/targeted-codes.txt',
    outBase: 'targeted-25',
    feeds: ['main', 'symetron'],
    limit: null,
  };
  for (const a of args) {
    if (a.startsWith('--codes-file=')) opts.codesFile = a.slice('--codes-file='.length);
    else if (a.startsWith('--out-base=')) opts.outBase = a.slice('--out-base='.length);
    else if (a.startsWith('--feeds=')) {
      opts.feeds = a
        .slice('--feeds='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    }
  }
  return opts;
}

// ---------- Utilities (transcribed from export-missing-products.js) ----------

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

// ---------- Feed config + URL-only resolution ----------

async function loadFeedConfig() {
  const configPath = path.join(ROOT, 'config', 'b2bmarkt-feeds.json');
  const raw = await fs.readFile(configPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Download one feed from its URL to a temp file and return the local path.
 * URL-only: the caller must have already verified the env var is set, so the
 * resolver takes its download branch and never falls back to a local file.
 */
function resolveFeedFromUrl(feed, outPath) {
  const resolved = execFileSync(
    'node',
    [path.join('scripts', 'resolve_b2bmarkt_feed.js'), `--feed=${feed}`, `--out=${outPath}`],
    { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] },
  );
  return resolved.trim();
}

// ---------- Codes file ----------

async function readCodes(codesFile) {
  const raw = await fs.readFile(path.resolve(codesFile), 'utf8');
  const seen = new Set();
  const codes = [];
  for (const line of raw.split(/\r?\n/)) {
    const code = line.trim();
    if (!code || code.startsWith('#')) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);

  log(`Codes file: ${opts.codesFile}`);
  log(`Feeds: ${opts.feeds.join(', ')}`);
  log(`Out base: ${opts.outBase}`);
  if (opts.limit != null) log(`Limit: ${opts.limit}`);

  const codes = await readCodes(opts.codesFile);
  log(`Codes requested: ${codes.length}`);

  // ----- URL-only guard: every requested feed must have its URL env var set -----
  const feedConfig = await loadFeedConfig();
  const missingUrl = [];
  for (const feed of opts.feeds) {
    const cfg = feedConfig[feed];
    if (!cfg) {
      console.error(`ERROR: Unknown feed "${feed}". Known feeds: ${Object.keys(feedConfig).join(', ')}`);
      process.exit(1);
    }
    if (!process.env[cfg.env]) missingUrl.push(`${feed} (${cfg.env})`);
  }
  if (missingUrl.length > 0) {
    console.error('ERROR: URL-only pipeline — the following feed URL env vars are not set:');
    for (const m of missingUrl) console.error(`  - ${m}`);
    console.error('Set them in .env. This pipeline refuses to fall back to local XML.');
    process.exit(1);
  }

  // ----- Download + parse each feed, build code -> product index -----
  const tmpDir = path.join(ROOT, '.tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  // feed -> Map(code -> product node)
  const feedIndex = new Map();
  for (const feed of opts.feeds) {
    const outPath = path.join(tmpDir, `targeted_feed_${feed}.xml`);
    log(`Downloading feed "${feed}" from URL...`);
    const xmlPath = resolveFeedFromUrl(feed, outPath);
    const xmlText = await fs.readFile(xmlPath, 'utf8');
    const products = parseXmlProducts(xmlText, 'Product');
    log(`  Feed "${feed}": ${products.length} products parsed`);
    const index = new Map();
    for (const p of products) {
      const code = extractText(p?.ProductCode)?.trim();
      if (!code) continue;
      if (!index.has(code)) index.set(code, p); // first occurrence wins within a feed
    }
    feedIndex.set(feed, index);
  }

  // ----- Match codes (feed precedence = order in --feeds, so main wins by default) -----
  const foundByFeed = new Map(opts.feeds.map((f) => [f, []]));
  const notFound = [];
  const collisions = []; // { code, feeds:[...], chosen }
  const matched = []; // export products in requested-code order

  for (const code of codes) {
    const present = opts.feeds.filter((f) => feedIndex.get(f).has(code));
    if (present.length === 0) {
      notFound.push(code);
      continue;
    }
    const chosen = present[0]; // first feed in --feeds order (main before symetron)
    foundByFeed.get(chosen).push(code);
    if (present.length > 1) {
      collisions.push({ code, feeds: present, chosen });
      log(`  COLLISION: ${code} found in [${present.join(', ')}] → using "${chosen}"`);
    }
    const product = buildExportProduct(feedIndex.get(chosen).get(code));
    product.source_feed = chosen; // extra JSON-only field; not written to CSV
    matched.push(product);
  }

  // ----- Apply optional limit (preserve requested-code order) -----
  const sliced = opts.limit != null ? matched.slice(0, opts.limit) : matched;

  // ----- Write outputs (identical schema to export-missing-products.js) -----
  const jsonPath = path.join(ROOT, `${opts.outBase}.json`);
  const csvPath = path.join(ROOT, `${opts.outBase}.csv`);

  const exportData = {
    exportedAt: nowIso(),
    mode: 'targeted-codes',
    codesFile: opts.codesFile,
    feeds: opts.feeds,
    codesRequested: codes.length,
    totalMatched: matched.length,
    exportedCount: sliced.length,
    limit: opts.limit,
    products: sliced,
  };

  await fs.writeFile(jsonPath, JSON.stringify(exportData, null, 2));
  log(`Exported to ${path.relative(ROOT, jsonPath)}`);
  await fs.writeFile(csvPath, toCsv(sliced));
  log(`Exported to ${path.relative(ROOT, csvPath)}`);

  // ----- Log report to logs/targeted-codes/<timestamp>/ -----
  const stamp = nowIso().replace(/[:.]/g, '-');
  const logDir = path.join(ROOT, 'logs', 'targeted-codes', stamp);
  await fs.mkdir(logDir, { recursive: true });
  const report = {
    generatedAt: nowIso(),
    codesFile: opts.codesFile,
    feeds: opts.feeds,
    codesRequested: codes.length,
    foundByFeed: Object.fromEntries(opts.feeds.map((f) => [f, foundByFeed.get(f)])),
    notFound,
    collisions,
    totalMatched: matched.length,
    rowsWritten: sliced.length,
    outputs: {
      csv: path.relative(ROOT, csvPath),
      json: path.relative(ROOT, jsonPath),
    },
  };
  await fs.writeFile(path.join(logDir, 'filter-report.json'), JSON.stringify(report, null, 2));

  // ----- Print report -----
  console.log('\n========== Targeted-codes report ==========');
  console.log(`Codes requested:              ${codes.length}`);
  for (const feed of opts.feeds) {
    const list = foundByFeed.get(feed);
    console.log(`Found in ${feed.padEnd(9)} (${String(list.length).padStart(2)}):  [${list.join(', ')}]`);
  }
  console.log(`NOT found in either (${String(notFound.length).padStart(2)}):    [${notFound.join(', ')}]`);
  if (collisions.length > 0) {
    console.log(`Collisions (in >1 feed):      ${collisions.length}`);
    for (const c of collisions) {
      console.log(`  ${c.code}: in [${c.feeds.join(', ')}] → chose "${c.chosen}"`);
    }
  }
  console.log(`Total rows written:           ${sliced.length}`);
  console.log(`Report log:                   ${path.relative(ROOT, path.join(logDir, 'filter-report.json'))}`);
  console.log('===========================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
