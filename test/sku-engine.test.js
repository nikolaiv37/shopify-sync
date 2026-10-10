import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSkuFeedIndex, classifySkuMigration } from '../lib/sku/engine.js';

const migration = { key: 'megapap', vendor: 'Mebelcenter', oldField: 'model', newField: 'sku' };

function shopify(rows) {
  const bySku = new Map();
  for (const row of rows) {
    const list = bySku.get(row.sku) ?? [];
    list.push({
      variantId: row.variantId || `variant:${row.sku}`,
      productId: row.productId || `product:${row.sku}`,
      productTitle: row.title || row.sku,
      vendor: row.vendor || 'Mebelcenter',
    });
    bySku.set(row.sku, list);
  }
  return bySku;
}

test('SKU migration maps an old Shopify SKU to the approved feed field', () => {
  const feedIndex = buildSkuFeedIndex([{ model: '0086733', sku: 'GP011-0014', name: 'Chair' }], migration);
  const result = classifySkuMigration({ feedIndex, shopifyBySku: shopify([{ sku: '0086733' }]), migration });
  assert.equal(result.rows[0].status, 'change');
  assert.equal(result.rows[0].oldSku, '0086733');
  assert.equal(result.rows[0].newSku, 'GP011-0014');
  assert.equal(result.rows[0].selectable, true);
  assert.equal(result.summary.toChange, 1);
});

test('SKU migration is idempotent when Shopify already has the new SKU', () => {
  const feedIndex = buildSkuFeedIndex([{ model: 'OLD', sku: 'NEW' }], migration);
  const result = classifySkuMigration({ feedIndex, shopifyBySku: shopify([{ sku: 'NEW' }]), migration });
  assert.equal(result.rows[0].status, 'already');
  assert.equal(result.rows[0].selectable, false);
  assert.equal(result.summary.alreadyChanged, 1);
});

test('duplicate approved target SKUs are visible but old unique matches remain selectable', () => {
  const feedIndex = buildSkuFeedIndex([
    { model: 'OLD-1', sku: 'SAME' },
    { model: 'OLD-2', sku: 'SAME' },
  ], migration);
  const result = classifySkuMigration({
    feedIndex,
    shopifyBySku: shopify([{ sku: 'OLD-1' }, { sku: 'OLD-2' }]),
    migration,
  });
  assert.equal(result.summary.duplicateTargetValues, 1);
  assert.equal(result.summary.duplicateTargetProducts, 2);
  assert.ok(result.rows.every((row) => row.status === 'change' && row.selectable && row.duplicateTarget));
});

test('duplicate old Shopify SKU and vendor mismatch are blocked', () => {
  const feedIndex = buildSkuFeedIndex([
    { model: 'DUP', sku: 'NEW-1' },
    { model: 'OTHER', sku: 'NEW-2' },
  ], migration);
  const result = classifySkuMigration({
    feedIndex,
    shopifyBySku: shopify([
      { sku: 'DUP', variantId: 'v1' },
      { sku: 'DUP', variantId: 'v2' },
      { sku: 'OTHER', vendor: 'Europe' },
    ]),
    migration,
  });
  assert.equal(result.rows[0].reason, 'duplicate-shopify-old-sku');
  assert.equal(result.rows[1].reason, 'vendor-mismatch');
  assert.equal(result.summary.conflicts, 2);
});

test('missing identifiers are counted and excluded from migration rows', () => {
  const feedIndex = buildSkuFeedIndex([
    { model: '', sku: 'NEW' },
    { model: 'OLD', sku: '' },
    { model: 'OK', sku: 'NEW-OK' },
  ], migration);
  assert.equal(feedIndex.missingOldSku, 1);
  assert.equal(feedIndex.missingNewSku, 1);
  assert.equal(feedIndex.entries.length, 1);
});

