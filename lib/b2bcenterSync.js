/**
 * B2BCenter (Supabase) inventory sync engine — DRY-RUN ONLY (Phase 1 + 2).
 *
 * This engine is a separate sibling of lib/inventorySync.js (the Shopify engine).
 * It does NOT import Shopify-specific code and it NEVER writes to Supabase.
 *
 * Scope (v1): stock/quantity only, SKU-matched, tenant-scoped, manufacturer-scoped.
 * Apply/write mode is intentionally not implemented in this phase.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { createClient } from '@supabase/supabase-js';

const PAGE_SIZE = 1000;

const SUPPLIERS = {
  megapap: {
    key: 'megapap',
    manufacturer: 'Mebelcenter',
    feedEnvVar: 'MEGAPAP_FEED_URL',
    productTag: 'product',
    skuTag: 'model',
    stockTag: 'quantity',
  },
  b2bmarkt: {
    key: 'b2bmarkt',
    manufacturer: 'Europe',
    feedEnvVar: 'B2BMARKT_MAIN_URL',
    productTag: 'Product',
    skuTag: 'ProductCode',
    stockTag: 'Stock',
  },
};

const PRODUCT_COLUMNS = 'id,sku,quantity,manufacturer,tenant_id,is_visible,updated_at';

function nowIso() {
  return new Date().toISOString();
}

function createLogger(onLog) {
  return {
    info(line) {
      const output = `[${nowIso()}] ${line}`;
      if (onLog) onLog(output);
      else console.log(output);
    },
    raw(line) {
      if (onLog) onLog(line);
      else console.log(line);
    },
    warn(line) {
      if (onLog) onLog(line);
      else console.warn(line);
    },
    error(line) {
      if (onLog) onLog(line);
      else console.error(line);
    },
  };
}

function getRuntimeLogDir() {
  return process.env.LOG_DIR || './logs';
}

// --- Generic XML helpers (self-contained; not imported from inventorySync.js) ---

function extractText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return extractText(val[0]);
  if (typeof val === 'object') {
    return extractText(val['#text'] ?? val.__cdata ?? '');
  }
  return String(val).trim();
}

function findProductArray(node, productTag) {
  if (!node || typeof node !== 'object') return null;
  for (const key of Object.keys(node)) {
    if (key === productTag) {
      const v = node[key];
      return Array.isArray(v) ? v : [v];
    }
    const found = findProductArray(node[key], productTag);
    if (found) return found;
  }
  return null;
}

async function fetchXml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'mebelcenter-b2bcenter-sync/1.0' },
  });
  if (!res.ok) throw new Error(`XML fetch ${res.status} ${res.statusText} (${url})`);
  return res.text();
}

function parseSupplierFeed(xmlText, { productTag, skuTag, stockTag }) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, productTag);
  if (!products) throw new Error(`Could not find <${productTag}> elements in XML`);

  const map = new Map();
  let dupes = 0;
  let blanks = 0;
  for (const p of products) {
    const sku = extractText(p?.[skuTag]);
    if (!sku) {
      blanks++;
      continue;
    }
    const rawStock = extractText(p?.[stockTag]);
    const stock = Number.parseInt(rawStock, 10);
    const qty = Number.isFinite(stock) ? stock : 0;
    if (map.has(sku)) dupes++;
    map.set(sku, qty);
  }
  return { map, rawCount: products.length, uniqueSkus: map.size, dupes, blanks };
}

// --- Supabase product read (read-only, paginated) ------------------------

async function readPortalProducts({ supabase, tenantId, manufacturer }, logger) {
  const products = [];
  let page = 0;
  for (;;) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('manufacturer', manufacturer)
      .order('id', { ascending: true })
      .range(from, to);
    if (error) {
      throw new Error(`Supabase read failed on page ${page + 1}: ${error.message}`);
    }
    products.push(...data);
    logger.info(
      `  products page ${page + 1}: rows ${from}-${from + data.length - 1} (${data.length})`,
    );
    if (data.length < PAGE_SIZE) break;
    page++;
  }
  logger.info(`  total portal products scanned: ${products.length}`);
  return products;
}

// --- Per-supplier dry run ------------------------------------------------

async function runSupplierDryRun(supplierKey, { supabase, tenantId, logger }) {
  const supplier = SUPPLIERS[supplierKey];
  if (!supplier) throw new Error(`Unknown B2BCenter supplier key: ${supplierKey}`);

  const feedUrl = process.env[supplier.feedEnvVar];
  if (!feedUrl) {
    throw new Error(`Missing ${supplier.feedEnvVar} in env for supplier "${supplierKey}"`);
  }

  const startedAt = new Date();
  const runId = `b2bcenter-${supplier.key}-DRYRUN-${startedAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19)}`;

  logger.info(
    `=== B2BCenter ${supplier.key} (manufacturer="${supplier.manufacturer}")  [DRY RUN] ===`,
  );

  logger.info('Step 1/4  Fetching supplier XML feed…');
  const xmlText = await fetchXml(feedUrl);
  logger.info(`  received ${(xmlText.length / 1024 / 1024).toFixed(2)} MB`);

  logger.info('Step 2/4  Parsing XML feed…');
  const feed = parseSupplierFeed(xmlText, supplier);
  logger.info(
    `  parsed ${feed.rawCount} <${supplier.productTag}> entries → ${feed.uniqueSkus} unique SKUs ` +
      `(dupes collapsed: ${feed.dupes}, blank SKUs skipped: ${feed.blanks})`,
  );

  logger.info('Step 3/4  Reading B2BCenter products from Supabase (tenant + manufacturer scoped)…');
  const portalProducts = await readPortalProducts(
    { supabase, tenantId, manufacturer: supplier.manufacturer },
    logger,
  );

  logger.info('Step 4/4  Building dry-run plan…');
  const portalSkus = new Set();
  const plan = [];
  let activeProducts = 0;
  let archivedProducts = 0;
  let archivedSkipped = 0;
  let notInFeed = 0;
  let unchanged = 0;
  const notInFeedSamples = [];

  for (const p of portalProducts) {
    const sku = (p.sku || '').trim();
    if (sku) portalSkus.add(sku);

    if (p.is_visible === false) {
      archivedProducts++;
      archivedSkipped++;
      continue;
    }
    activeProducts++;

    const feedQty = sku ? feed.map.get(sku) : undefined;
    if (feedQty === undefined) {
      notInFeed++;
      if (notInFeedSamples.length < 20) {
        notInFeedSamples.push({ id: p.id, sku, currentQuantity: p.quantity });
      }
      continue;
    }
    if (p.quantity === feedQty) {
      unchanged++;
      continue;
    }
    plan.push({
      id: p.id,
      sku,
      manufacturer: p.manufacturer,
      currentQuantity: p.quantity,
      newQuantity: feedQty,
      delta: feedQty - (p.quantity ?? 0),
      isVisible: p.is_visible,
      updatedAt: p.updated_at,
    });
  }

  // Feed SKUs that have no matching portal product.
  let notInPortal = 0;
  const notInPortalSamples = [];
  for (const feedSku of feed.map.keys()) {
    if (!portalSkus.has(feedSku)) {
      notInPortal++;
      if (notInPortalSamples.length < 20) notInPortalSamples.push(feedSku);
    }
  }

  const skippedTotal = notInFeed + unchanged + archivedSkipped;
  logger.info(
    `  portal products: ${portalProducts.length} (active ${activeProducts}, archived ${archivedProducts}) | ` +
      `planned: ${plan.length} | unchanged: ${unchanged} | notInFeed: ${notInFeed} | ` +
      `archivedSkipped: ${archivedSkipped} | notInPortal: ${notInPortal}`,
  );

  const preview = plan.slice(0, 20);
  if (preview.length) {
    logger.raw('Plan preview (first 20 rows):');
    for (const r of preview) {
      logger.raw(
        `  ${String(r.sku).padEnd(16)} ${String(r.currentQuantity).padStart(7)} -> ` +
          `${String(r.newQuantity).padStart(7)}  (${r.delta >= 0 ? '+' : ''}${r.delta})`,
      );
    }
  }

  const finishedAt = new Date();
  const logDir = getRuntimeLogDir();
  await fs.mkdir(logDir, { recursive: true });
  const jsonPath = path.join(logDir, `${runId}.json`);
  const textPath = path.join(logDir, `${runId}.log`);

  const summary = {
    target: 'b2bcenter',
    supplier: supplier.key,
    manufacturer: supplier.manufacturer,
    dryRun: true,
    tenantId,
    feedUrl,
    date: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedSeconds: Number(((finishedAt - startedAt) / 1000).toFixed(1)),
    logFiles: { json: jsonPath, text: textPath },
    counts: {
      feedRows: feed.rawCount,
      feedSkus: feed.uniqueSkus,
      feedDuplicates: feed.dupes,
      feedBlankSkus: feed.blanks,
      portalProducts: portalProducts.length,
      activeProducts,
      archivedProducts,
      planned: plan.length,
      unchanged,
      notInFeed,
      notInPortal,
      archivedSkipped,
      updated: 0,
      errors: 0,
      skipped: {
        notInFeed,
        unchanged,
        archivedSkipped,
        total: skippedTotal,
      },
    },
    preview: preview.map((r) => ({
      sku: r.sku,
      currentQuantity: r.currentQuantity,
      newQuantity: r.newQuantity,
      delta: r.delta,
    })),
    samples: {
      notInFeed: notInFeedSamples,
      notInPortal: notInPortalSamples,
    },
  };

  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));
  await fs.writeFile(
    textPath,
    [
      'B2BCenter inventory sync — DRY RUN ONLY (no DB writes)',
      '',
      `Date:            ${summary.date}`,
      `Supplier:        ${summary.supplier}`,
      `Manufacturer:    ${summary.manufacturer}`,
      `Tenant:          ${summary.tenantId}`,
      `Feed:            ${summary.feedUrl}`,
      `Elapsed:         ${summary.elapsedSeconds}s`,
      '',
      `Feed rows:       ${summary.counts.feedRows}`,
      `Feed SKUs:       ${summary.counts.feedSkus} (dupes ${summary.counts.feedDuplicates}, blank ${summary.counts.feedBlankSkus})`,
      `Portal products: ${summary.counts.portalProducts} (active ${summary.counts.activeProducts}, archived ${summary.counts.archivedProducts})`,
      `Planned:         ${summary.counts.planned}`,
      `Unchanged:       ${summary.counts.unchanged}`,
      `Not in feed:     ${summary.counts.notInFeed}`,
      `Not in portal:   ${summary.counts.notInPortal}`,
      `Archived skipped:${summary.counts.archivedSkipped}`,
      `Updated:         ${summary.counts.updated}  (dry run — always 0)`,
      `Errors:          ${summary.counts.errors}`,
      '',
      'First 20 planned changes (sku: current -> new):',
      ...(preview.length
        ? preview.map(
            (r) =>
              `  ${String(r.sku).padEnd(16)} ${r.currentQuantity} -> ${r.newQuantity} (${r.delta >= 0 ? '+' : ''}${r.delta})`,
          )
        : ['  (none)']),
      '',
      '*** DRY RUN ONLY — no Supabase writes were performed. ***',
    ].join('\n'),
  );

  logger.info(`  JSON log: ${jsonPath}`);
  logger.info(`  Text log: ${textPath}`);
  logger.info(
    `  Result → planned=${plan.length}, updated=0, errors=0, skipped=${skippedTotal} (DRY RUN)`,
  );

  return summary;
}

// --- Public entry --------------------------------------------------------

export async function runB2BCenterSync({ supplierKey = 'all', dryRun = true, onLog } = {}) {
  const logger = createLogger(onLog);

  if (dryRun !== true) {
    throw new Error('B2BCenter apply mode is not implemented yet. Run dry-run only.');
  }

  const {
    B2BCENTER_SUPABASE_URL,
    B2BCENTER_SUPABASE_SERVICE_ROLE_KEY,
    B2BCENTER_TENANT_ID,
  } = process.env;

  const missing = [];
  if (!B2BCENTER_SUPABASE_URL) missing.push('B2BCENTER_SUPABASE_URL');
  if (!B2BCENTER_SUPABASE_SERVICE_ROLE_KEY) missing.push('B2BCENTER_SUPABASE_SERVICE_ROLE_KEY');
  if (!B2BCENTER_TENANT_ID) missing.push('B2BCENTER_TENANT_ID');
  if (missing.length) {
    const error = new Error(`Missing required env var(s): ${missing.join(', ')}`);
    error.exitCode = 1;
    throw error;
  }

  const normalizedKey = (supplierKey || 'all').toLowerCase();
  const targets =
    normalizedKey === 'all'
      ? Object.keys(SUPPLIERS)
      : normalizedKey in SUPPLIERS
        ? [normalizedKey]
        : null;
  if (!targets) {
    const error = new Error(
      `Unknown supplier "${normalizedKey}". Valid: ${Object.keys(SUPPLIERS).join(', ')}, all`,
    );
    error.exitCode = 2;
    throw error;
  }

  const supabase = createClient(B2BCENTER_SUPABASE_URL, B2BCENTER_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  logger.info('B2BCenter dry-run mode: no Supabase writes will be performed.');

  const results = [];
  for (const target of targets) {
    try {
      results.push(
        await runSupplierDryRun(target, {
          supabase,
          tenantId: B2BCENTER_TENANT_ID,
          logger,
        }),
      );
    } catch (e) {
      logger.error(`[${target}] FATAL: ${e.stack || e.message}`);
      results.push({ supplier: target, error: String(e.message) });
    }
  }

  return {
    supplierKey: normalizedKey,
    dryRun: true,
    results,
    hasErrors: results.some((r) => r.error || (r.counts && r.counts.errors > 0)),
  };
}
