/**
 * Megapap supplier adapter.
 *
 * Behaviour ported from export_missing_megapap_products.js and
 * list_megapap_categories.js. Source language: English (megapap_en feed) —
 * passed through untranslated. Stable identifier for Shopify comparison:
 * <model> (matched vs SKU; <ean> used as a secondary barcode match).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText, parseCatalog } from '../shared/xml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const config = {
  key: 'megapap',
  name: 'Megapap',
  vendor: 'Mebelcenter',
  sourceLang: 'en', // English feed — passed through untranslated
  productTag: 'product',
  priceMultiplier: 1.7,
  defaultXml: path.join(REPO_ROOT, 'megapap_en.xml'),
  categoryMapPath: path.join(REPO_ROOT, 'config', 'megapap-category-map.json'),
  categoryLabelsPath: path.join(REPO_ROOT, 'config', 'megapap-category-labels.json'),
  pathSeparator: ' > ',
  feedUrlEnv: 'MEGAPAP_FEED_URL',
};

function getImages(node) {
  const images = [];
  const mainImg = extractText(node?.main_image);
  if (mainImg) images.push(mainImg);
  const imgsRaw = node?.images?.image;
  if (imgsRaw) {
    const arr = Array.isArray(imgsRaw) ? imgsRaw : [imgsRaw];
    for (const img of arr) {
      const url = extractText(img);
      if (url && !images.includes(url)) images.push(url);
    }
  }
  return images;
}

/** Parse the catalog XML string into raw product nodes. */
export function parseProducts(xmlText) {
  return parseCatalog(xmlText, config.productTag);
}

/** List unique categories with product counts (for the dashboard dropdown). */
export function listCategories(products) {
  const map = new Map();
  for (const p of products) {
    const cat = extractText(p?.category);
    if (!cat) continue;
    if (!map.has(cat)) map.set(cat, { text: cat, level: '', count: 0 });
    map.get(cat).count++;
  }
  return Array.from(map.values()).sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.text.localeCompare(b.text),
  );
}

/** True if the product's category equals `targetCategory`. */
export function matchesCategory(node, targetCategory) {
  return extractText(node?.category) === targetCategory;
}

/** Extract a canonical product object used by compare/transform. */
export function extractProduct(node) {
  const category = extractText(node?.category);
  return {
    supplier: config.key,
    sku: extractText(node?.model),
    supplierSku: extractText(node?.sku) || null,
    ean: extractText(node?.ean) || null,
    title: extractText(node?.name),
    description: extractText(node?.description),
    wholesalePrice: extractText(node?.wholesale_price_without_vat) || null,
    retailPrice: extractText(node?.retail_price_with_vat) || null,
    marketPrice: extractText(node?.weboffer_price_with_vat) || null,
    stock: extractText(node?.quantity) || null,
    availability: extractText(node?.availability) || null,
    weightKg: extractText(node?.weight_item) || null,
    barcode: extractText(node?.ean) || null,
    manufacturer: extractText(node?.manufacturer) || null,
    images: getImages(node),
    // Megapap has a single breadcrumb category string; expose it in the same
    // shape as B2BMarkt so the category-map resolver is supplier-agnostic.
    categories: category ? [{ level: '', text: category }] : [],
    categoryId: extractText(node?.category_id) || null,
    dimensions: {
      width_cm: extractText(node?.comb_width_cm) || null,
      length_cm: extractText(node?.comb_length_cm) || null,
      height_cm: extractText(node?.comb_height_cm) || null,
    },
  };
}

/** Keys used to detect an existing Shopify variant (priority order). */
export function matchKeys(product) {
  const skus = [product.sku, product.supplierSku].filter(Boolean).map((s) => String(s).trim());
  const barcodes = [product.ean].filter(Boolean).map((s) => String(s).trim());
  return { skus, barcodes };
}
