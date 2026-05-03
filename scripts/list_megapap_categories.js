#!/usr/bin/env node
/**
 * List Megapap XML categories with product counts.
 *
 * Read-only: no Shopify calls, no mutations.
 *
 * Usage:
 *   node scripts/list_megapap_categories.js
 *   node scripts/list_megapap_categories.js --xml=megapap_en.xml
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    xmlPath: './megapap_en.xml',
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--xml=')) {
      opts.xmlPath = a.slice('--xml='.length);
    }
  }

  return opts;
}

// ---------- Utilities ----------

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

// ---------- Main ----------

async function main() {
  const opts = parseArgs(process.argv);
  const xmlPathResolved = path.resolve(opts.xmlPath);

  console.log(`XML file: ${xmlPathResolved}`);

  // Parse XML
  const xmlText = await fs.readFile(xmlPathResolved, 'utf8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    attributesGroupName: '$attrs',
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, 'product');

  if (!products) {
    console.error('Could not find <product> elements in XML');
    process.exit(1);
  }

  console.log(`Products parsed: ${products.length}`);

  // Count categories
  const categoryCounts = new Map();
  let noCategory = 0;

  for (const p of products) {
    const cat = extractText(p?.category);
    if (!cat) {
      noCategory++;
      continue;
    }
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
  }

  // Sort by count descending
  const sorted = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Print table
  console.log('\n========================================');
  console.log('  Megapap Categories');
  console.log('========================================');
  console.log(`  Total products:     ${products.length}`);
  console.log(`  Unique categories:  ${sorted.length}`);
  if (noCategory > 0) {
    console.log(`  No category:        ${noCategory}`);
  }
  console.log('========================================\n');

  const maxCountWidth = String(sorted[0]?.[1] || 0).length;

  console.log(`  ${'Count'.padStart(maxCountWidth)} | Category`);
  console.log(`  ${'-'.repeat(maxCountWidth)}-+${'-'.repeat(60)}`);
  for (const [cat, count] of sorted) {
    console.log(`  ${String(count).padStart(maxCountWidth)} | ${cat}`);
  }

  // Write JSON
  const jsonPath = 'megapap-categories.json';
  const exportData = {
    generatedAt: new Date().toISOString(),
    xmlSource: xmlPathResolved,
    totalProducts: products.length,
    uniqueCategories: sorted.length,
    noCategory,
    categories: sorted.map(([cat, count]) => ({ category: cat, count })),
  };
  await fs.writeFile(jsonPath, JSON.stringify(exportData, null, 2));
  console.log(`\nWritten: ${jsonPath}`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
