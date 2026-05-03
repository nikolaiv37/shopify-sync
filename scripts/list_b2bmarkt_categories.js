#!/usr/bin/env node
/**
 * List all categories found in B2BMarkt XML feed.
 *
 * Read-only: no Shopify calls, no mutations.
 *
 * Usage:
 *   node scripts/list_b2bmarkt_categories.js --xml=b2bmarkt_updated.xml
 *
 * Outputs:
 *   - Console table sorted by count descending
 *   - b2bmarkt-categories.json
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

function parseArgs(argv) {
  const args = argv.slice(2);
  let xmlPath = 'b2bmarkt_updated.xml';
  for (const a of args) {
    if (a.startsWith('--xml=')) {
      xmlPath = a.slice('--xml='.length);
    }
  }
  return { xmlPath };
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

function main() {
  const { xmlPath } = parseArgs(process.argv);
  const xmlPathResolved = path.resolve(xmlPath);

  console.log(`Reading: ${xmlPathResolved}`);

  return fs.readFile(xmlPathResolved, 'utf8').then((xmlText) => {
    const parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: true,
      attributesGroupName: '$attrs',
    });
    const parsed = parser.parse(xmlText);
    const products = findProductArray(parsed, 'Product');
    if (!products) {
      console.error('ERROR: No <Product> elements found in XML.');
      process.exit(1);
    }

    console.log(`Products parsed: ${products.length}`);

    // Collect categories
    const catMap = new Map();

    for (const p of products) {
      const catsRaw = p?.Categories?.Category;
      if (!catsRaw) continue;
      const arr = Array.isArray(catsRaw) ? catsRaw : [catsRaw];
      for (const c of arr) {
        const attrs = c?.$attrs ?? {};
        const text = extractText(c);
        const level = attrs.level ?? '';
        const key = `${level}|||${text}`;
        if (!catMap.has(key)) {
          catMap.set(key, { text, level, count: 0 });
        }
        catMap.get(key).count++;
      }
    }

    // Sort by count descending, then by text
    const sorted = Array.from(catMap.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.text.localeCompare(b.text);
    });

    // Console table
    const countW = String(sorted[0]?.count ?? 0).length;
    const levelW = Math.max(5, ...sorted.map((c) => c.level.length));
    console.log();
    console.log(`${'count'.padStart(countW)} | ${'level'.padEnd(levelW)} | category`);
    console.log('-'.repeat(countW + levelW + 4 + 60));
    for (const cat of sorted) {
      console.log(
        `${String(cat.count).padStart(countW)} | ${cat.level.padEnd(levelW)} | ${cat.text}`,
      );
    }

    console.log();
    console.log(`Total unique categories: ${sorted.length}`);

    // Write JSON
    const jsonPath = 'b2bmarkt-categories.json';
    const jsonData = {
      exportedAt: new Date().toISOString(),
      xmlSource: xmlPathResolved,
      totalProducts: products.length,
      totalCategories: sorted.length,
      categories: sorted.map((c) => ({
        text: c.text,
        level: c.level,
        count: c.count,
      })),
    };

    return fs.writeFile(jsonPath, JSON.stringify(jsonData, null, 2)).then(() => {
      console.log(`Written: ${jsonPath}`);
    });
  }).catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}

main();
