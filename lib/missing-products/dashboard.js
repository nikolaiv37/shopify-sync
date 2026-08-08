import fs from 'node:fs/promises';
import { getSupplier, SUPPLIERS } from '../suppliers/index.js';
import { createShopifyClient } from '../shopify/client.js';
import { fetchVariantIndex } from '../shopify/variants.js';
import { compareMissing } from './compare.js';
import { loadCategoryMap } from './category-map.js';
import { normalizePrice } from './pricing.js';
import { SHOPIFY_COLUMNS, transformProduct } from './transform.js';
import { validateSummary } from './validate.js';
import { rowsToCsv } from './csv.js';

const SUPPLIER_KEYS = Object.freeze(Object.keys(SUPPLIERS));
const feedCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_EXPORT_IDENTIFIERS = 500;

export function isSupportedSupplier(key) {
  return typeof key === 'string' && Object.hasOwn(SUPPLIERS, key);
}

export function assertSupportedSupplier(key) {
  if (!isSupportedSupplier(key)) {
    const error = new Error(`Unsupported supplier. Expected one of: ${SUPPLIER_KEYS.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
}

export function makeCategoryId(categoryName) {
  return Buffer.from(String(categoryName), 'utf8').toString('base64url');
}

export function normalizeCategory(raw) {
  const name = String(raw?.text || '').trim();
  return {
    id: makeCategoryId(name),
    name,
    productCount: Number(raw?.count) || 0,
    level: raw?.level == null ? '' : String(raw.level),
  };
}

export function normalizeCategories(categories) {
  return categories
    .map(normalizeCategory)
    .filter((category) => category.name)
    .sort((a, b) => {
      if (b.productCount !== a.productCount) return b.productCount - a.productCount;
      return a.name.localeCompare(b.name);
    });
}

export function resolveCategorySelection(categories, categoryId) {
  const selected = categories.find((category) => category.id === categoryId);
  if (!selected) {
    const error = new Error('Selected category is not available for this supplier.');
    error.statusCode = 400;
    throw error;
  }
  return selected;
}

async function readSupplierFeed(adapter) {
  const xmlPath = adapter.config.defaultXml;
  const stat = await fs.stat(xmlPath);
  const cached = feedCache.get(adapter.config.key);
  if (
    cached &&
    cached.xmlPath === xmlPath &&
    cached.mtimeMs === stat.mtimeMs &&
    Date.now() - cached.loadedAt < CACHE_TTL_MS
  ) {
    return cached;
  }

  const xmlText = await fs.readFile(xmlPath, 'utf8');
  const products = adapter.parseProducts(xmlText);
  const parsed = {
    xmlPath,
    mtimeMs: stat.mtimeMs,
    loadedAt: Date.now(),
    products,
    categories: normalizeCategories(adapter.listCategories(products)),
  };
  feedCache.set(adapter.config.key, parsed);
  return parsed;
}

export async function listLoadableSuppliers() {
  const rows = [];
  for (const key of SUPPLIER_KEYS) {
    const adapter = getSupplier(key);
    let available = false;
    try {
      await fs.access(adapter.config.defaultXml);
      available = true;
    } catch {
      available = false;
    }
    rows.push({
      key,
      name: adapter.config.name,
      vendor: adapter.config.vendor,
      available,
    });
  }
  return rows;
}

export async function listSupplierCategories(supplierKey) {
  assertSupportedSupplier(supplierKey);
  const adapter = getSupplier(supplierKey);
  const parsed = await readSupplierFeed(adapter);
  return {
    supplier: supplierKey,
    supplierName: adapter.config.name,
    categories: parsed.categories,
  };
}

function firstCategoryName(product, fallback) {
  return product.categories?.[product.categories.length - 1]?.text || fallback || '';
}

function productIdentifier(product) {
  return `${product.supplier}:${product.sku}`;
}

function validationState(validation) {
  if (!validation.ok) return 'blocked';
  if (validation.warnings.length) return 'warning';
  return 'valid';
}

function normalizeMissingRow(product, transformResult, validation, categoryName) {
  const firstRow = transformResult.rows[0] || {};
  return {
    id: productIdentifier(product),
    supplierSku: String(product.sku || ''),
    title: firstRow.Title || product.title || '',
    category: firstCategoryName(product, categoryName),
    supplierPrice: normalizePrice(product.wholesalePrice),
    shopifyPrice: transformResult.price || '',
    stock: product.stock == null ? '' : String(product.stock),
    availability: product.availability == null ? '' : String(product.availability),
    hasImages: Boolean(product.images?.length),
    imageCount: product.images?.length || 0,
    validationState: validationState(validation),
    importable: validation.ok,
    validationErrors: validation.errors,
    validationWarnings: validation.warnings,
    barcode: product.barcode == null ? '' : String(product.barcode),
    dimensions: product.dimensions || null,
    weightKg: product.weightKg == null ? '' : String(product.weightKg),
    typePreview: firstRow.Type || '',
    tagsPreview: firstRow.Tags ? String(firstRow.Tags).split(',').map((tag) => tag.trim()).filter(Boolean) : [],
    description: product.description || '',
    imageUrls: Array.isArray(product.images) ? product.images.filter(Boolean) : [],
  };
}

async function buildMissingContext({
  supplierKey,
  categoryId,
  createClient = createShopifyClient,
  parsedFeed = null,
  categoryMapOverride = null,
} = {}) {
  assertSupportedSupplier(supplierKey);
  if (!categoryId || typeof categoryId !== 'string') {
    const error = new Error('categoryId is required.');
    error.statusCode = 400;
    throw error;
  }

  const adapter = getSupplier(supplierKey);
  const parsed = parsedFeed || {
    products: [],
    categories: [],
    ...(await readSupplierFeed(adapter)),
  };
  const category = resolveCategorySelection(parsed.categories, categoryId);
  const selected = parsed.products.filter((product) => adapter.matchesCategory(product, category.name));
  const canonical = selected.map((product) => adapter.extractProduct(product));
  const client = createClient();
  const index = await fetchVariantIndex(client);
  const comparison = compareMissing(canonical, index, adapter);
  const categoryMap = categoryMapOverride || (await loadCategoryMap(adapter.config.categoryMapPath));

  return { adapter, category, index, comparison, categoryMap };
}

export async function scanMissingProducts({
  supplierKey,
  categoryId,
  createClient = createShopifyClient,
  parsedFeed = null,
  categoryMapOverride = null,
} = {}) {
  const started = Date.now();
  const warnings = [];
  const { adapter, category, index, comparison, categoryMap } = await buildMissingContext({
    supplierKey,
    categoryId,
    createClient,
    parsedFeed,
    categoryMapOverride,
  });

  if (!comparison.missing.length) {
    warnings.push('В избраната категория няма липсващи продукти.');
  }

  const missingProducts = comparison.missing.map((product) => {
    const transformed = transformProduct(product, {
      config: adapter.config,
      categoryMap,
      forcedCategory: category.name,
    });
    const summary = {
      sku: product.sku,
      title: transformed.rows[0]?.Title || product.title || '',
      type: transformed.rows[0]?.Type || '',
      price: transformed.price,
      images: product.images?.length || 0,
      mapped: transformed.mapped,
      warnings: transformed.warnings,
    };
    return normalizeMissingRow(product, transformed, validateSummary(summary), category.name);
  });

  return {
    supplier: supplierKey,
    supplierName: adapter.config.name,
    category: {
      id: category.id,
      name: category.name,
    },
    totals: {
      supplierProducts: comparison.counts.total,
      alreadyInShopify: comparison.counts.present,
      missing: comparison.counts.missing,
      invalid: comparison.counts.invalid,
      duplicateCodes: comparison.counts.duplicates,
      shopifyVariants: index.total || 0,
    },
    missingProducts,
    warnings,
    durationMs: Date.now() - started,
  };
}

function validateExportIdentifiers(productIds) {
  if (!Array.isArray(productIds)) {
    const error = new Error('productIds must be an array.');
    error.statusCode = 400;
    throw error;
  }
  if (!productIds.length) {
    const error = new Error('Select at least one product to export.');
    error.statusCode = 400;
    throw error;
  }
  if (productIds.length > MAX_EXPORT_IDENTIFIERS) {
    const error = new Error(`Too many selected products. Maximum is ${MAX_EXPORT_IDENTIFIERS}.`);
    error.statusCode = 400;
    throw error;
  }

  return Array.from(
    new Set(
      productIds
        .filter((id) => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  );
}

function safeFilenamePart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48);
}

export function buildExportFilename({ supplierKey, categoryName, date = new Date() }) {
  const day = date.toISOString().slice(0, 10);
  const category = safeFilenamePart(categoryName);
  return ['missing-products', supplierKey, category, day].filter(Boolean).join('-') + '.csv';
}

export async function exportMissingProductsCsv({
  supplierKey,
  categoryId,
  productIds,
  createClient = createShopifyClient,
  parsedFeed = null,
  categoryMapOverride = null,
  date = new Date(),
} = {}) {
  const requestedIds = validateExportIdentifiers(productIds);
  if (!requestedIds.length) {
    const error = new Error('Select at least one valid product to export.');
    error.statusCode = 400;
    throw error;
  }

  const started = Date.now();
  const { adapter, category, index, comparison, categoryMap } = await buildMissingContext({
    supplierKey,
    categoryId,
    createClient,
    parsedFeed,
    categoryMapOverride,
  });

  const requested = new Set(requestedIds);
  const duplicateSkuSet = new Set(comparison.duplicateSkus);
  const selectedMissing = comparison.missing.filter((product) => requested.has(productIdentifier(product)));
  const unknownIds = requestedIds.filter((id) => !selectedMissing.some((product) => productIdentifier(product) === id));

  const rows = [];
  const exportedProducts = [];
  const excluded = [];
  const seenSkus = new Set();

  for (const product of selectedMissing) {
    const id = productIdentifier(product);
    const sku = String(product.sku || '').trim();
    const transformed = transformProduct(product, {
      config: adapter.config,
      categoryMap,
      forcedCategory: category.name,
    });
    const firstRow = transformed.rows[0] || {};
    const summary = {
      sku: product.sku,
      title: firstRow.Title || product.title || '',
      type: firstRow.Type || '',
      price: transformed.price,
      images: product.images?.length || 0,
      mapped: transformed.mapped,
      warnings: transformed.warnings,
    };
    const validation = validateSummary(summary);
    const reasons = [];
    if (!validation.ok) reasons.push(...validation.errors);
    if (duplicateSkuSet.has(sku)) reasons.push('duplicate-supplier-sku');
    if (seenSkus.has(sku)) reasons.push('duplicate-selected-sku');

    if (reasons.length) {
      excluded.push({ id, sku, title: summary.title, reasons });
      continue;
    }

    seenSkus.add(sku);
    rows.push(...transformed.rows);
    exportedProducts.push({
      id,
      sku,
      title: summary.title,
      warnings: validation.warnings,
      imageCount: product.images?.length || 0,
      stock: product.stock == null ? '' : String(product.stock),
    });
  }

  for (const id of unknownIds) {
    excluded.push({ id, sku: '', title: '', reasons: ['not-missing-or-not-in-category'] });
  }

  if (!exportedProducts.length) {
    const error = new Error('No selected products are exportable.');
    error.statusCode = 400;
    error.details = { excluded };
    throw error;
  }

  const csv = rowsToCsv(rows, SHOPIFY_COLUMNS);
  const filename = buildExportFilename({ supplierKey, categoryName: category.name, date });
  const warningProducts = exportedProducts.filter((product) => product.warnings.length).length;
  const missingImages = exportedProducts.filter((product) => product.imageCount === 0).length;
  const zeroStock = exportedProducts.filter((product) => Number.parseFloat(String(product.stock).replace(',', '.')) <= 0).length;

  return {
    csv,
    filename,
    summary: {
      supplier: supplierKey,
      supplierName: adapter.config.name,
      category: { id: category.id, name: category.name },
      requested: requestedIds.length,
      selected: selectedMissing.length,
      exported: exportedProducts.length,
      excluded: excluded.length,
      warningProducts,
      blockedExcluded: excluded.filter((item) => item.reasons.some((reason) => ['missing-sku', 'missing-title', 'missing-price'].includes(reason))).length,
      duplicateExcluded: excluded.filter((item) => item.reasons.some((reason) => reason.includes('duplicate'))).length,
      missingImages,
      zeroStock,
      rows: rows.length,
      durationMs: Date.now() - started,
    },
    excluded,
  };
}
