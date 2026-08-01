#!/usr/bin/env node
/**
 * Scrape b2bmarkt.gr/en/new-products and emit a dataset in the same
 * CSV+JSON shape as export-missing-products.js, so the existing
 * translate_b2bmarkt_missing.py / scripts/clean_b2bmarkt_import.py
 * pipeline can consume the output unchanged.
 *
 * Read-only: no Shopify calls, no mutations.
 *
 * Usage:
 *   node scripts/b2bmarkt-missing/scrape-new-products.js
 *   node scripts/b2bmarkt-missing/scrape-new-products.js --out-base=missing-new-products
 *   node scripts/b2bmarkt-missing/scrape-new-products.js --max-pages=2 --limit=10
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const BASE = 'https://b2bmarkt.gr';
const LIST_URL = `${BASE}/en/new-products`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) mebelcenter-discovery/1.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const log = (s) => console.log(`[${nowIso()}] ${s}`);

function parseArgs(argv) {
  const opts = {
    outBase: 'missing-new-products',
    maxPages: null,
    limit: null,
    delayMs: 1000,
    rawOut: 'data/b2bmarkt-missing/new-products-scraped.json',
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--out-base=')) opts.outBase = a.slice(11);
    else if (a.startsWith('--max-pages=')) opts.maxPages = +a.slice(12);
    else if (a.startsWith('--pages=')) opts.maxPages = +a.slice(8);
    else if (a.startsWith('--limit=')) opts.limit = +a.slice(8);
    else if (a.startsWith('--delay-ms=')) opts.delayMs = +a.slice(11);
    else if (a.startsWith('--raw-out=')) opts.rawOut = a.slice(10);
  }
  return opts;
}

async function fetchHtml(url, { tries = 4 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      const wait = Math.min(1000 * 2 ** (i - 1), 8000);
      log(`  fetch ${url} failed (${i}/${tries}): ${e.message}; sleep ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function absUrl(href) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  return `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
}

function collectListingHrefs($) {
  // Listing-page cards. Exclude any related-products section (.rltvprds).
  const hrefs = new Set();
  $('.glbprdr .glbprdrc a.img').each((_, el) => {
    if ($(el).closest('.rltvprds').length) return;
    const href = $(el).attr('href');
    if (href) hrefs.add(absUrl(href));
  });
  return [...hrefs];
}

function totalPages($) {
  let max = 1;
  $('.b2b-glbpagination a.pg').each((_, el) => {
    const n = parseInt($(el).text().trim(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max;
}

function textOf($el) {
  return $el.text().replace(/\s+/g, ' ').trim();
}

function extractDetail(html, url) {
  const $ = cheerio.load(html);

  // JSON-LD product block (most reliable for sku/price/description).
  let jsonLd = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLd) return;
    try {
      const j = JSON.parse($(el).contents().text());
      if (j && j['@type'] === 'Product') jsonLd = j;
    } catch {}
  });

  const title = textOf($('.prdttl h1')) || textOf($('meta[itemprop="name"]').attr('content') || '');

  // The two visible code blocks under .skus
  let productCode = '';
  let identificationCode = '';
  $('.skus .sku').each((_, el) => {
    const label = textOf($(el).find('span'));
    const value = $(el).clone().children('span').remove().end().text().replace(/\s+/g, ' ').trim();
    if (/Product code/i.test(label)) productCode = value;
    else if (/Identification code/i.test(label)) identificationCode = value;
  });

  // Fallbacks from JSON-LD
  if (!identificationCode && jsonLd?.sku) identificationCode = String(jsonLd.sku);

  // Breadcrumbs -> categories
  const crumbs = [];
  $('#brdcrbs .row a').each((_, el) => {
    const t = textOf($(el));
    if (t && !/^home$/i.test(t)) crumbs.push(t);
  });

  // Images: prefer high-res anchors in gallery thumbs
  const images = new Set();
  $('.imgs .thbs a[data-fancybox="gallery"]').each((_, el) => {
    const h = $(el).attr('href');
    if (h) images.add(absUrl(h.replace(/\?.*$/, '')));
  });
  if (images.size === 0) {
    const main = $('.imgs .main img').attr('src');
    if (main) images.add(absUrl(main.replace(/\?.*$/, '')));
  }
  if (images.size === 0 && Array.isArray(jsonLd?.image)) {
    for (const u of jsonLd.image) images.add(u);
  } else if (images.size === 0 && typeof jsonLd?.image === 'string') {
    images.add(jsonLd.image);
  }

  // Description: prefer full tab content, fall back to short summary / JSON-LD
  let description =
    $('.tabc1 .cnt').html()?.trim() ||
    $('.mndsc p').html()?.trim() ||
    jsonLd?.description ||
    '';
  description = description ? description.replace(/\s+\n/g, '\n').trim() : '';

  // Dimensions table (raw HTML preserved like XML's DimensionsData)
  const dimensionsHtml = $('.tabc3 .cnt').html()?.trim() || '';

  // Prices from JSON-LD (logged-out site usually hides them in DOM)
  let retailPrice = '';
  if (jsonLd?.offers?.price) retailPrice = String(jsonLd.offers.price);

  const availability = jsonLd?.offers?.availability
    ? String(jsonLd.offers.availability).replace('https://schema.org/', '')
    : '';

  return {
    url,
    title,
    productCode,
    identificationCode,
    jsonLdSku: jsonLd?.sku ? String(jsonLd.sku) : '',
    jsonLdMpn: jsonLd?.mpn ? String(jsonLd.mpn) : '',
    description,
    dimensionsHtml,
    images: [...images],
    breadcrumbs: crumbs,
    retailPrice,
    availability,
  };
}

// ----- Canonical shape (mirror of export-missing-products.js) -----

function toCanonicalProduct(d) {
  // categories: build [{level, text}] from breadcrumbs (skip "Home")
  const categories = d.breadcrumbs.map((text, i) => ({
    level: String(i + 1),
    text,
  }));
  return {
    sku: d.productCode || '',
    title: d.title || '',
    description: d.description || '',
    wholesale_price: null,
    retail_price: d.retailPrice || null,
    market_price: null,
    stock: null,
    availability: d.availability || '',
    weight_kg: null,
    item_code: d.identificationCode || '',
    barcode: '',
    images: d.images,
    categories,
    dimensions: null,
    product_id_xml: d.jsonLdMpn || '',
    min_quantity: null,
    // Extras (not part of export-missing-products.js but useful downstream)
    source: 'b2bmarkt-new-products',
    source_url: d.url,
    identification_code: d.identificationCode || '',
    json_ld_sku: d.jsonLdSku || '',
    dimensions_html: d.dimensionsHtml || '',
  };
}

function escapeCsvField(val) {
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
    lines.push([
      escapeCsvField(p.sku),
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
      escapeCsvField(''),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const opts = parseArgs(process.argv);
  log(`Out base: ${opts.outBase}`);
  log(`Raw debug: ${opts.rawOut}`);

  // 1) listing pages
  log('Fetching page 1...');
  const firstHtml = await fetchHtml(LIST_URL);
  const $first = cheerio.load(firstHtml);
  const totalP = totalPages($first);
  const lastPage = opts.maxPages ? Math.min(opts.maxPages, totalP) : totalP;
  log(`Listing pages detected: ${totalP}, scraping up to: ${lastPage}`);

  const urls = new Set(collectListingHrefs($first));
  for (let p = 2; p <= lastPage; p++) {
    await sleep(opts.delayMs);
    log(`Fetching page ${p}/${lastPage}...`);
    const html = await fetchHtml(`${LIST_URL}?p=${p}`);
    const $ = cheerio.load(html);
    const before = urls.size;
    for (const u of collectListingHrefs($)) urls.add(u);
    log(`  +${urls.size - before} new (total ${urls.size})`);
  }

  let urlList = [...urls];
  if (opts.limit) urlList = urlList.slice(0, opts.limit);
  log(`Total detail pages to scrape: ${urlList.length}`);

  // 2) detail pages
  const details = [];
  for (let i = 0; i < urlList.length; i++) {
    const u = urlList[i];
    await sleep(opts.delayMs);
    try {
      const html = await fetchHtml(u);
      const d = extractDetail(html, u);
      details.push(d);
      if ((i + 1) % 10 === 0 || i === urlList.length - 1) {
        log(`  detail ${i + 1}/${urlList.length}: ${d.productCode || '(no code)'} ${d.title.slice(0, 60)}`);
      }
    } catch (e) {
      log(`  ERROR ${u}: ${e.message}`);
      details.push({ url: u, error: e.message });
    }
  }

  // 3) write raw debug
  const rawAbs = path.resolve(opts.rawOut);
  await fs.mkdir(path.dirname(rawAbs), { recursive: true });
  await fs.writeFile(
    rawAbs,
    JSON.stringify(
      { scrapedAt: nowIso(), source: LIST_URL, totalPages: totalP, scrapedPages: lastPage, count: details.length, products: details },
      null,
      2,
    ),
  );
  log(`Wrote raw: ${rawAbs}`);

  // 4) canonical JSON + CSV
  const canonical = details.filter((d) => !d.error).map(toCanonicalProduct);
  const jsonPath = path.resolve(`${opts.outBase}.json`);
  const csvPath = path.resolve(`${opts.outBase}.csv`);
  const json = {
    exportedAt: nowIso(),
    category: '__NEW_PRODUCTS__',
    allCategories: true,
    xmlSource: LIST_URL,
    totalXmlProducts: details.length,
    totalInCategory: details.length,
    shopifySkuCount: 0,
    totalMissing: canonical.length,
    exportedCount: canonical.length,
    skip: 0,
    limit: opts.limit,
    products: canonical,
  };
  await fs.writeFile(jsonPath, JSON.stringify(json, null, 2));
  await fs.writeFile(csvPath, toCsv(canonical));
  log(`Wrote: ${jsonPath}`);
  log(`Wrote: ${csvPath}`);

  console.log('\n========== Scrape summary ==========');
  console.log(`Listing pages:    ${lastPage}/${totalP}`);
  console.log(`Detail URLs:      ${urlList.length}`);
  console.log(`Scraped OK:       ${canonical.length}`);
  console.log(`Errors:           ${details.length - canonical.length}`);
  console.log(`Raw debug:        ${rawAbs}`);
  console.log(`JSON:             ${jsonPath}`);
  console.log(`CSV:              ${csvPath}`);
  console.log('=====================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
