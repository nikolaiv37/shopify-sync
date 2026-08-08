/**
 * Price preview engine — pure, read-only classification.
 *
 * Given a supplier feed (parsed products) and a Shopify variant index (by SKU),
 * computes for every feed product what its Shopify selling price SHOULD be
 * (wholesale × canonical multiplier) and how it compares to the current Shopify
 * price. Produces per-row statuses and a summary. No network, no mutations.
 *
 * SAFETY MODEL (see section 20 of the spec):
 *   - Membership is established by SKU: a feed SKU must exist in Shopify.
 *   - The target price is ALWAYS wholesale × multiplier — never current × mult.
 *   - Ambiguous/unsafe rows are marked CONFLICT and are never selectable:
 *       * duplicate SKU within the feed        (which wholesale wins?)
 *       * duplicate SKU in Shopify             (which variant to write?)
 *       * matched variant with a different Vendor than the supplier's
 *         (likely a SKU collision with an unrelated product)
 */

import { round2, parseSourcePrice, parseShopifyMoney, computeTargetPrice, computeCompareTarget, CompareOperation } from '../pricing/pricing-config.js';

/** Null-aware money equality (both empty ⇒ equal). */
function moneyEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return round2(a) === round2(b);
}

export const PriceStatus = Object.freeze({
  CHANGE: 'change', // current price differs from target → safe to update
  ALREADY: 'already', // current price already equals target
  UNMATCHED: 'unmatched', // feed SKU not found in Shopify
  INVALID_PRICE: 'invalid_price', // wholesale missing/invalid
  CONFLICT: 'conflict', // ambiguous/unsafe — never written
});

/**
 * Build a feed index keyed by SKU using a supplier adapter. The index holds the
 * wholesale (source) price only; the target is derived later from the chosen
 * operation, so one parsed index is reusable across operations/multipliers.
 * @returns {{ bySku: Map, duplicateSkus: Set<string>, emptySku: number, rows: number }}
 */
export function buildFeedIndex(adapter, products) {
  const bySku = new Map();
  const duplicateSkus = new Set();
  let emptySku = 0;

  for (const node of products) {
    const p = adapter.extractProduct(node);
    const sku = String(p.sku || '').trim();
    if (!sku) {
      emptySku++;
      continue;
    }
    const wholesale = parseSourcePrice(p.wholesalePrice);
    const entry = { sku, title: p.title || '', wholesale };
    if (bySku.has(sku)) duplicateSkus.add(sku);
    bySku.set(sku, entry);
  }

  return { bySku, duplicateSkus, emptySku, rows: products.length };
}

/**
 * Classify every feed SKU against the Shopify index for BOTH the selling price
 * ("Продажна цена") and the compare-at price ("Сравнителна цена"). Both targets
 * derive from the SOURCE wholesale price — never from the current Shopify price.
 *
 * @param {object} args
 * @param {{ bySku: Map, duplicateSkus: Set, emptySku: number, rows: number }} args.feedIndex
 * @param {Map<string, object[]>} args.shopifyBySku - from fetchVariantIndex()
 * @param {string} args.supplierKey
 * @param {number} args.sellingEffective - selling operation multiplier (SOURCE = 1)
 * @param {string} args.compareOperation - 'keep' | 'clear' | 'source' | 'multiplier'
 * @param {number|null} [args.compareMultiplier] - operator compare-at multiplier
 * @param {object} [args.sellingMeta] - { operation, multiplier } for the summary
 * @param {object} [args.compareMeta] - { operation, multiplier } for the summary
 * @param {string} args.vendor - expected Shopify vendor for this supplier
 * @returns {{ rows: object[], summary: object }}
 */
export function classifyPrices({
  feedIndex,
  shopifyBySku,
  supplierKey,
  sellingEffective,
  compareOperation = CompareOperation.KEEP,
  compareMultiplier = null,
  sellingMeta = null,
  compareMeta = null,
  vendor,
}) {
  const rows = [];
  const counts = {
    feedProducts: feedIndex.bySku.size,
    feedRows: feedIndex.rows,
    feedEmptySku: feedIndex.emptySku,
    feedDuplicateSku: feedIndex.duplicateSkus.size,
    matched: 0,
    toChange: 0,
    alreadyCorrect: 0,
    unmatched: 0,
    invalidPrice: 0,
    conflict: 0,
    changeSellingOnly: 0,
    changeCompareOnly: 0,
    changeBoth: 0,
    compareWarnings: 0,
  };

  for (const [sku, feed] of feedIndex.bySku) {
    // Targets derived from the SOURCE wholesale price only.
    const target = feed.wholesale == null ? null : computeTargetPrice(feed.wholesale, sellingEffective);
    const compare = computeCompareTarget(compareOperation, compareMultiplier, feed.wholesale);
    const base = {
      sku,
      title: feed.title,
      wholesale: feed.wholesale,
      target,
      currentPrice: null,
      diff: null,
      currentCompareAt: null,
      targetCompareAt: compare.mode === 'keep' ? undefined : compare.value,
      compareMode: compare.mode,
      sellingChanged: false,
      compareChanged: false,
      compareWarn: false,
      variantId: null,
      productId: null,
      vendor: null,
      selectable: false,
    };

    if (feedIndex.duplicateSkus.has(sku)) {
      counts.conflict++;
      rows.push({ ...base, status: PriceStatus.CONFLICT, reason: 'duplicate-feed-sku' });
      continue;
    }

    const shopifyRows = shopifyBySku.get(sku);
    if (!shopifyRows || shopifyRows.length === 0) {
      counts.unmatched++;
      rows.push({ ...base, status: PriceStatus.UNMATCHED, reason: 'no-shopify-match' });
      continue;
    }
    if (shopifyRows.length > 1) {
      counts.matched++;
      counts.conflict++;
      rows.push({ ...base, status: PriceStatus.CONFLICT, reason: 'duplicate-shopify-sku' });
      continue;
    }

    const variant = shopifyRows[0];
    counts.matched++;
    const currentSelling = parseShopifyMoney(variant.currentPrice);
    const currentCompare = parseShopifyMoney(variant.currentCompareAt);
    const enriched = {
      ...base,
      title: variant.productTitle || feed.title,
      currentPrice: currentSelling,
      currentCompareAt: currentCompare,
      variantId: variant.variantId,
      productId: variant.productId,
      vendor: variant.vendor ?? null,
    };

    if (vendor && variant.vendor && variant.vendor !== vendor) {
      counts.conflict++;
      rows.push({ ...enriched, status: PriceStatus.CONFLICT, reason: 'vendor-mismatch' });
      continue;
    }

    // Invalid wholesale (selling always needs it; compare set-modes too).
    if (target == null || (compare.mode === 'set' && compare.value == null)) {
      counts.invalidPrice++;
      rows.push({ ...enriched, status: PriceStatus.INVALID_PRICE, reason: 'invalid-wholesale' });
      continue;
    }

    const sellingChanged = currentSelling == null || round2(currentSelling) !== target;
    let compareChanged = false;
    if (compare.mode === 'clear') compareChanged = currentCompare != null;
    else if (compare.mode === 'set') compareChanged = !moneyEqual(currentCompare, compare.value);
    // mode 'keep' → compareChanged stays false

    const compareWarn = compare.mode === 'set' && compare.value != null && round2(compare.value) <= target;
    if (compareWarn) counts.compareWarnings++;

    const diff = currentSelling == null ? null : round2(target - currentSelling);
    const row = { ...enriched, sellingChanged, compareChanged, compareWarn, diff };

    if (!sellingChanged && !compareChanged) {
      counts.alreadyCorrect++;
      rows.push({ ...row, status: PriceStatus.ALREADY, reason: null });
      continue;
    }

    counts.toChange++;
    if (sellingChanged && compareChanged) counts.changeBoth++;
    else if (sellingChanged) counts.changeSellingOnly++;
    else counts.changeCompareOnly++;

    rows.push({ ...row, status: PriceStatus.CHANGE, reason: null, selectable: true });
  }

  return {
    rows,
    summary: {
      supplier: supplierKey,
      vendor,
      selling: sellingMeta,
      compare: compareMeta,
      ...counts,
    },
  };
}
