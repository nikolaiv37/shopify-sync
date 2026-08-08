/**
 * Deterministic supplier product → Shopify import rows.
 *
 * NO translation. Titles/descriptions pass through in the feed's own language
 * (Greek for B2BMarkt, English for Megapap) and are finalised by an employee in
 * Shopify. Everything structural is derived deterministically:
 *   - Type / Tags   from the category map (config/*-category-map.json)
 *   - Variant Price wholesale × supplier multiplier
 *   - Variant Weight kg → grams
 *   - Vendor        supplier config (Europe / Mebelcenter)
 *   - Status        always "draft" (never published)
 *
 * Produces one "product row" plus additional image-only rows (Shopify's
 * multi-image CSV convention), keyed by a shared Handle.
 */

import { resolveCategory } from './category-map.js';
import { computeRetailPrice, normalizePrice } from './pricing.js';

/** Ordered Shopify product-import columns. */
export const SHOPIFY_COLUMNS = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags',
  'Published', 'Option1 Name', 'Option1 Value', 'Variant SKU',
  'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy',
  'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price',
  'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode',
  'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card',
  'SEO Title', 'SEO Description', 'Variant Weight Unit', 'Variant Weight', 'Status',
];

const HM_CODE_RE = /HM\d+(?:\.\d+)?/g;
const HM_HEADING_RE = /\s*<p><strong>HM\d+(?:\.\d+)?<\/strong><\/p>/g;

/** Strip B2BMarkt internal "HM" model codes from customer-facing text. */
function stripHmCodes(value) {
  if (!value) return value;
  return String(value)
    .replace(HM_HEADING_RE, '')
    .replace(HM_CODE_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/<p>\s*<\/p>/g, '')
    .trim();
}

/** URL-safe Shopify handle from a SKU (SKUs are alphanumeric supplier codes). */
export function toHandle(sku) {
  const base = String(sku || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `product-${String(sku || '').replace(/\W+/g, '')}`;
}

/** kg (string/number) → integer grams string, or '' when absent. */
function toGrams(weightKg) {
  const n = Number.parseFloat(String(weightKg ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 1000));
}

function blankRow() {
  const row = {};
  for (const col of SHOPIFY_COLUMNS) row[col] = '';
  return row;
}

/**
 * Transform one canonical product into Shopify import rows.
 *
 * @param {object} product  from adapter.extractProduct()
 * @param {object} opts
 * @param {object} opts.config        adapter.config (vendor, priceMultiplier, key)
 * @param {object} opts.categoryMap   parsed category-map JSON
 * @param {string|null} [opts.forcedCategory]  user-selected category, preferred for mapping
 * @returns {{ handle: string, rows: object[], price: string, mapped: boolean, warnings: string[] }}
 */
export function transformProduct(product, opts) {
  const { config, categoryMap, forcedCategory = null } = opts;
  const warnings = [];

  // B2BMarkt-platform feeds (B2BMarkt, Symetron) embed internal "HM" model codes
  // in customer-facing text; strip them. Other suppliers pass through unchanged.
  const stripCodes = Boolean(config.stripHmCodes);
  const title = stripCodes ? stripHmCodes(product.title) : (product.title || '');
  const body = stripCodes ? stripHmCodes(product.description) : (product.description || '');

  const { type, tags, mapped } = resolveCategory(product, categoryMap, forcedCategory);
  if (!mapped) warnings.push('category-unmapped');

  const price = computeRetailPrice(product.wholesalePrice, config.priceMultiplier);
  if (price === '') warnings.push('missing-price');

  const compareAt = normalizePrice(product.retailPrice) || normalizePrice(product.marketPrice) || '';
  const handle = toHandle(product.sku);
  const weight = toGrams(product.weightKg);
  const qtyNum = Number.parseInt(String(product.stock ?? ''), 10);
  const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? String(qtyNum) : '0';
  const images = Array.isArray(product.images) ? product.images.filter(Boolean) : [];

  if (!title) warnings.push('missing-title');
  if (!images.length) warnings.push('no-image');

  const first = blankRow();
  Object.assign(first, {
    Handle: handle,
    Title: title,
    'Body (HTML)': body,
    Vendor: config.vendor,
    'Product Category': '', // Shopify standard taxonomy left blank; Type/Tags drive merchandising
    Type: type,
    Tags: tags.join(', '),
    Published: 'FALSE',
    'Option1 Name': 'Title',
    'Option1 Value': 'Default Title',
    'Variant SKU': String(product.sku || ''),
    'Variant Inventory Tracker': 'shopify',
    'Variant Inventory Qty': qty,
    'Variant Inventory Policy': 'deny',
    'Variant Fulfillment Service': 'manual',
    'Variant Price': price,
    'Variant Compare At Price': compareAt,
    'Variant Requires Shipping': 'TRUE',
    'Variant Taxable': 'TRUE',
    'Variant Barcode': String(product.barcode || ''),
    'Image Src': images[0] || '',
    'Image Position': images.length ? '1' : '',
    'Image Alt Text': images.length ? title : '',
    'Gift Card': 'FALSE',
    'SEO Title': '',
    'SEO Description': '',
    'Variant Weight Unit': weight ? 'g' : '',
    'Variant Weight': weight,
    Status: 'draft',
  });

  const rows = [first];
  for (let i = 1; i < images.length; i++) {
    const imgRow = blankRow();
    imgRow.Handle = handle;
    imgRow['Image Src'] = images[i];
    imgRow['Image Position'] = String(i + 1);
    rows.push(imgRow);
  }

  return { handle, rows, price, mapped, warnings };
}

/**
 * Transform many products. Returns the flat row list plus per-product summaries.
 */
export function transformProducts(products, opts) {
  const allRows = [];
  const summaries = [];
  for (const product of products) {
    const result = transformProduct(product, opts);
    allRows.push(...result.rows);
    summaries.push({
      sku: product.sku,
      title: result.rows[0].Title,
      type: result.rows[0].Type,
      price: result.price,
      images: (product.images || []).length,
      mapped: result.mapped,
      warnings: result.warnings,
    });
  }
  return { rows: allRows, summaries };
}
