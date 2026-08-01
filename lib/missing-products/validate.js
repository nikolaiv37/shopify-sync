/**
 * Validation for prepared products. Read-only; produces warnings/errors used by
 * the review step and (later) as a guard before any Shopify draft creation.
 *
 * "errors" block a product from safe creation; "warnings" are non-blocking.
 */

/**
 * Validate a single product summary (from transformProducts).
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateSummary(summary) {
  const errors = [];
  const warnings = [];

  if (!summary.sku) errors.push('missing-sku');
  if (!summary.title) errors.push('missing-title');
  if (!summary.price) errors.push('missing-price');
  if (!summary.mapped) warnings.push('category-unmapped');
  if (!summary.images) warnings.push('no-image');

  // Fold any transform-emitted warnings in (deduplicated).
  for (const w of summary.warnings || []) {
    if (w === 'missing-price' || w === 'missing-title') continue; // already errors
    if (!warnings.includes(w)) warnings.push(w);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate a batch and split it into importable vs needs-review, and check for
 * duplicate SKUs against the current Shopify state (bySku from fetchVariantIndex).
 *
 * @param {object[]} summaries
 * @param {{ bySku?: Map }} [shopifyIndex]
 */
export function validateBatch(summaries, shopifyIndex = {}) {
  const bySku = shopifyIndex.bySku || new Map();
  const importable = [];
  const review = [];
  const duplicateInShopify = [];

  for (const summary of summaries) {
    const v = validateSummary(summary);
    if (summary.sku && bySku.has(String(summary.sku).trim())) {
      duplicateInShopify.push(summary.sku);
      v.errors.push('already-in-shopify');
      v.ok = false;
    }
    (v.ok ? importable : review).push({ ...summary, validation: v });
  }

  return {
    importable,
    review,
    duplicateInShopify,
    counts: {
      total: summaries.length,
      importable: importable.length,
      review: review.length,
      duplicatesInShopify: duplicateInShopify.length,
    },
  };
}
