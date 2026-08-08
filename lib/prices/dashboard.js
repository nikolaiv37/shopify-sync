/**
 * Prices module — server service layer (stateless, no database).
 *
 *   - previewPrices    : READ-ONLY. Reads the current feed + Shopify variants,
 *                        classifies every row. Never mutates.
 *   - applyPriceBatch  : writes ONE small browser-driven batch. The server is the
 *                        trusted authority — it re-reads the live variants, checks
 *                        SKU/vendor/feed membership, RECOMPUTES the target from the
 *                        current feed wholesale × canonical ×2.5 (never trusts the
 *                        client's numbers), enforces stale-price protection, then
 *                        writes only the actual selling `price`.
 *
 * The browser orchestrates the sequence of small batches and holds progress; if
 * the page reloads, re-running Preview shows what still needs changing. No
 * persistent jobs, no Supabase.
 */

import fs from 'node:fs/promises';
import { getSupplier } from '../suppliers/index.js';
import { createShopifyClient } from '../shopify/client.js';
import { fetchVariantIndex, fetchVariantsByIds } from '../shopify/variants.js';
import { getMultiplier, markupPercent, moneyString, parseShopifyMoney, round2, PriceOperation, CompareOperation, parseMultiplier, effectiveMultiplier } from '../pricing/pricing-config.js';
import { buildFeedIndex, classifyPrices } from './engine.js';
import { evaluateRow, rowStale, batchInputs, executeBatches } from './apply.js';

// A very high multiplier is allowed but flagged so the operator can double-check.
const HIGH_MULTIPLIER_WARN = 10;

/**
 * Validate the SELLING operation. The manual operation is per-run only; it never
 * touches the per-supplier DEFAULT (getMultiplier) used by Missing Products + CSV.
 * @returns {{ operation, selectedMultiplier: number|null, effective: number, warnings: string[] }}
 */
function resolveSellingOperation({ operation, multiplier }) {
  const op = operation || PriceOperation.MULTIPLIER;
  if (op !== PriceOperation.KEEP && op !== PriceOperation.SOURCE && op !== PriceOperation.MULTIPLIER) {
    const err = new Error('Невалидна операция за продажна цена.');
    err.statusCode = 400;
    throw err;
  }
  if (op === PriceOperation.KEEP) {
    return { operation: op, selectedMultiplier: null, effective: null, warnings: [] };
  }
  if (op === PriceOperation.SOURCE) {
    return { operation: op, selectedMultiplier: null, effective: 1, warnings: [] };
  }
  const parsed = parseMultiplier(multiplier);
  if (parsed == null) {
    const err = new Error('Коефициентът за продажна цена трябва да е положително число.');
    err.statusCode = 400;
    throw err;
  }
  const warnings = parsed >= HIGH_MULTIPLIER_WARN ? [`Необичайно висок коефициент за продажна цена (× ${parsed}).`] : [];
  return { operation: op, selectedMultiplier: parsed, effective: effectiveMultiplier(op, parsed), warnings };
}

/**
 * Validate the COMPARE-AT operation (Сравнителна цена). Defaults to KEEP so the
 * compare-at field is never touched unless the operator explicitly chooses to.
 * @returns {{ operation, selectedMultiplier: number|null, effective: number|null, warnings: string[] }}
 */
function resolveCompareOperation({ operation, multiplier }) {
  const op = operation || CompareOperation.KEEP;
  if (![CompareOperation.KEEP, CompareOperation.CLEAR, CompareOperation.SOURCE, CompareOperation.MULTIPLIER].includes(op)) {
    const err = new Error('Невалидна операция за сравнителна цена.');
    err.statusCode = 400;
    throw err;
  }
  if (op === CompareOperation.KEEP || op === CompareOperation.CLEAR) {
    return { operation: op, selectedMultiplier: null, effective: null, warnings: [] };
  }
  if (op === CompareOperation.SOURCE) {
    return { operation: op, selectedMultiplier: null, effective: 1, warnings: [] };
  }
  const parsed = parseMultiplier(multiplier);
  if (parsed == null) {
    const err = new Error('Коефициентът за сравнителна цена трябва да е положително число.');
    err.statusCode = 400;
    throw err;
  }
  const warnings = parsed >= HIGH_MULTIPLIER_WARN ? [`Необичайно висок коефициент за сравнителна цена (× ${parsed}).`] : [];
  return { operation: op, selectedMultiplier: parsed, effective: parsed, warnings };
}

// Suppliers whose LIVE price writes are enabled in this version.
const APPLY_ENABLED = new Set(['megapap']);

// Server-side write tuning (reused convention from the proven update-prices.js).
const BULK_CHUNK = 100; // variants per productVariantsBulkUpdate call
const CONCURRENCY = 3; // parallel product mutations per request
// Recommended browser batch size (variants per apply-batch request). Kept small
// so each server request stays short enough for Vercel.
export const APPLY_BATCH_SIZE = 50;
const MAX_BATCH_ITEMS = 200; // hard server cap per request

const SUPPLIER_META = {
  megapap: { skuField: 'model', sourceField: 'wholesale_price_without_vat' },
  b2bmarkt: { skuField: 'ProductCode', sourceField: 'ZoneFourUnitPrice' },
  symetron: { skuField: 'ProductCode', sourceField: 'ZoneFourUnitPrice' },
};

// Short-lived in-memory feed cache (per warm server instance) so an apply run of
// many batches doesn't re-parse the large feed each time. mtime + TTL guarded.
const FEED_TTL_MS = 5 * 60 * 1000;
const feedCache = new Map();

function assertPriceSupplier(supplierKey) {
  if (!APPLY_ENABLED.has(supplierKey)) {
    const err = new Error('Актуализирането на цени е активно само за MegaPap в тази версия.');
    err.statusCode = 400;
    throw err;
  }
}

export function getPriceSupplierInfo() {
  return Array.from(APPLY_ENABLED).map((key) => {
    const cfg = getSupplier(key).config;
    const defaultMultiplier = getMultiplier(key);
    return {
      key,
      name: cfg.name,
      vendor: cfg.vendor,
      skuField: SUPPLIER_META[key]?.skuField || null,
      sourceField: SUPPLIER_META[key]?.sourceField || null,
      // The per-supplier DEFAULT used by Missing Products + CSV (NOT the manual run).
      defaultMultiplier,
      defaultMarkupPercent: markupPercent(defaultMultiplier),
      applyEnabled: true,
      batchSize: APPLY_BATCH_SIZE,
    };
  });
}

// Feed cache holds the parsed wholesale index (operation-independent), so a run
// of many batches / different operations reuses one parse.
async function getFeed(adapter) {
  const xmlPath = adapter.config.defaultXml;
  const stat = await fs.stat(xmlPath);
  const cached = feedCache.get(adapter.config.key);
  if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.loadedAt < FEED_TTL_MS) {
    return cached;
  }
  const xmlText = await fs.readFile(xmlPath, 'utf8');
  const products = adapter.parseProducts(xmlText);
  const feedIndex = buildFeedIndex(adapter, products);
  const entry = {
    mtimeMs: stat.mtimeMs,
    loadedAt: Date.now(),
    feedIndex,
    feedSnapshotAt: new Date(stat.mtimeMs).toISOString(),
  };
  feedCache.set(adapter.config.key, entry);
  return entry;
}

/**
 * READ-ONLY price preview for a chosen operation.
 * @param {{ supplierKey, operation, multiplier, createClient }} args
 * @returns {{ supplier, operation, generatedAt, feedSnapshotAt, warnings, rows, summary }}
 */
export async function previewPrices({ supplierKey, selling, compare, createClient = createShopifyClient } = {}) {
  assertPriceSupplier(supplierKey);
  const adapter = getSupplier(supplierKey);
  const sell = resolveSellingOperation(selling || {});
  const cmp = resolveCompareOperation(compare || {});
  if (sell.operation === PriceOperation.KEEP && cmp.operation === CompareOperation.KEEP) {
    const err = new Error('Изберете операция за поне една от цените.');
    err.statusCode = 400;
    throw err;
  }

  const { feedIndex, feedSnapshotAt } = await getFeed(adapter);

  const client = createClient();
  const { bySku } = await fetchVariantIndex(client);

  const { rows, summary } = classifyPrices({
    feedIndex,
    shopifyBySku: bySku,
    supplierKey,
    sellingEffective: sell.effective,
    compareOperation: cmp.operation,
    compareMultiplier: cmp.selectedMultiplier,
    sellingMeta: { operation: sell.operation, multiplier: sell.selectedMultiplier, effectiveMultiplier: sell.effective, markupPercent: markupPercent(sell.effective) },
    compareMeta: { operation: cmp.operation, multiplier: cmp.selectedMultiplier, effectiveMultiplier: cmp.effective, markupPercent: cmp.effective == null ? null : markupPercent(cmp.effective) },
    vendor: adapter.config.vendor,
  });

  const sellingMarkup = sell.effective == null ? null : markupPercent(sell.effective);
  return {
    supplier: {
      key: supplierKey,
      name: adapter.config.name,
      vendor: adapter.config.vendor,
      defaultMultiplier: getMultiplier(supplierKey),
      defaultMarkupPercent: markupPercent(getMultiplier(supplierKey)),
      skuField: SUPPLIER_META[supplierKey]?.skuField || null,
      sourceField: SUPPLIER_META[supplierKey]?.sourceField || null,
      batchSize: APPLY_BATCH_SIZE,
    },
    selling: { type: sell.operation, multiplier: sell.selectedMultiplier, effectiveMultiplier: sell.effective, markupPercent: sellingMarkup },
    compare: { type: cmp.operation, multiplier: cmp.selectedMultiplier, effectiveMultiplier: cmp.effective, markupPercent: cmp.effective == null ? null : markupPercent(cmp.effective) },
    generatedAt: new Date().toISOString(),
    feedSnapshotAt,
    warnings: [...sell.warnings, ...cmp.warnings],
    rows,
    summary,
  };
}

function money(n) {
  return n == null ? null : Number(moneyString(n));
}

/**
 * Apply ONE small batch, managing selling price and/or compare-at price. The
 * client sends [{ variantId, sku, oldSellingPrice, oldCompareAtPrice }]. The
 * server re-reads the live variants, recomputes BOTH targets from the current
 * feed wholesale, enforces field-specific stale protection, and writes only the
 * intended fields.
 *
 * @returns {{ results: Array, feedSnapshotAt: string }}
 *   result item: { sku, variantId, status, sellingChanged, compareChanged,
 *     oldSellingPrice, newSellingPrice, oldCompareAtPrice, newCompareAtPrice,
 *     wholesale, error?, reason? }
 *   status ∈ success | skipped_stale | conflict | failed | already
 */
export async function applyPriceBatch({ supplierKey, selling, compare, items, createClient = createShopifyClient } = {}) {
  assertPriceSupplier(supplierKey);
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('Няма продукти в тази партида.');
    err.statusCode = 400;
    throw err;
  }
  if (items.length > MAX_BATCH_ITEMS) {
    const err = new Error(`Партидата е твърде голяма (максимум ${MAX_BATCH_ITEMS}).`);
    err.statusCode = 400;
    throw err;
  }

  const adapter = getSupplier(supplierKey);
  const expectedVendor = adapter.config.vendor;
  // Server-authoritative operations: never trusts client target/multiplier math.
  const sell = resolveSellingOperation(selling || {});
  const cmp = resolveCompareOperation(compare || {});
  if (sell.operation === PriceOperation.KEEP && cmp.operation === CompareOperation.KEEP) {
    const err = new Error('Изберете операция за поне една от цените.');
    err.statusCode = 400;
    throw err;
  }
  const { feedIndex, feedSnapshotAt } = await getFeed(adapter);

  const requested = items
    .filter((it) => it && typeof it.variantId === 'string')
    .map((it) => ({
      variantId: it.variantId,
      sku: String(it.sku || '').trim(),
      oldSellingPrice: parseShopifyMoney(it.oldSellingPrice),
      oldCompareAtPrice: parseShopifyMoney(it.oldCompareAtPrice),
    }));

  const client = createClient();
  const live = await fetchVariantsByIds(client, requested.map((r) => r.variantId));

  const results = [];
  const writes = [];

  for (const req of requested) {
    const node = live.get(req.variantId);
    const base = { sku: req.sku, variantId: req.variantId };
    const verdict = evaluateRow({
      node,
      requestedSku: req.sku,
      feedEntry: feedIndex.bySku.get(node?.sku),
      isFeedDuplicate: node?.sku ? feedIndex.duplicateSkus.has(node.sku) : false,
      expectedVendor,
      sellingEffective: sell.effective,
      compareOperation: cmp.operation,
      compareMultiplier: cmp.selectedMultiplier,
    });

    if (verdict.status === 'conflict' || verdict.status === 'invalid') {
      results.push({ ...base, status: 'conflict', reason: verdict.reason });
      continue;
    }
    if (verdict.status === 'already') {
      results.push({ ...base, status: 'already', oldSellingPrice: verdict.liveSelling, newSellingPrice: verdict.sellingChanged ? verdict.targetSelling : verdict.liveSelling, oldCompareAtPrice: verdict.liveCompare, wholesale: verdict.wholesale });
      continue;
    }

    // Field-specific stale protection.
    const stale = rowStale(verdict, req.oldSellingPrice, req.oldCompareAtPrice);
    if (stale.stale) {
      results.push({ ...base, status: 'skipped_stale', reason: stale.reason, oldSellingPrice: req.oldSellingPrice, oldCompareAtPrice: req.oldCompareAtPrice, wholesale: verdict.wholesale });
      continue;
    }

    const newCompare = verdict.compareChanged ? (verdict.compareMode === 'clear' ? null : verdict.targetCompare) : verdict.liveCompare;
    writes.push({
      variantId: req.variantId,
      productId: verdict.productId,
      sku: req.sku,
      wholesale: verdict.wholesale,
      sellingChanged: verdict.sellingChanged,
      targetSelling: verdict.targetSelling,
      compareChanged: verdict.compareChanged,
      compareMode: verdict.compareMode,
      targetCompare: verdict.targetCompare,
      oldSellingPrice: req.oldSellingPrice,
      oldCompareAtPrice: req.oldCompareAtPrice,
      newSellingPrice: verdict.sellingChanged ? verdict.targetSelling : verdict.liveSelling,
      newCompareAtPrice: newCompare,
    });
  }

  const buildInput = (w) => {
    const input = { id: w.variantId, sku: w.sku };
    if (w.sellingChanged) input.price = moneyString(w.targetSelling);
    if (w.compareChanged) input.compareAtPrice = w.compareMode === 'clear' ? null : moneyString(w.targetCompare);
    return input;
  };
  const jobs = batchInputs(writes, BULK_CHUNK, buildInput);
  const { success, failed } = await executeBatches(client, jobs, { concurrency: CONCURRENCY });

  const byVariant = new Map(writes.map((w) => [w.variantId, w]));
  for (const s of success) {
    const w = byVariant.get(s.variantId);
    results.push({
      sku: s.sku,
      variantId: s.variantId,
      status: 'success',
      sellingChanged: w?.sellingChanged ?? false,
      compareChanged: w?.compareChanged ?? false,
      oldSellingPrice: money(w?.oldSellingPrice),
      newSellingPrice: money(w?.newSellingPrice),
      oldCompareAtPrice: money(w?.oldCompareAtPrice),
      newCompareAtPrice: money(w?.newCompareAtPrice),
      wholesale: money(w?.wholesale),
    });
  }
  for (const f of failed) {
    const w = byVariant.get(f.variantId);
    results.push({
      sku: f.sku,
      variantId: f.variantId,
      status: 'failed',
      error: f.error,
      sellingChanged: w?.sellingChanged ?? false,
      compareChanged: w?.compareChanged ?? false,
      oldSellingPrice: money(w?.oldSellingPrice),
      newSellingPrice: money(w?.newSellingPrice),
      oldCompareAtPrice: money(w?.oldCompareAtPrice),
      newCompareAtPrice: money(w?.newCompareAtPrice),
      wholesale: money(w?.wholesale),
    });
  }

  return { results, feedSnapshotAt };
}

/**
 * Restore BOTH fields within the SAME session using captured successful results.
 * Input: [{ variantId, sku, oldSellingPrice, newSellingPrice, oldCompareAtPrice,
 * newCompareAtPrice, sellingChanged, compareChanged }].
 * A field is restored only if its live value still equals what this operation
 * wrote; otherwise the row is skipped to protect later manual edits.
 */
export async function rollbackPriceBatch({ supplierKey, items, createClient = createShopifyClient } = {}) {
  assertPriceSupplier(supplierKey);
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('Няма продукти за възстановяване.');
    err.statusCode = 400;
    throw err;
  }
  if (items.length > MAX_BATCH_ITEMS) {
    const err = new Error(`Партидата е твърде голяма (максимум ${MAX_BATCH_ITEMS}).`);
    err.statusCode = 400;
    throw err;
  }

  const requested = items
    .filter((it) => it && typeof it.variantId === 'string')
    .map((it) => ({
      variantId: it.variantId,
      sku: String(it.sku || '').trim(),
      oldSellingPrice: parseShopifyMoney(it.oldSellingPrice),
      newSellingPrice: parseShopifyMoney(it.newSellingPrice),
      oldCompareAtPrice: parseShopifyMoney(it.oldCompareAtPrice),
      newCompareAtPrice: parseShopifyMoney(it.newCompareAtPrice),
      sellingChanged: Boolean(it.sellingChanged),
      compareChanged: Boolean(it.compareChanged),
    }));

  const client = createClient();
  const live = await fetchVariantsByIds(client, requested.map((r) => r.variantId));

  const eq = (a, b) => (a == null && b == null ? true : a == null || b == null ? false : round2(a) === round2(b));
  const results = [];
  const writes = [];
  for (const req of requested) {
    const node = live.get(req.variantId);
    const base = { sku: req.sku, variantId: req.variantId };
    if (!node || node.sku !== req.sku) {
      results.push({ ...base, status: 'conflict', reason: 'variant-missing-or-mismatch' });
      continue;
    }
    const liveSelling = parseShopifyMoney(node.currentPrice);
    const liveCompare = parseShopifyMoney(node.currentCompareAt);
    // Only restore a field if its live value is still what this job wrote.
    const sellingStale = req.sellingChanged && !eq(liveSelling, req.newSellingPrice);
    const compareStale = req.compareChanged && !eq(liveCompare, req.newCompareAtPrice);
    if (sellingStale || compareStale) {
      results.push({ ...base, status: 'skipped_stale', reason: 'changed-after-job' });
      continue;
    }
    writes.push({
      variantId: node.variantId,
      productId: node.productId,
      sku: node.sku,
      sellingChanged: req.sellingChanged,
      compareChanged: req.compareChanged,
      restoreSelling: req.oldSellingPrice,
      restoreCompare: req.oldCompareAtPrice,
      priorSelling: req.newSellingPrice,
      priorCompare: req.newCompareAtPrice,
    });
  }

  const buildInput = (w) => {
    const input = { id: w.variantId, sku: w.sku };
    if (w.sellingChanged) input.price = moneyString(w.restoreSelling);
    if (w.compareChanged) input.compareAtPrice = w.restoreCompare == null ? null : moneyString(w.restoreCompare);
    return input;
  };
  const jobs = batchInputs(writes, BULK_CHUNK, buildInput);
  const { success, failed } = await executeBatches(client, jobs, { concurrency: CONCURRENCY });
  const byVariant = new Map(writes.map((w) => [w.variantId, w]));
  for (const s of success) {
    const w = byVariant.get(s.variantId);
    results.push({ sku: s.sku, variantId: s.variantId, status: 'success', oldSellingPrice: money(w?.priorSelling), newSellingPrice: money(w?.restoreSelling), oldCompareAtPrice: money(w?.priorCompare), newCompareAtPrice: money(w?.restoreCompare) });
  }
  for (const f of failed) {
    results.push({ sku: f.sku, variantId: f.variantId, status: 'failed', error: f.error });
  }
  return { results };
}
