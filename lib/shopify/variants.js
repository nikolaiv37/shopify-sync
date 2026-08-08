/**
 * Read-only Shopify variant index for missing-product comparison.
 *
 * Paginates every product variant and builds SKU + barcode lookup maps so the
 * compare step can decide which supplier products already exist in the store.
 * No mutations.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch all Shopify variants and index them by SKU and by barcode.
 *
 * @param {{ gqlWithRetry: Function }} client - from createShopifyClient()
 * @param {{ onProgress?: (info: {page:number,total:number}) => void }} [opts]
 * @returns {Promise<{ bySku: Map<string, object[]>, byBarcode: Map<string, object[]>, total: number }>}
 */
export async function fetchVariantIndex(client, opts = {}) {
  const bySku = new Map();
  const byBarcode = new Map();
  let cursor = null;
  let page = 0;
  let total = 0;

  for (;;) {
    page++;
    const data = await client.gqlWithRetry(
      `query variantIndex($cursor: String) {
        productVariants(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            barcode
            price
            compareAtPrice
            product { id vendor title status }
          }
        }
      }`,
      { cursor },
      `variants page ${page}`,
    );

    for (const v of data.productVariants.nodes) {
      total++;
      const row = {
        variantId: v.id,
        productId: v.product?.id ?? null,
        vendor: v.product?.vendor ?? null,
        productTitle: v.product?.title ?? null,
        productStatus: v.product?.status ?? null,
        currentPrice: v.price,
        currentCompareAt: v.compareAtPrice ?? null,
      };
      const sku = v.sku?.trim();
      if (sku) {
        const list = bySku.get(sku) ?? [];
        list.push(row);
        bySku.set(sku, list);
      }
      const barcode = v.barcode?.trim();
      if (barcode) {
        const list = byBarcode.get(barcode) ?? [];
        list.push(row);
        byBarcode.set(barcode, list);
      }
    }

    if (typeof opts.onProgress === 'function') opts.onProgress({ page, total });
    if (!data.productVariants.pageInfo.hasNextPage) break;
    cursor = data.productVariants.pageInfo.endCursor;
    await sleep(120);
  }

  return { bySku, byBarcode, total };
}

/**
 * Read the CURRENT state of specific variants by GID (short request, used for
 * per-batch stale-price verification). Returns a Map keyed by variant id.
 *
 * @param {{ gqlWithRetry: Function }} client
 * @param {string[]} ids - Shopify ProductVariant GIDs
 * @returns {Promise<Map<string, { variantId, sku, currentPrice, vendor, productId }>>}
 */
export async function fetchVariantsByIds(client, ids) {
  const out = new Map();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const data = await client.gqlWithRetry(
      `query variantsByIds($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            sku
            price
            compareAtPrice
            product { id vendor }
          }
        }
      }`,
      { ids: chunk },
      `variants-by-id ${i / 100 + 1}`,
    );
    for (const node of data.nodes || []) {
      if (!node?.id) continue;
      out.set(node.id, {
        variantId: node.id,
        sku: node.sku?.trim() ?? '',
        currentPrice: node.price,
        currentCompareAt: node.compareAtPrice ?? null,
        vendor: node.product?.vendor ?? null,
        productId: node.product?.id ?? null,
      });
    }
  }
  return out;
}
