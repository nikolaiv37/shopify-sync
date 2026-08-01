#!/usr/bin/env node
/**
 * Missing-products EXPORT (read-only; produces a Shopify import CSV).
 *
 * Pipeline: scan (diff vs Shopify) → transform (deterministic, no translation)
 * → CSV. Titles/descriptions stay in the feed's language; Type/Tags/price are
 * derived from the category map + supplier multiplier. Output products are
 * drafts (Status=draft). No Shopify writes.
 *
 * Usage:
 *   node scripts/missing-products/export.js --supplier=b2bmarkt --category="Παιδικό δωμάτιο" --out-base=missing-b2bmarkt
 *   node scripts/missing-products/export.js --supplier=megapap --all-categories --out-base=missing-megapap
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import { getSupplier } from '../../lib/suppliers/index.js';
import { createShopifyClient } from '../../lib/shopify/client.js';
import { fetchVariantIndex } from '../../lib/shopify/variants.js';
import { compareMissing } from '../../lib/missing-products/compare.js';
import { loadCategoryMap } from '../../lib/missing-products/category-map.js';
import { transformProducts } from '../../lib/missing-products/transform.js';
import { validateBatch } from '../../lib/missing-products/validate.js';
import { rowsToCsv } from '../../lib/missing-products/csv.js';

function parseArgs(argv) {
  const opts = { supplier: 'b2bmarkt', category: null, xml: null, allCategories: false, outBase: 'missing-products-v2' };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--supplier=')) opts.supplier = a.slice(11);
    else if (a.startsWith('--category=')) opts.category = a.slice(11);
    else if (a.startsWith('--xml=')) opts.xml = a.slice(6);
    else if (a === '--all-categories') opts.allCategories = true;
    else if (a.startsWith('--out-base=')) opts.outBase = a.slice(11);
  }
  return opts;
}

const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);

async function main() {
  const opts = parseArgs(process.argv);
  const adapter = getSupplier(opts.supplier);
  const xmlPath = opts.xml || adapter.config.defaultXml;

  const xmlText = await fs.readFile(xmlPath, 'utf8');
  const products = adapter.parseProducts(xmlText);
  const selected = opts.allCategories
    ? products
    : products.filter((p) => adapter.matchesCategory(p, opts.category));
  if (!opts.allCategories && !opts.category) {
    console.error('ERROR: provide --category="..." or --all-categories.');
    process.exit(1);
  }
  const canonical = selected.map((p) => adapter.extractProduct(p));

  log('Fetching Shopify variant index (read-only)...');
  const client = createShopifyClient();
  const index = await fetchVariantIndex(client);
  const { missing, counts } = compareMissing(canonical, index, adapter);
  log(`Missing: ${missing.length} / ${counts.total}`);

  const categoryMap = await loadCategoryMap(adapter.config.categoryMapPath);
  const { rows, summaries } = transformProducts(missing, {
    config: adapter.config,
    categoryMap,
    forcedCategory: opts.allCategories ? null : opts.category,
  });
  const validation = validateBatch(summaries, index);

  const csvPath = `${opts.outBase}-shopify-import.csv`;
  const reportPath = `${opts.outBase}-report.json`;
  await fs.writeFile(csvPath, rowsToCsv(rows));
  await fs.writeFile(reportPath, JSON.stringify({
    exportedAt: new Date().toISOString(),
    supplier: adapter.config.key,
    category: opts.allCategories ? '__ALL__' : opts.category,
    counts,
    validation: validation.counts,
    review: validation.review,
  }, null, 2));

  console.log('\n========== Export summary ==========');
  console.log(`Missing products:     ${missing.length}`);
  console.log(`Importable:           ${validation.counts.importable}`);
  console.log(`Needs review:         ${validation.counts.review}`);
  console.log(`Already in Shopify:   ${validation.counts.duplicatesInShopify}`);
  console.log(`CSV:                  ${csvPath}`);
  console.log(`Report:               ${reportPath}`);
  console.log('====================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
