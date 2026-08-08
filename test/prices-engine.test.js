import test from 'node:test';
import assert from 'node:assert/strict';

import { getMultiplier, markupPercent, round2, computeTargetPrice, moneyString, parseMultiplier, effectiveMultiplier, PriceOperation } from '../lib/pricing/pricing-config.js';
import { buildFeedIndex, classifyPrices, PriceStatus } from '../lib/prices/engine.js';
import * as megapap from '../lib/suppliers/megapap/adapter.js';

// ---------- pricing config ----------

test('MegaPap canonical multiplier is 2.5 (150% markup)', () => {
  assert.equal(getMultiplier('megapap'), 2.5);
  assert.equal(markupPercent(2.5), 150);
  assert.equal(getMultiplier('b2bmarkt'), 3.1);
  assert.equal(getMultiplier('symetron'), 3.1);
});

test('target = wholesale × 2.5, deterministic rounding', () => {
  assert.equal(computeTargetPrice('100', 2.5), 250);
  assert.equal(moneyString(computeTargetPrice('100', 2.5)), '250.00');
  // comma decimals + float safety
  assert.equal(computeTargetPrice('7,00', 2.5), 17.5);
  assert.equal(computeTargetPrice('12.34', 2.5), 30.85);
  assert.equal(round2(249.999999997), 250);
});

test('target is computed from wholesale, NOT from the current Shopify price', () => {
  const wholesale = 100;
  const currentShopify = 170; // old ×1.7 price
  const target = computeTargetPrice(wholesale, 2.5);
  assert.equal(target, 250);
  assert.notEqual(target, round2(currentShopify * 2.5)); // 425 — must never be used
});

test('invalid wholesale → null target', () => {
  assert.equal(computeTargetPrice('', 2.5), null);
  assert.equal(computeTargetPrice('abc', 2.5), null);
  assert.equal(computeTargetPrice('-5', 2.5), null);
});

// ---------- feed index via the real MegaPap adapter shape ----------

function megapapNode({ model, wholesale, name = 'X' }) {
  return { model, name, wholesale_price_without_vat: wholesale, category: 'C' };
}

test('buildFeedIndex parses MegaPap model/wholesale and flags feed duplicates', () => {
  const products = [
    megapapNode({ model: 'M1', wholesale: '100' }),
    megapapNode({ model: 'M2', wholesale: '40' }),
    megapapNode({ model: 'M2', wholesale: '41' }), // duplicate SKU in feed
    megapapNode({ model: '', wholesale: '10' }), // empty sku
  ];
  const idx = buildFeedIndex(megapap, products);
  assert.equal(idx.bySku.get('M1').wholesale, 100); // wholesale only; target derived later
  assert.equal(idx.emptySku, 1);
  assert.ok(idx.duplicateSkus.has('M2'));
});

// ---------- operation model ----------

test('parseMultiplier accepts dot/comma decimals, rejects zero/negative/NaN', () => {
  assert.equal(parseMultiplier('2.5'), 2.5);
  assert.equal(parseMultiplier('2,5'), 2.5);
  assert.equal(parseMultiplier(1.7), 1.7);
  assert.equal(parseMultiplier('0'), null);
  assert.equal(parseMultiplier('-1'), null);
  assert.equal(parseMultiplier('abc'), null);
  assert.equal(parseMultiplier(''), null);
});

test('effectiveMultiplier: SOURCE = ×1.0, MULTIPLIER = chosen value', () => {
  assert.equal(effectiveMultiplier(PriceOperation.SOURCE, null), 1);
  assert.equal(effectiveMultiplier(PriceOperation.MULTIPLIER, '2.3'), 2.3);
  assert.equal(effectiveMultiplier(PriceOperation.MULTIPLIER, 'bad'), null);
});

// ---------- classification ----------

function shopify(rows) {
  const bySku = new Map();
  for (const r of rows) {
    const list = bySku.get(r.sku) ?? [];
    list.push({
      variantId: r.variantId || `gid://v/${r.sku}`,
      productId: r.productId || `gid://p/${r.sku}`,
      vendor: r.vendor ?? 'Mebelcenter',
      productTitle: r.title ?? r.sku,
      currentPrice: r.price,
      currentCompareAt: r.compareAt ?? null,
    });
    bySku.set(r.sku, list);
  }
  return bySku;
}

// `effective` = selling effective multiplier; compare defaults to KEEP.
function run(feedProducts, shopifyRows, effective = 2.5, compareOperation = 'keep', compareMultiplier = null) {
  const feedIndex = buildFeedIndex(megapap, feedProducts);
  return classifyPrices({
    feedIndex,
    shopifyBySku: shopify(shopifyRows),
    supplierKey: 'megapap',
    sellingEffective: effective,
    compareOperation,
    compareMultiplier,
    sellingMeta: { operation: effective === 1 ? 'source' : 'multiplier', multiplier: effective === 1 ? null : effective },
    vendor: 'Mebelcenter',
  });
}

test('matched SKU with different price → CHANGE, selectable, correct target/diff', () => {
  const { rows, summary } = run(
    [megapapNode({ model: 'M1', wholesale: '100' })],
    [{ sku: 'M1', price: '170.00' }],
  );
  const row = rows[0];
  assert.equal(row.status, PriceStatus.CHANGE);
  assert.equal(row.selectable, true);
  assert.equal(row.currentPrice, 170);
  assert.equal(row.target, 250);
  assert.equal(row.diff, 80);
  assert.equal(summary.toChange, 1);
});

test('price already equal to ×2.5 target → ALREADY, not selectable', () => {
  const { rows, summary } = run(
    [megapapNode({ model: 'M1', wholesale: '100' })],
    [{ sku: 'M1', price: '250.00' }],
  );
  assert.equal(rows[0].status, PriceStatus.ALREADY);
  assert.equal(rows[0].selectable, false);
  assert.equal(summary.alreadyCorrect, 1);
  assert.equal(summary.toChange, 0);
});

test('feed SKU missing in Shopify → UNMATCHED, not selectable', () => {
  const { rows, summary } = run([megapapNode({ model: 'ZZZ', wholesale: '100' })], []);
  assert.equal(rows[0].status, PriceStatus.UNMATCHED);
  assert.equal(rows[0].selectable, false);
  assert.equal(summary.unmatched, 1);
});

test('duplicate Shopify SKU → CONFLICT, never selectable', () => {
  const { rows, summary } = run(
    [megapapNode({ model: 'M1', wholesale: '100' })],
    [{ sku: 'M1', price: '170', variantId: 'a' }, { sku: 'M1', price: '180', variantId: 'b' }],
  );
  assert.equal(rows[0].status, PriceStatus.CONFLICT);
  assert.equal(rows[0].reason, 'duplicate-shopify-sku');
  assert.equal(rows[0].selectable, false);
  assert.equal(summary.conflict, 1);
});

test('vendor mismatch on matched SKU → CONFLICT (collision guard)', () => {
  const { rows } = run(
    [megapapNode({ model: 'M1', wholesale: '100' })],
    [{ sku: 'M1', price: '10', vendor: 'Europe' }],
  );
  assert.equal(rows[0].status, PriceStatus.CONFLICT);
  assert.equal(rows[0].reason, 'vendor-mismatch');
  assert.equal(rows[0].selectable, false);
});

test('missing wholesale → INVALID_PRICE, not selectable', () => {
  const { rows, summary } = run(
    [megapapNode({ model: 'M1', wholesale: '' })],
    [{ sku: 'M1', price: '170' }],
  );
  assert.equal(rows[0].status, PriceStatus.INVALID_PRICE);
  assert.equal(rows[0].selectable, false);
  assert.equal(summary.invalidPrice, 1);
});

test('duplicate feed SKU → CONFLICT, never selectable', () => {
  const { rows } = run(
    [megapapNode({ model: 'M1', wholesale: '100' }), megapapNode({ model: 'M1', wholesale: '101' })],
    [{ sku: 'M1', price: '170' }],
  );
  assert.equal(rows[0].status, PriceStatus.CONFLICT);
  assert.equal(rows[0].reason, 'duplicate-feed-sku');
});

// ---------- operation-driven targets ----------

test('RESTORE (×1.0): target = wholesale, from feed not Shopify', () => {
  const { rows, summary } = run([megapapNode({ model: 'M1', wholesale: '100' })], [{ sku: 'M1', price: '250.00' }], 1);
  assert.equal(rows[0].status, PriceStatus.CHANGE);
  assert.equal(rows[0].target, 100); // wholesale, not 250
  assert.equal(rows[0].diff, -150); // 100 - 250
  assert.equal(summary.selling.operation, 'source');
});

test('MULTIPLIER ×2.5: target = wholesale × 2.5', () => {
  const { rows } = run([megapapNode({ model: 'M1', wholesale: '100' })], [{ sku: 'M1', price: '170.00' }], 2.5);
  assert.equal(rows[0].target, 250);
  assert.equal(rows[0].diff, 80);
});

test('MULTIPLIER ×2.3 on a product currently at 250: target = 100×2.3 = 230, NOT 250×2.3', () => {
  const { rows } = run([megapapNode({ model: 'M1', wholesale: '100' })], [{ sku: 'M1', price: '250.00' }], 2.3);
  assert.equal(rows[0].target, 230); // 100 × 2.3
  assert.notEqual(rows[0].target, 575); // never compound from current Shopify price
  assert.equal(rows[0].diff, -20); // 230 - 250
});

// ---------- compare-at (Сравнителна цена) ----------

const P = (over) => [megapapNode({ model: 'M1', wholesale: '100' })];

test('compare KEEP: compare-at untouched; only selling drives change', () => {
  const { rows } = run(P(), [{ sku: 'M1', price: '250.00', compareAt: '400' }], 2.5, 'keep');
  const r = rows[0];
  assert.equal(r.status, PriceStatus.ALREADY); // selling already 250, compare kept
  assert.equal(r.compareMode, 'keep');
  assert.equal(r.compareChanged, false);
  assert.equal(r.targetCompareAt, undefined);
});

test('compare CLEAR: existing compare-at → cleared → CHANGE', () => {
  const { rows } = run(P(), [{ sku: 'M1', price: '250.00', compareAt: '400' }], 2.5, 'clear');
  const r = rows[0];
  assert.equal(r.status, PriceStatus.CHANGE);
  assert.equal(r.compareMode, 'clear');
  assert.equal(r.compareChanged, true);
  assert.equal(r.targetCompareAt, null);
});

test('compare CLEAR when already empty → not changed', () => {
  const { rows } = run(P(), [{ sku: 'M1', price: '250.00', compareAt: null }], 2.5, 'clear');
  assert.equal(rows[0].compareChanged, false);
  assert.equal(rows[0].status, PriceStatus.ALREADY);
});

test('compare SOURCE: compare-at = wholesale (100)', () => {
  const { rows } = run(P(), [{ sku: 'M1', price: '250.00', compareAt: null }], 2.5, 'source');
  assert.equal(rows[0].targetCompareAt, 100);
  assert.equal(rows[0].compareChanged, true);
});

test('compare MULTIPLIER ×3.2: compare-at = 100×3.2 = 320', () => {
  const { rows } = run(P(), [{ sku: 'M1', price: '250.00', compareAt: null }], 2.5, 'multiplier', 3.2);
  assert.equal(rows[0].targetCompareAt, 320);
  assert.equal(rows[0].compareChanged, true);
});

test('BOTH: selling ×2.5 → 250, compare ×3.2 → 320 (both from wholesale)', () => {
  const { rows, summary } = run(P(), [{ sku: 'M1', price: '170', compareAt: null }], 2.5, 'multiplier', 3.2);
  const r = rows[0];
  assert.equal(r.target, 250);
  assert.equal(r.targetCompareAt, 320);
  assert.equal(r.sellingChanged, true);
  assert.equal(r.compareChanged, true);
  assert.equal(summary.changeBoth, 1);
});

test('NO COMPOUND: current selling 250 / compare 400, selling ×2.3 = 230, compare ×3.0 = 300', () => {
  const { rows } = run(P(), [{ sku: 'M1', price: '250', compareAt: '400' }], 2.3, 'multiplier', 3.0);
  assert.equal(rows[0].target, 230); // 100×2.3
  assert.equal(rows[0].targetCompareAt, 300); // 100×3.0
  assert.notEqual(rows[0].target, 575);
  assert.notEqual(rows[0].targetCompareAt, 1200);
});

test('compare-at warning when compare <= selling', () => {
  const { rows, summary } = run(P(), [{ sku: 'M1', price: '170', compareAt: null }], 2.5, 'multiplier', 2.0);
  // selling 250, compare 200 → warn
  assert.equal(rows[0].compareWarn, true);
  assert.equal(summary.compareWarnings, 1);
});

test('compare-only change (selling already correct) → CHANGE, changeCompareOnly', () => {
  const { rows, summary } = run(P(), [{ sku: 'M1', price: '250', compareAt: null }], 2.5, 'multiplier', 3.2);
  assert.equal(rows[0].sellingChanged, false);
  assert.equal(rows[0].compareChanged, true);
  assert.equal(rows[0].status, PriceStatus.CHANGE);
  assert.equal(summary.changeCompareOnly, 1);
});
