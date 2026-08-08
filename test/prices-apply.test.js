import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRow, rowStale, batchInputs, batchWrites, executeBatches, buildVariantPriceMap } from '../lib/prices/apply.js';

const feedEntry = { sku: 'M1', wholesale: 100 };
const node = (over = {}) => ({ variantId: 'v1', sku: 'M1', currentPrice: '170.00', currentCompareAt: null, vendor: 'Mebelcenter', productId: 'p1', ...over });

function evalRow(over = {}) {
  return evaluateRow({
    node: node(),
    requestedSku: 'M1',
    feedEntry,
    isFeedDuplicate: false,
    expectedVendor: 'Mebelcenter',
    sellingEffective: 2.5,
    compareOperation: 'keep',
    compareMultiplier: null,
    ...over,
  });
}

// ---------- evaluateRow: trusted server verification ----------

test('evaluateRow recomputes selling target from feed, never from client (×2.5)', () => {
  const v = evalRow();
  assert.equal(v.status, 'candidate');
  assert.equal(v.targetSelling, 250); // 100×2.5, not 170×2.5
  assert.equal(v.sellingChanged, true);
  assert.equal(v.compareChanged, false); // keep
});

test('evaluateRow ×2.3 on a 250 product → 230, not 575', () => {
  const v = evalRow({ node: node({ currentPrice: '250.00' }), sellingEffective: 2.3 });
  assert.equal(v.targetSelling, 230);
  assert.notEqual(v.targetSelling, 575);
});

test('evaluateRow already-correct selling + keep compare → already', () => {
  const v = evalRow({ node: node({ currentPrice: '250.00' }) });
  assert.equal(v.status, 'already');
});

test('evaluateRow rejects conflicts', () => {
  assert.equal(evalRow({ node: null }).reason, 'variant-missing');
  assert.equal(evalRow({ node: node({ sku: 'X' }) }).reason, 'sku-mismatch');
  assert.equal(evalRow({ node: node({ vendor: 'Europe' }) }).reason, 'vendor-mismatch');
  assert.equal(evalRow({ feedEntry: undefined }).reason, 'not-in-feed');
  assert.equal(evalRow({ isFeedDuplicate: true }).reason, 'duplicate-feed-sku');
  assert.equal(evalRow({ feedEntry: { wholesale: null } }).status, 'invalid');
});

// compare-at modes
test('evaluateRow compare CLEAR: existing compare → change, mode clear, target null', () => {
  const v = evalRow({ node: node({ currentPrice: '250', currentCompareAt: '400' }), compareOperation: 'clear' });
  assert.equal(v.compareMode, 'clear');
  assert.equal(v.compareChanged, true);
  assert.equal(v.targetCompare, null);
  assert.equal(v.status, 'candidate');
});

test('evaluateRow compare CLEAR when already empty → no change', () => {
  const v = evalRow({ node: node({ currentPrice: '250', currentCompareAt: null }), compareOperation: 'clear' });
  assert.equal(v.compareChanged, false);
});

test('evaluateRow compare MULTIPLIER ×3.2 → 320 from wholesale', () => {
  const v = evalRow({ node: node({ currentPrice: '250', currentCompareAt: null }), compareOperation: 'multiplier', compareMultiplier: 3.2 });
  assert.equal(v.targetCompare, 320);
  assert.equal(v.compareChanged, true);
});

test('evaluateRow selling KEEP + compare MULTIPLIER changes compare only', () => {
  const v = evalRow({ node: node({ currentPrice: '250', currentCompareAt: '270' }), sellingEffective: null, compareOperation: 'multiplier', compareMultiplier: 3.2 });
  assert.equal(v.status, 'candidate');
  assert.equal(v.targetSelling, null);
  assert.equal(v.sellingChanged, false);
  assert.equal(v.liveSelling, 250);
  assert.equal(v.targetCompare, 320);
  assert.equal(v.compareChanged, true);
});

test('evaluateRow selling KEEP + compare KEEP is already', () => {
  const v = evalRow({ node: node({ currentPrice: '250', currentCompareAt: '270' }), sellingEffective: null, compareOperation: 'keep' });
  assert.equal(v.status, 'already');
  assert.equal(v.targetSelling, null);
  assert.equal(v.sellingChanged, false);
  assert.equal(v.compareChanged, false);
});

test('evaluateRow selling KEEP validates compare against live selling', () => {
  const v = evalRow({ node: node({ currentPrice: '250', currentCompareAt: '270' }), sellingEffective: null, compareOperation: 'multiplier', compareMultiplier: 2.0 });
  assert.equal(v.targetCompare, 200);
  assert.equal(v.compareWarn, true);
});

test('evaluateRow BOTH change: selling 250 + compare 320', () => {
  const v = evalRow({ node: node({ currentPrice: '170', currentCompareAt: null }), compareOperation: 'multiplier', compareMultiplier: 3.2 });
  assert.equal(v.targetSelling, 250);
  assert.equal(v.targetCompare, 320);
  assert.equal(v.sellingChanged, true);
  assert.equal(v.compareChanged, true);
});

test('evaluateRow warns when compare <= selling', () => {
  const v = evalRow({ node: node({ currentPrice: '170', currentCompareAt: null }), compareOperation: 'multiplier', compareMultiplier: 2.0 });
  assert.equal(v.compareWarn, true); // 200 <= 250
});

// ---------- rowStale: field-specific ----------

test('rowStale: selling changed after preview → stale', () => {
  const cand = { sellingChanged: true, compareChanged: false, liveSelling: 183.5, liveCompare: null };
  assert.equal(rowStale(cand, 170, null).stale, true); // captured old 170, live 183.5
});

test('rowStale: selling still matches preview → not stale', () => {
  const cand = { sellingChanged: true, compareChanged: false, liveSelling: 170, liveCompare: null };
  assert.equal(rowStale(cand, 170, null).stale, false);
});

test('rowStale: compare changed after preview → stale (compare op active)', () => {
  const cand = { sellingChanged: false, compareChanged: true, liveSelling: 250, liveCompare: 350 };
  assert.equal(rowStale(cand, 250, 300).stale, true); // captured compare 300, live 350
});

test('rowStale: compare KEEP (compareChanged false) ignores a compare change', () => {
  const cand = { sellingChanged: true, compareChanged: false, liveSelling: 170, liveCompare: 999 };
  assert.equal(rowStale(cand, 170, 300).stale, false); // we do not touch compare
});

// ---------- batchInputs: conditional fields ----------

test('batchInputs sends only changed fields (selling only)', () => {
  const writes = [{ variantId: 'v1', productId: 'p1', sku: 'M1', sellingChanged: true, targetSelling: 250, compareChanged: false }];
  const jobs = batchInputs(writes, 100, (w) => {
    const input = { id: w.variantId, sku: w.sku };
    if (w.sellingChanged) input.price = '250.00';
    if (w.compareChanged) input.compareAtPrice = null;
    return input;
  });
  assert.deepEqual(jobs[0].variants[0], { id: 'v1', sku: 'M1', price: '250.00' });
  assert.ok(!('compareAtPrice' in jobs[0].variants[0]));
});

test('batchInputs sends only compareAtPrice for compare-only writes', () => {
  const writes = [{ variantId: 'v1', productId: 'p1', sku: 'M1', sellingChanged: false, targetSelling: null, compareChanged: true, compareMode: 'set', targetCompare: 320 }];
  const jobs = batchInputs(writes, 100, (w) => {
    const input = { id: w.variantId, sku: w.sku };
    if (w.sellingChanged) input.price = w.targetSelling.toFixed(2);
    if (w.compareChanged) input.compareAtPrice = w.compareMode === 'clear' ? null : w.targetCompare.toFixed(2);
    return input;
  });
  assert.deepEqual(jobs[0].variants[0], { id: 'v1', sku: 'M1', compareAtPrice: '320.00' });
  assert.ok(!('price' in jobs[0].variants[0]));
});

test('batchInputs clears compare with null', () => {
  const writes = [{ variantId: 'v1', productId: 'p1', sku: 'M1' }];
  const jobs = batchInputs(writes, 100, (w) => ({ id: w.variantId, sku: w.sku, compareAtPrice: null }));
  assert.equal(jobs[0].variants[0].compareAtPrice, null);
});

test('batchWrites (price-only convenience) still groups by product + chunks', () => {
  const writes = [
    { variantId: 'a', productId: 'p1', sku: 'A', targetPrice: 250 },
    { variantId: 'b', productId: 'p1', sku: 'B', targetPrice: 99.9 },
    { variantId: 'c', productId: 'p2', sku: 'C', targetPrice: 12.5 },
  ];
  const jobs = batchWrites(writes, 100, (w) => w.targetPrice);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.find((j) => j.productId === 'p1').variants.map((v) => v.price), ['250.00', '99.90']);
});

// ---------- execution (mocked client, NEVER real Shopify) ----------

function mockClient({ failProduct } = {}) {
  return {
    async gqlWithRetry(_q, variables) {
      if (failProduct && variables.productId === failProduct) {
        return { productVariantsBulkUpdate: { productVariants: [], userErrors: [{ field: 'price', message: 'bad price' }] } };
      }
      return { productVariantsBulkUpdate: { productVariants: variables.variants.map((v) => ({ id: v.id })), userErrors: [] } };
    },
  };
}

test('executeBatches strips sku and reports successes', async () => {
  const jobs = batchInputs(
    [{ variantId: 'a', productId: 'p1', sku: 'A' }, { variantId: 'b', productId: 'p2', sku: 'B' }],
    100,
    (w) => ({ id: w.variantId, sku: w.sku, price: '250.00', compareAtPrice: null }),
  );
  const client = mockClient();
  const res = await executeBatches(client, jobs, { concurrency: 2 });
  assert.equal(res.success.length, 2);
  assert.equal(res.failed.length, 0);
});

test('executeBatches isolates a failed product batch', async () => {
  const jobs = batchInputs(
    [{ variantId: 'a', productId: 'p1', sku: 'A' }, { variantId: 'b', productId: 'p2', sku: 'B' }],
    100,
    (w) => ({ id: w.variantId, sku: w.sku, price: '250.00' }),
  );
  const res = await executeBatches(mockClient({ failProduct: 'p2' }), jobs, { concurrency: 1 });
  assert.equal(res.success.length, 1);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].error, 'bad price');
});

test('executeBatches turns a thrown error into failed items', async () => {
  const jobs = batchInputs([{ variantId: 'a', productId: 'p1', sku: 'A' }], 100, (w) => ({ id: w.variantId, sku: w.sku, price: '1.00' }));
  const client = { async gqlWithRetry() { throw new Error('network down'); } };
  const res = await executeBatches(client, jobs, { concurrency: 1 });
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /network down/);
});

// ---------- rollback restores EXACT old values for both fields ----------

test('rollback builder restores exact old selling + compare (not reconstructed)', () => {
  // job wrote selling 250 / compare 320; originals were 183.50 / 260
  const writes = [{ variantId: 'v1', productId: 'p1', sku: 'M1', sellingChanged: true, compareChanged: true, restoreSelling: 183.5, restoreCompare: 260 }];
  const jobs = batchInputs(writes, 100, (w) => {
    const input = { id: w.variantId, sku: w.sku };
    if (w.sellingChanged) input.price = w.restoreSelling.toFixed(2);
    if (w.compareChanged) input.compareAtPrice = w.restoreCompare == null ? null : w.restoreCompare.toFixed(2);
    return input;
  });
  assert.equal(jobs[0].variants[0].price, '183.50');
  assert.equal(jobs[0].variants[0].compareAtPrice, '260.00');
});

test('buildVariantPriceMap flattens a bySku index to variantId → price', () => {
  const bySku = new Map([['M1', [{ variantId: 'v1', currentPrice: '170.00' }]]]);
  assert.equal(buildVariantPriceMap(bySku).get('v1'), 170);
});
