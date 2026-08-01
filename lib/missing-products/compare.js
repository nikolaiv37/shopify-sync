/**
 * Read-only missing-product comparison.
 *
 * For each supplier product, decide whether an equivalent variant already
 * exists in Shopify, using a match priority ported from
 * scripts/b2bmarkt-missing/compare-vs-shopify.js:
 *   1. product SKU        vs Shopify SKU
 *   2. secondary code     vs Shopify SKU
 *   3. secondary code     vs Shopify barcode
 *   4. product SKU        vs Shopify barcode
 * (The exact key set per supplier comes from adapter.matchKeys().)
 *
 * No mutations. Pure function over already-fetched data → fully testable.
 */

/**
 * @param {object[]} products  canonical products (from adapter.extractProduct)
 * @param {{ bySku: Map, byBarcode: Map }} index  from fetchVariantIndex()
 * @param {{ matchKeys: Function }} adapter
 * @returns {{
 *   missing: object[], present: object[], invalid: object[],
 *   duplicateSkus: string[],
 *   counts: { total, missing, present, invalid, duplicates }
 * }}
 */
export function compareMissing(products, index, adapter) {
  const bySku = index.bySku || new Map();
  const byBarcode = index.byBarcode || new Map();

  const missing = [];
  const present = [];
  const invalid = [];

  const seenSku = new Map(); // sku -> count within this supplier batch
  const duplicateSkus = new Set();

  for (const product of products) {
    const { skus, barcodes } = adapter.matchKeys(product);

    if (!skus.length) {
      invalid.push({ ...product, reason: 'no-sku' });
      continue;
    }

    // Track duplicate supplier codes inside the scanned set.
    const primary = skus[0];
    seenSku.set(primary, (seenSku.get(primary) || 0) + 1);
    if (seenSku.get(primary) > 1) duplicateSkus.add(primary);

    let matchReason = null;
    let matchedVariant = null;

    for (const sku of skus) {
      if (bySku.has(sku)) {
        matchReason = `sku:${sku}`;
        matchedVariant = bySku.get(sku)[0];
        break;
      }
    }
    if (!matchReason) {
      for (const code of barcodes) {
        if (byBarcode.has(code)) {
          matchReason = `barcode:${code}`;
          matchedVariant = byBarcode.get(code)[0];
          break;
        }
      }
    }

    if (matchReason) {
      present.push({ ...product, matchReason, matchedVariant });
    } else {
      missing.push(product);
    }
  }

  return {
    missing,
    present,
    invalid,
    duplicateSkus: Array.from(duplicateSkus),
    counts: {
      total: products.length,
      missing: missing.length,
      present: present.length,
      invalid: invalid.length,
      duplicates: duplicateSkus.size,
    },
  };
}
