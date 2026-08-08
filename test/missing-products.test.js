/**
 * Focused unit tests for the missing-products core (compare + transform +
 * category-map + pricing). Pure functions, small inline fixtures — no network,
 * no real supplier feeds. Run with: node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { compareMissing } from '../lib/missing-products/compare.js';
import { transformProduct, transformProducts, toHandle } from '../lib/missing-products/transform.js';
import { resolveCategory, normalizeEntry } from '../lib/missing-products/category-map.js';
import { normalizePrice, computeRetailPrice } from '../lib/missing-products/pricing.js';
import { validateBatch } from '../lib/missing-products/validate.js';
import * as b2bmarkt from '../lib/suppliers/b2bmarkt/adapter.js';
import * as megapap from '../lib/suppliers/megapap/adapter.js';

// ---------- pricing ----------

test('normalizePrice handles thousands vs decimal separators', () => {
  assert.equal(normalizePrice('2,103.66'), '2103.66');
  assert.equal(normalizePrice('1,50'), '1.50');
  assert.equal(normalizePrice('99'), '99.00');
  assert.equal(normalizePrice(''), '');
  assert.equal(normalizePrice(null), '');
  assert.equal(normalizePrice('abc'), '');
});

test('computeRetailPrice applies supplier multipliers', () => {
  assert.equal(computeRetailPrice('100', 3.1), '310.00'); // B2BMarkt
  assert.equal(computeRetailPrice('100', 1.7), '170.00'); // Megapap
  assert.equal(computeRetailPrice('', 3.1), '');
});

// ---------- category map ----------

test('normalizeEntry supports old and new map formats', () => {
  assert.deepEqual(normalizeEntry({ type: 'Дивани', tags: ['Дивани'] }), {
    default: { type: 'Дивани', tags: ['Дивани'] }, rules: [],
  });
  const withRules = normalizeEntry({ default: { type: 'Дивани', tags: [] }, rules: [{ match: ['ъглов'], type: 'Ъглови дивани', tags: [] }] });
  assert.equal(withRules.rules.length, 1);
  assert.equal(normalizeEntry(null), null);
});

test('resolveCategory picks a rule by keyword, else default, else fallback', () => {
  const map = {
    'Σαλόνια - γωνίες': {
      default: { type: 'Дивани', tags: ['Дивани'] },
      rules: [{ match: ['ъглов'], type: 'Ъглови дивани', tags: ['Дивани - Ъглови дивани'] }],
    },
  };
  const cats = [{ level: '2', text: 'Σαλόνια - γωνίες' }];

  const ruled = resolveCategory({ categories: cats, title: 'Ъглов диван', description: '' }, map);
  assert.equal(ruled.type, 'Ъглови дивани');
  assert.equal(ruled.mapped, true);

  const def = resolveCategory({ categories: cats, title: 'Диван', description: '' }, map);
  assert.equal(def.type, 'Дивани');

  const unmapped = resolveCategory({ categories: [{ level: '2', text: 'Unknown cat' }], title: 'X', description: '' }, map);
  assert.equal(unmapped.mapped, false);
  assert.equal(unmapped.type, 'Unknown cat');
});

// ---------- compare (read-only diff) ----------

test('compareMissing splits present/missing by SKU and barcode', () => {
  const products = [
    { sku: 'A1', barcode: null, identificationCode: null },   // in shopify by sku
    { sku: 'B2', barcode: '5000', identificationCode: null },  // in shopify by barcode
    { sku: 'C3', barcode: null, identificationCode: null },    // missing
    { sku: '', barcode: null, identificationCode: null },      // invalid (no sku)
    { sku: 'C3', barcode: null, identificationCode: null },    // duplicate code
  ];
  const index = {
    bySku: new Map([['A1', [{ variantId: 'v1' }]]]),
    byBarcode: new Map([['5000', [{ variantId: 'v2' }]]]),
  };
  const res = compareMissing(products, index, b2bmarkt);
  assert.equal(res.counts.present, 2);
  assert.equal(res.counts.missing, 2); // C3 twice
  assert.equal(res.counts.invalid, 1);
  assert.deepEqual(res.duplicateSkus, ['C3']);
  assert.equal(res.present.find((p) => p.sku === 'B2').matchReason, 'barcode:5000');
});

// ---------- transform (deterministic, no translation) ----------

test('transformProduct builds a draft row without translating copy', () => {
  const map = { 'Παιδικό δωμάτιο': { type: 'Детска стая', tags: ['Детска стая'] } };
  const product = {
    supplier: 'b2bmarkt',
    sku: 'HM1234.01',
    title: 'Κρεβάτι HM1234.01 λευκό',
    description: '<p><strong>HM1234.01</strong></p><p>Ωραίο κρεβάτι HM1234.01</p>',
    wholesalePrice: '100',
    retailPrice: '450',
    weightKg: '12.5',
    stock: '3',
    barcode: '520000012345',
    images: ['https://img/1.jpg', 'https://img/2.jpg'],
    categories: [{ level: '2', text: 'Παιδικό δωμάτιο' }],
  };
  const { rows, price, warnings } = transformProduct(product, { config: b2bmarkt.config, categoryMap: map });

  assert.equal(rows.length, 2, 'one product row + one extra image row');
  const r = rows[0];
  assert.equal(r.Vendor, 'Europe');
  assert.equal(r.Status, 'draft');
  assert.equal(r.Published, 'FALSE');
  assert.equal(r.Type, 'Детска стая');
  assert.equal(r.Tags, 'Детска стая');
  assert.equal(r['Variant Price'], '310.00'); // 100 × 3.10
  assert.equal(r['Variant Weight'], '12500'); // kg → g
  assert.equal(r['Variant Weight Unit'], 'g');
  assert.equal(r['Variant SKU'], 'HM1234.01');
  assert.equal(r.Handle, 'hm1234-01');
  // HM codes stripped from customer-facing copy, source language preserved:
  assert.ok(!r.Title.includes('HM1234'), 'HM code stripped from title');
  assert.ok(r.Title.includes('Κρεβάτι'), 'Greek title preserved (no translation)');
  assert.ok(!r['Body (HTML)'].includes('HM1234'), 'HM code stripped from body');
  // second row is image-only
  assert.equal(rows[1]['Image Src'], 'https://img/2.jpg');
  assert.equal(rows[1]['Image Position'], '2');
  assert.equal(rows[1].Title, '');
  assert.deepEqual(warnings, []);
});

test('transformProduct flags missing price / image / unmapped category', () => {
  const product = {
    supplier: 'megapap', sku: 'M1', title: 'Wardrobe', description: 'Nice',
    wholesalePrice: '', weightKg: '', stock: '', images: [],
    categories: [{ level: '', text: 'Totally unknown' }],
  };
  const { warnings } = transformProduct(product, { config: megapap.config, categoryMap: {} });
  assert.ok(warnings.includes('missing-price'));
  assert.ok(warnings.includes('no-image'));
  assert.ok(warnings.includes('category-unmapped'));
});

test('megapap transform keeps English copy and uses the canonical ×2.5', () => {
  const map = { 'Indoor furniture > Wardrobes': { type: 'Гардероби', tags: ['Гардероби'] } };
  const product = {
    supplier: 'megapap', sku: 'W-100', title: 'Wardrobe 3 doors', description: 'Solid wood wardrobe',
    wholesalePrice: '200', weightKg: '40', stock: '5', barcode: '111', images: ['https://i/1.jpg'],
    categories: [{ level: '', text: 'Indoor furniture > Wardrobes' }],
  };
  const { rows } = transformProduct(product, { config: megapap.config, categoryMap: map });
  assert.equal(rows[0].Vendor, 'Mebelcenter');
  assert.equal(rows[0]['Variant Price'], '500.00'); // 200 × 2.5 (canonical MegaPap rule)
  assert.equal(rows[0].Title, 'Wardrobe 3 doors'); // English preserved
  assert.equal(rows[0].Type, 'Гардероби');
});

// ---------- validate ----------

test('validateBatch separates importable from review and flags shopify dupes', () => {
  const map = { Cat: { type: 'T', tags: [] } };
  const good = transformProducts([
    { sku: 'G1', title: 'Good', description: 'd', wholesalePrice: '10', weightKg: '1', stock: '1', images: ['x'], categories: [{ text: 'Cat' }] },
  ], { config: b2bmarkt.config, categoryMap: map }).summaries;
  const bad = transformProducts([
    { sku: 'B1', title: '', description: '', wholesalePrice: '', weightKg: '', stock: '', images: [], categories: [{ text: 'Cat' }] },
  ], { config: b2bmarkt.config, categoryMap: map }).summaries;

  const res = validateBatch([...good, ...bad], { bySku: new Map() });
  assert.equal(res.counts.importable, 1);
  assert.equal(res.counts.review, 1);

  const dupe = validateBatch(good, { bySku: new Map([['G1', [{}]]]) });
  assert.equal(dupe.counts.duplicatesInShopify, 1);
  assert.equal(dupe.counts.importable, 0);
});

// ---------- adapters ----------

test('supplier adapters expose a consistent interface', () => {
  for (const a of [b2bmarkt, megapap]) {
    assert.equal(typeof a.parseProducts, 'function');
    assert.equal(typeof a.listCategories, 'function');
    assert.equal(typeof a.matchesCategory, 'function');
    assert.equal(typeof a.extractProduct, 'function');
    assert.equal(typeof a.matchKeys, 'function');
    assert.ok(a.config.vendor && a.config.priceMultiplier > 0);
  }
  assert.equal(b2bmarkt.config.vendor, 'Europe');
  assert.equal(megapap.config.vendor, 'Mebelcenter');
});

test('toHandle produces URL-safe handles', () => {
  assert.equal(toHandle('HM1234.01'), 'hm1234-01');
  assert.equal(toHandle('AB 55/2'), 'ab-55-2');
});
