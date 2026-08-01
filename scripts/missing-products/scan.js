#!/usr/bin/env node
/**
 * Missing-products SCAN (read-only).
 *
 * Choose a supplier + category, diff the supplier catalog against Shopify by
 * SKU/barcode, and report which products are missing. No Shopify writes, no
 * translation. This is a thin CLI wrapper over the shared lib/ services — the
 * same services the future dashboard page will call.
 *
 * Usage:
 *   node scripts/missing-products/scan.js --supplier=b2bmarkt --list-categories
 *   node scripts/missing-products/scan.js --supplier=b2bmarkt --category="Παιδικό δωμάτιο"
 *   node scripts/missing-products/scan.js --supplier=megapap --xml=megapap_en.xml --all-categories
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import { getSupplier } from '../../lib/suppliers/index.js';
import { createShopifyClient } from '../../lib/shopify/client.js';
import { fetchVariantIndex } from '../../lib/shopify/variants.js';
import { compareMissing } from '../../lib/missing-products/compare.js';

function parseArgs(argv) {
  const opts = { supplier: 'b2bmarkt', category: null, xml: null, allCategories: false, listCategories: false, out: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--supplier=')) opts.supplier = a.slice(11);
    else if (a.startsWith('--category=')) opts.category = a.slice(11);
    else if (a.startsWith('--xml=')) opts.xml = a.slice(6);
    else if (a === '--all-categories') opts.allCategories = true;
    else if (a === '--list-categories') opts.listCategories = true;
    else if (a.startsWith('--out=')) opts.out = a.slice(6);
  }
  return opts;
}

const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);

async function main() {
  const opts = parseArgs(process.argv);
  const adapter = getSupplier(opts.supplier);
  const xmlPath = opts.xml || adapter.config.defaultXml;

  log(`Supplier: ${adapter.config.name}`);
  log(`Reading catalog: ${xmlPath}`);
  const xmlText = await fs.readFile(xmlPath, 'utf8');
  const products = adapter.parseProducts(xmlText);
  log(`Products in catalog: ${products.length}`);

  if (opts.listCategories) {
    const cats = adapter.listCategories(products);
    console.log(`\nCategories (${cats.length}):`);
    for (const c of cats) console.log(`  ${String(c.count).padStart(5)}  ${c.level ? `[L${c.level}] ` : ''}${c.text}`);
    return;
  }

  const selected = opts.allCategories
    ? products
    : products.filter((p) => adapter.matchesCategory(p, opts.category));
  log(opts.allCategories ? 'Mode: ALL CATEGORIES' : `Category "${opts.category}": ${selected.length} products`);
  if (!opts.allCategories && !opts.category) {
    console.error('ERROR: provide --category="..." or --all-categories (see --list-categories).');
    process.exit(1);
  }

  const canonical = selected.map((p) => adapter.extractProduct(p));

  log('Fetching Shopify variant index (read-only)...');
  const client = createShopifyClient();
  const index = await fetchVariantIndex(client, {
    onProgress: ({ total }) => { if (total % 5000 === 0) log(`  variants: ${total}`); },
  });
  log(`Shopify SKUs: ${index.bySku.size}, barcodes: ${index.byBarcode.size}`);

  const result = compareMissing(canonical, index, adapter);

  console.log('\n========== Scan summary ==========');
  console.log(`Supplier / category:  ${adapter.config.name}${opts.allCategories ? ' (all)' : ` / ${opts.category}`}`);
  console.log(`In selection:         ${result.counts.total}`);
  console.log(`Already in Shopify:   ${result.counts.present}`);
  console.log(`Missing in Shopify:   ${result.counts.missing}`);
  console.log(`Invalid (no SKU):     ${result.counts.invalid}`);
  console.log(`Duplicate codes:      ${result.counts.duplicates}`);
  console.log('==================================');

  if (opts.out) {
    await fs.writeFile(opts.out, JSON.stringify({ scannedAt: new Date().toISOString(), supplier: adapter.config.key, category: opts.category, counts: result.counts, missing: result.missing }, null, 2));
    log(`Report written: ${opts.out}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
