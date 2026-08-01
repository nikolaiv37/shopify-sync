/**
 * B2BMarkt supplier adapter.
 *
 * Behaviour ported from export-missing-products.js (field extraction) and
 * list_b2bmarkt_categories.js (category listing). Source language: Greek.
 * Stable identifier for Shopify comparison: <ProductCode> (matched vs SKU;
 * barcode used as a secondary match by the compare step).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText, parseCatalog } from '../shared/xml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const config = {
  key: 'b2bmarkt',
  name: 'B2BMarkt',
  vendor: 'Europe',
  sourceLang: 'el', // Greek — passed through untranslated (drafts, edited in Shopify)
  productTag: 'Product',
  priceMultiplier: 3.1,
  defaultXml: path.join(REPO_ROOT, 'b2bmarkt_updated.xml'),
  categoryMapPath: path.join(REPO_ROOT, 'config', 'b2bmarkt-category-map.json'),
};

function getCategoryList(node) {
  const catsRaw = node?.Categories?.Category;
  if (!catsRaw) return [];
  const arr = Array.isArray(catsRaw) ? catsRaw : [catsRaw];
  return arr.map((c) => {
    const attrs = c?.$attrs ?? {};
    return { id: attrs.id ?? '', level: attrs.level ?? '', text: extractText(c) };
  });
}

function getImages(node) {
  const imgsRaw = node?.ImagesLocation?.image;
  if (!imgsRaw) return [];
  const arr = Array.isArray(imgsRaw) ? imgsRaw : [imgsRaw];
  return arr.map(extractText).filter(Boolean);
}

function getDimensions(node) {
  const packsRaw = node?.Packs?.Pack;
  if (!packsRaw) return null;
  const pack = Array.isArray(packsRaw) ? packsRaw[0] : packsRaw;
  const dimX = extractText(pack?.DimX);
  const dimY = extractText(pack?.DimY);
  const dimZ = extractText(pack?.DimZ);
  const weight = extractText(pack?.GrossWeight);
  const volume = extractText(pack?.MainVolume);
  if (!dimX && !dimY && !dimZ) return null;
  return {
    length_m: dimX || null,
    width_m: dimY || null,
    height_m: dimZ || null,
    gross_weight_kg: weight || null,
    volume_m3: volume || null,
  };
}

/** Parse the catalog XML string into raw product nodes. */
export function parseProducts(xmlText) {
  return parseCatalog(xmlText, config.productTag);
}

/** List unique categories with product counts (for the dashboard dropdown). */
export function listCategories(products) {
  const map = new Map();
  for (const p of products) {
    for (const c of getCategoryList(p)) {
      const key = `${c.level}|||${c.text}`;
      if (!map.has(key)) map.set(key, { text: c.text, level: c.level, count: 0 });
      map.get(key).count++;
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.text.localeCompare(b.text),
  );
}

/** True if the product belongs to `targetCategory` (exact category text match). */
export function matchesCategory(node, targetCategory) {
  return getCategoryList(node).some((c) => c.text === targetCategory);
}

/** Extract a canonical product object used by compare/transform. */
export function extractProduct(node) {
  return {
    supplier: config.key,
    sku: extractText(node?.ProductCode),
    identificationCode: extractText(node?.IdentificationCode) || null,
    title: extractText(node?.Name),
    description: extractText(node?.ExtendedDescription),
    wholesalePrice: extractText(node?.ZoneFourUnitPrice) || null,
    retailPrice: extractText(node?.RetailCurrentPrice) || null,
    marketPrice: extractText(node?.MarketPrice) || null,
    stock: extractText(node?.Stock) || null,
    availability: extractText(node?.AvailabilityTypeName) || null,
    weightKg: extractText(node?.Weight) || null,
    itemCode: extractText(node?.ItemCode) || null,
    barcode: extractText(node?.BarcodeMain) || null,
    images: getImages(node),
    categories: getCategoryList(node).map((c) => ({ level: c.level, text: c.text })),
    dimensions: getDimensions(node),
    productIdXml: extractText(node?.ProductId) || null,
  };
}

/** Keys used to detect an existing Shopify variant (priority order). */
export function matchKeys(product) {
  const skus = [product.sku, product.identificationCode].filter(Boolean).map((s) => String(s).trim());
  const barcodes = [product.barcode, product.identificationCode].filter(Boolean).map((s) => String(s).trim());
  return { skus, barcodes };
}
