/**
 * Price apply / rollback primitives.
 *
 * Pure planning + thin Shopify execution, kept separate so the risky logic is
 * unit-tested with a mocked client and NEVER runs on import.
 *
 * Writes ONLY the intended fields — the selling `price` and/or the
 * `compareAtPrice` — depending on the chosen operations. Never touches SKU,
 * inventory, cost, vendor, title, tags, collections, or status.
 *
 * Both targets are always derived from the SOURCE wholesale price (see engine),
 * never from the current Shopify price. Stale-state protection is field-specific:
 * a field is only overwritten if its live value still matches the value captured
 * at preview.
 */

import { round2, moneyString, parseShopifyMoney, computeTargetPrice, computeCompareTarget } from '../pricing/pricing-config.js';

export const ApplyItemStatus = Object.freeze({
  SUCCESS: 'success',
  SKIPPED: 'skipped',
  FAILED: 'failed',
});

// ProductVariantsBulkInput supports `price` and `compareAtPrice`. Passing
// compareAtPrice: null clears it; omitting it leaves it untouched.
const BULK_MUTATION = `
  mutation priceBulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message }
    }
  }
`;

/** Null-aware money equality (both empty ⇒ equal). */
function moneyEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return round2(a) === round2(b);
}

/**
 * Server-side trusted verification of one candidate for BOTH fields against the
 * CURRENT live variant + CURRENT feed. Never trusts client numbers — targets are
 * recomputed from the feed wholesale.
 *
 * @returns {object} { status: 'conflict'|'invalid'|'already'|'candidate', reason?,
 *   wholesale, productId, liveSelling, liveCompare, targetSelling, sellingChanged,
 *   compareMode: 'keep'|'set'|'clear', targetCompare, compareChanged, compareWarn }
 */
export function evaluateRow({ node, requestedSku, feedEntry, isFeedDuplicate, expectedVendor, sellingEffective, compareOperation, compareMultiplier }) {
  if (!node) return { status: 'conflict', reason: 'variant-missing' };
  if (!node.sku || node.sku !== requestedSku) return { status: 'conflict', reason: 'sku-mismatch' };
  if (expectedVendor && node.vendor && node.vendor !== expectedVendor) return { status: 'conflict', reason: 'vendor-mismatch' };
  if (!feedEntry) return { status: 'conflict', reason: 'not-in-feed' };
  if (isFeedDuplicate) return { status: 'conflict', reason: 'duplicate-feed-sku' };

  const wholesale = feedEntry.wholesale;
  const keepSelling = sellingEffective == null;
  const targetSelling = keepSelling ? null : computeTargetPrice(wholesale, sellingEffective);
  const compare = computeCompareTarget(compareOperation, compareMultiplier, wholesale);
  if ((!keepSelling && targetSelling == null) || (compare.mode === 'set' && compare.value == null)) {
    return { status: 'invalid', reason: 'invalid-wholesale' };
  }

  const liveSelling = parseShopifyMoney(node.currentPrice);
  const liveCompare = parseShopifyMoney(node.currentCompareAt);
  const sellingChanged = keepSelling ? false : liveSelling == null || round2(liveSelling) !== targetSelling;
  let compareChanged = false;
  if (compare.mode === 'clear') compareChanged = liveCompare != null;
  else if (compare.mode === 'set') compareChanged = !moneyEqual(liveCompare, compare.value);

  const effectiveSelling = keepSelling ? liveSelling : targetSelling;
  const compareWarn = compare.mode === 'set' && compare.value != null && effectiveSelling != null && round2(compare.value) <= round2(effectiveSelling);
  const status = sellingChanged || compareChanged ? 'candidate' : 'already';

  return {
    status,
    wholesale,
    productId: node.productId,
    liveSelling,
    liveCompare,
    targetSelling,
    sellingChanged,
    compareMode: compare.mode,
    targetCompare: compare.mode === 'keep' ? undefined : compare.value,
    compareChanged,
    compareWarn,
  };
}

/**
 * Field-specific stale check: a field is only stale-guarded if we intend to write
 * it. The live value (read fresh this step) must still equal the value captured
 * at preview (oldSelling / oldCompare).
 * @returns {{ stale: boolean, reason?: string }}
 */
export function rowStale(candidate, oldSelling, oldCompare) {
  if (candidate.sellingChanged && !moneyEqual(candidate.liveSelling, oldSelling)) {
    return { stale: true, reason: 'changed-after-preview' };
  }
  if (candidate.compareChanged && !moneyEqual(candidate.liveCompare, oldCompare)) {
    return { stale: true, reason: 'changed-after-preview' };
  }
  return { stale: false };
}

/** Flatten a fetchVariantIndex() bySku map to variantId → current price (number|null). */
export function buildVariantPriceMap(shopifyBySku) {
  const map = new Map();
  for (const rows of shopifyBySku.values()) {
    for (const r of rows) map.set(r.variantId, parseShopifyMoney(r.currentPrice));
  }
  return map;
}

/**
 * Group writes into product-scoped bulk jobs (chunked). `buildInput(w)` returns a
 * variant input like { id, sku, price?, compareAtPrice? } — only the fields to
 * write are present (compareAtPrice: null clears it).
 */
export function batchInputs(writes, chunkSize, buildInput) {
  const byProduct = new Map();
  for (const w of writes) {
    const list = byProduct.get(w.productId) ?? [];
    list.push(buildInput(w));
    byProduct.set(w.productId, list);
  }
  const jobs = [];
  for (const [productId, vars] of byProduct) {
    for (let i = 0; i < vars.length; i += chunkSize) {
      jobs.push({ productId, variants: vars.slice(i, i + chunkSize) });
    }
  }
  return jobs;
}

/** Convenience for price-only writes (kept for rollback/tests). */
export function batchWrites(writes, chunkSize, priceOf) {
  return batchInputs(writes, chunkSize, (w) => ({ id: w.variantId, sku: w.sku, price: moneyString(priceOf(w)) }));
}

/** Execute one product-scoped bulk update (sku is stripped from the payload). */
export async function executeBatch(client, job) {
  const inputs = job.variants.map(({ sku, ...input }) => input);
  const data = await client.gqlWithRetry(
    BULK_MUTATION,
    { productId: job.productId, variants: inputs },
    `price ${job.productId}`,
  );
  const errors = data?.productVariantsBulkUpdate?.userErrors || [];
  return { errors, variants: job.variants };
}

/**
 * Run all bulk jobs with bounded concurrency. Isolates failures per batch so a
 * single bad product does not abort the run.
 * @returns {Promise<{ success: object[], failed: object[] }>}
 */
export async function executeBatches(client, jobs, { concurrency = 2, onBatchDone } = {}) {
  const success = [];
  const failed = [];
  let idx = 0;

  const worker = async () => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      try {
        const { errors, variants } = await executeBatch(client, job);
        if (errors.length) {
          const message = errors.map((e) => e.message).join('; ').slice(0, 300);
          failed.push(...variants.map((v) => ({ sku: v.sku, variantId: v.id, error: message })));
        } else {
          success.push(...variants.map((v) => ({ sku: v.sku, variantId: v.id })));
        }
      } catch (e) {
        const message = String(e?.message || e).slice(0, 300);
        failed.push(...job.variants.map((v) => ({ sku: v.sku, variantId: v.id, error: message })));
      }
      if (typeof onBatchDone === 'function') onBatchDone();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, worker));
  return { success, failed };
}
