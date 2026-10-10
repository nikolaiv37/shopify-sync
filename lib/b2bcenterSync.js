/**
 * B2BCenter (Supabase) inventory sync engine.
 *
 * Modes:
 *   - dry-run (default)  → builds a plan, writes a report, performs NO writes.
 *   - apply (guarded)    → CLI-only. Updates products.quantity ONLY, per-row,
 *                          behind a snapshot guard. Requires confirm = true.
 *
 * This engine is a separate sibling of lib/inventorySync.js (the Shopify engine).
 * It does NOT import Shopify-specific code.
 *
 * Apply scope (v1): updates `products.quantity` ONLY. Never price, category,
 * name, description, image, manufacturer, sku, tenant_id, is_visible, or any
 * other column. No product creation. No auto-archive.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { getSupplier } from './suppliers/index.js';
import { normalizeRecords, fingerprint } from './inventory/feeds.js';
import { signPreview, verifyPreview } from './inventory/authorization.js';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const PAGE_SIZE = 1000;
const DEFAULT_MAX_CHANGE_PCT = 40;

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

async function fetchXml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'mebelcenter-b2bcenter-sync/2.0' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Supplier feed HTTP ${res.status}`);
  return res.text();
}

export function parsePortalFeed(xmlText, supplierKey) {
  if (XMLValidator.validate(xmlText) !== true) throw new Error('Invalid supplier XML');
  const records = normalizeRecords(supplierKey, getSupplier(supplierKey).parseProducts(xmlText));
  const map = new Map(); const seen = new Set(); const duplicateIds = new Set(); let blanks = 0; let invalid = 0;
  for (const row of records) {
    if (!row.supplierProductId) { blanks++; continue; }
    if (seen.has(row.supplierProductId)) duplicateIds.add(row.supplierProductId);
    seen.add(row.supplierProductId);
    if (row.quantityError) { invalid++; continue; }
    map.set(row.supplierProductId, row.quantity);
  }
  for (const id of duplicateIds) map.delete(id);
  return { map, records, fingerprint: fingerprint(records), rawCount: records.length, uniqueSkus: map.size, dupes: duplicateIds.size, blanks, invalid };
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

// --- Plan builder (shared by dry-run and apply) --------------------------

export async function buildSupplierPlan(supplier, { supabase, tenantId, logger, totalSteps }) {
  logger.info(`Step 1/${totalSteps}  Fetching supplier XML feed…`);
  const feedUrl = process.env[supplier.feedEnvVar];
  if (!feedUrl) {
    throw new Error(`Missing ${supplier.feedEnvVar} in env for supplier "${supplier.key}"`);
  }
  const xmlText = await fetchXml(feedUrl);
  logger.info(`  received ${(xmlText.length / 1024 / 1024).toFixed(2)} MB`);

  logger.info(`Step 2/${totalSteps}  Parsing XML feed…`);
  const feed = parsePortalFeed(xmlText, supplier.key);
  logger.info(
    `  parsed ${feed.rawCount} <${supplier.productTag}> entries → ${feed.uniqueSkus} unique SKUs ` +
      `(dupes collapsed: ${feed.dupes}, blank SKUs skipped: ${feed.blanks})`,
  );

  logger.info(
    `Step 3/${totalSteps}  Reading B2BCenter products from Supabase (tenant + manufacturer scoped)…`,
  );
  const portalProducts = await readPortalProducts(
    { supabase, tenantId, manufacturer: supplier.manufacturer },
    logger,
  );

  logger.info(`Step 4/${totalSteps}  Building plan…`);
  const portalSkus = new Set();
  const plan = [];
  let activeProducts = 0;
  let archivedProducts = 0;
  let archivedSkipped = 0;
  let notInFeed = 0;
  let unchanged = 0;
  const notInFeedSamples = [];

  const skuCounts = new Map();
  for (const p of portalProducts) { const sku = (p.sku || '').trim(); if (sku) skuCounts.set(sku, (skuCounts.get(sku) || 0) + 1); }
  for (const p of portalProducts) {
    const sku = (p.sku || '').trim();
    if (sku) portalSkus.add(sku);

    if (p.is_visible === false) {
      archivedProducts++;
      archivedSkipped++;
      continue;
    }
    activeProducts++;

    const feedQty = sku && skuCounts.get(sku) === 1 ? feed.map.get(sku) : undefined;
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

  let notInPortal = 0;
  const notInPortalSamples = [];
  for (const feedSku of feed.map.keys()) {
    if (!portalSkus.has(feedSku)) {
      notInPortal++;
      if (notInPortalSamples.length < 20) notInPortalSamples.push(feedSku);
    }
  }

  logger.info(
    `  portal products: ${portalProducts.length} (active ${activeProducts}, archived ${archivedProducts}) | ` +
      `planned: ${plan.length} | unchanged: ${unchanged} | notInFeed: ${notInFeed} | ` +
      `archivedSkipped: ${archivedSkipped} | notInPortal: ${notInPortal}`,
  );

  return {
    feedUrl,
    feed,
    portalProducts,
    plan,
    activeProducts,
    archivedProducts,
    archivedSkipped,
    notInFeed,
    notInPortal,
    unchanged,
    notInFeedSamples,
    notInPortalSamples,
  };
}

// --- Guarded apply -------------------------------------------------------

export async function applyGuardedUpdates({ supabase, tenantId, plan }, logger) {
  let updated = 0;
  let conflictSkipped = 0;
  let errors = 0;
  const appliedPreview = [];
  const conflictPreview = [];
  const errorDetail = [];

  for (let i = 0; i < plan.length; i++) {
    const row = plan[i];
    // Snapshot guard: the update applies ONLY if id + tenant + manufacturer +
    // the observed quantity + is_visible=true all still match. A concurrent
    // change makes the WHERE clause miss → 0 rows → counted as a conflict.
    const { data, error } = await supabase
      .from('products')
      .update({ quantity: row.newQuantity })
      .eq('id', row.id)
      .eq('tenant_id', tenantId)
      .eq('manufacturer', row.manufacturer)
      .eq('sku', row.sku)
      .eq('updated_at', row.updatedAt)
      .eq('quantity', row.currentQuantity)
      .eq('is_visible', true)
      .select('id,sku,quantity');

    if (error) {
      errors++;
      if (errorDetail.length < 50) {
        errorDetail.push({ id: row.id, sku: row.sku, error: String(error.message).slice(0, 400) });
      }
    } else if (data && data.length === 1) {
      updated++;
      if (appliedPreview.length < 20) {
        appliedPreview.push({
          sku: row.sku,
          currentQuantity: row.currentQuantity,
          newQuantity: row.newQuantity,
          delta: row.delta,
        });
      }
    } else {
      conflictSkipped++;
      if (conflictPreview.length < 20) {
        conflictPreview.push({
          id: row.id,
          sku: row.sku,
          expectedQuantity: row.currentQuantity,
          plannedQuantity: row.newQuantity,
        });
      }
    }

    const processed = i + 1;
    if (processed % 100 === 0 || processed === plan.length) {
      logger.info(
        `  apply progress: ${processed}/${plan.length} processed | ` +
          `updated=${updated} | conflicts=${conflictSkipped} | errors=${errors}`,
      );
    }
  }

  return { updated, conflictSkipped, errors, appliedPreview, conflictPreview, errorDetail };
}

// --- Per-supplier run ----------------------------------------------------

async function runSupplier(
  supplierKey,
  { supabase, tenantId, mode, confirm, allowLargeApply, maxChangePct, logger, previewToken },
) {
  const supplier = SUPPLIERS[supplierKey];
  if (!supplier) throw new Error(`Unknown B2BCenter supplier key: ${supplierKey}`);

  const isApply = mode === 'apply';
  const totalSteps = isApply ? 6 : 4;
  const startedAt = new Date();
  const runId = `b2bcenter-${supplier.key}-${isApply ? 'APPLY' : 'DRYRUN'}-${startedAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19)}`;

  logger.info(
    `=== B2BCenter ${supplier.key} (manufacturer="${supplier.manufacturer}")  ` +
      `[${isApply ? 'APPLY' : 'DRY RUN'}] ===`,
  );

  const built = await buildSupplierPlan(supplier, { supabase, tenantId, logger, totalSteps });
  const {
    feedUrl,
    feed,
    portalProducts,
    plan,
    activeProducts,
    archivedProducts,
    archivedSkipped,
    notInFeed,
    notInPortal,
    unchanged,
    notInFeedSamples,
    notInPortalSamples,
  } = built;

  const plannedChangePct =
    activeProducts > 0 ? Number(((plan.length / activeProducts) * 100).toFixed(1)) : 0;

  const preview = plan.slice(0, 20).map((r) => ({
    sku: r.sku,
    currentQuantity: r.currentQuantity,
    newQuantity: r.newQuantity,
    delta: r.delta,
  }));
  if (preview.length) {
    logger.raw('Plan preview (first 20 rows):');
    for (const r of preview) {
      logger.raw(
        `  ${String(r.sku).padEnd(16)} ${String(r.currentQuantity).padStart(7)} -> ` +
          `${String(r.newQuantity).padStart(7)}  (${r.delta >= 0 ? '+' : ''}${r.delta})`,
      );
    }
  }

  const authorization = { kind: 'portal-inventory', target: 'b2bcenter', supplier: supplier.key, tenantId, manufacturer: supplier.manufacturer, feedHash: feed.fingerprint, planHash: fingerprint(plan), threshold: maxChangePct };
  if (isApply) verifyPreview(previewToken, authorization);
  const signedPreview = isApply ? null : signPreview(authorization);

  // Apply-mode safety + write -------------------------------------------
  let thresholdBlocked = false;
  let applyResult = {
    updated: 0,
    conflictSkipped: 0,
    errors: 0,
    appliedPreview: [],
    conflictPreview: [],
    errorDetail: [],
  };

  if (isApply) {
    logger.info(`Step 5/${totalSteps}  Safety checks…`);
    logger.info(
      `  planned change: ${plan.length}/${activeProducts} active = ${plannedChangePct}% ` +
        `(threshold ${maxChangePct}%)`,
    );
    if (plannedChangePct > maxChangePct && !allowLargeApply) {
      thresholdBlocked = true;
      logger.error(
        `  BLOCKED: plannedChangePct ${plannedChangePct}% exceeds maxChangePct ${maxChangePct}%. ` +
          `Re-run with --allow-large-apply to override. No writes performed.`,
      );
    }

    if (thresholdBlocked) {
      logger.info(`Step 6/${totalSteps}  SKIPPED — apply blocked by safety threshold.`);
    } else {
      logger.info(`Step 6/${totalSteps}  Applying ${plan.length} guarded update(s)…`);
      applyResult = await applyGuardedUpdates({ supabase, tenantId, plan }, logger);
    }
  }

  const skippedTotal = notInFeed + unchanged + archivedSkipped + applyResult.conflictSkipped;
  const finishedAt = new Date();
  const logDir = getRuntimeLogDir();
  await fs.mkdir(logDir, { recursive: true });
  const jsonPath = path.join(logDir, `${runId}.json`);
  const textPath = path.join(logDir, `${runId}.log`);

  const summary = {
    target: 'b2bcenter',
    supplier: supplier.key,
    manufacturer: supplier.manufacturer,
    dryRun: !isApply,
    apply: isApply,
    blocked: thresholdBlocked,
    tenantId,
    feedUrl,
    date: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedSeconds: Number(((finishedAt - startedAt) / 1000).toFixed(1)),
    logFiles: { json: jsonPath, text: textPath },
    safety: {
      confirm: isApply ? confirm === true : false,
      allowLargeApply: allowLargeApply === true,
      maxChangePct,
      plannedChangePct,
      thresholdBlocked,
    },
    counts: {
      feedRows: feed.rawCount,
      feedSkus: feed.uniqueSkus,
      feedDuplicates: feed.dupes,
      feedBlankSkus: feed.blanks,
      invalidQuantities: feed.invalid,
      portalProducts: portalProducts.length,
      activeProducts,
      archivedProducts,
      planned: plan.length,
      unchanged,
      notInFeed,
      notInPortal,
      archivedSkipped,
      conflictSkipped: applyResult.conflictSkipped,
      updated: applyResult.updated,
      errors: applyResult.errors,
      skipped: {
        notInFeed,
        unchanged,
        archivedSkipped,
        conflictSkipped: applyResult.conflictSkipped,
        total: skippedTotal,
      },
    },
    preview,
    previewToken: signedPreview,
    appliedPreview: applyResult.appliedPreview,
    conflictPreview: applyResult.conflictPreview,
    errorDetail: applyResult.errorDetail,
    samples: {
      notInFeed: notInFeedSamples,
      notInPortal: notInPortalSamples,
    },
  };

  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2));
  await fs.writeFile(
    textPath,
    [
      isApply
        ? 'B2BCenter inventory sync — APPLY (guarded, quantity only)'
        : 'B2BCenter inventory sync — DRY RUN ONLY (no DB writes)',
      '',
      `Date:            ${summary.date}`,
      `Supplier:        ${summary.supplier}`,
      `Manufacturer:    ${summary.manufacturer}`,
      `Tenant:          ${summary.tenantId}`,
      `Mode:            ${isApply ? 'APPLY' : 'DRY RUN'}`,
      `Feed:            ${summary.feedUrl}`,
      `Elapsed:         ${summary.elapsedSeconds}s`,
      '',
      `Safety threshold:  maxChangePct=${maxChangePct}%  plannedChangePct=${plannedChangePct}%`,
      `Allow large apply: ${summary.safety.allowLargeApply}`,
      `Threshold blocked: ${thresholdBlocked}`,
      '',
      `Feed rows:       ${summary.counts.feedRows}`,
      `Feed SKUs:       ${summary.counts.feedSkus} (dupes ${summary.counts.feedDuplicates}, blank ${summary.counts.feedBlankSkus})`,
      `Portal products: ${summary.counts.portalProducts} (active ${summary.counts.activeProducts}, archived ${summary.counts.archivedProducts})`,
      `Planned:         ${summary.counts.planned}`,
      `Unchanged:       ${summary.counts.unchanged}`,
      `Not in feed:     ${summary.counts.notInFeed}`,
      `Not in portal:   ${summary.counts.notInPortal}`,
      `Archived skipped:${summary.counts.archivedSkipped}`,
      `Conflict skipped:${summary.counts.conflictSkipped}`,
      `Updated:         ${summary.counts.updated}`,
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
      isApply
        ? thresholdBlocked
          ? '*** APPLY BLOCKED by safety threshold — no Supabase writes were performed. ***'
          : `*** APPLY COMPLETE — updated=${summary.counts.updated}, conflicts=${summary.counts.conflictSkipped}, errors=${summary.counts.errors}. ***`
        : '*** DRY RUN ONLY — no Supabase writes were performed. ***',
    ].join('\n'),
  );

  logger.info(`  JSON log: ${jsonPath}`);
  logger.info(`  Text log: ${textPath}`);
  logger.info(
    `  Result → updated=${summary.counts.updated}, conflicts=${summary.counts.conflictSkipped}, ` +
      `errors=${summary.counts.errors}, skipped=${skippedTotal}` +
      `${isApply ? (thresholdBlocked ? ' (BLOCKED)' : '') : ' (DRY RUN)'}`,
  );

  return summary;
}

// --- Public entry --------------------------------------------------------

export async function runB2BCenterSync({
  supplierKey = 'all',
  dryRun = true,
  confirm = false,
  allowLargeApply = false,
  maxChangePct,
  previewToken,
  onLog,
} = {}) {
  const logger = createLogger(onLog);
  const mode = dryRun === false ? 'apply' : 'dry-run';

  const {
    B2BCENTER_SUPABASE_URL,
    B2BCENTER_SUPABASE_SERVICE_ROLE_KEY,
    B2BCENTER_TENANT_ID,
    B2BCENTER_MAX_CHANGE_PCT,
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

  // Apply-mode guards.
  if (mode === 'apply') {
    if (normalizedKey === 'all') {
      const error = new Error(
        'B2BCenter apply does not support supplierKey "all". Apply one supplier at a time ' +
          '(megapap or b2bmarkt).',
      );
      error.exitCode = 1;
      throw error;
    }
    if (confirm !== true) {
      const error = new Error(
        'B2BCenter apply requires explicit confirmation. Re-run with --confirm.',
      );
      error.exitCode = 1;
      throw error;
    }
  }

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

  const resolvedMaxChangePct = (() => {
    if (Number.isFinite(maxChangePct)) return maxChangePct;
    const fromEnv = Number.parseFloat(B2BCENTER_MAX_CHANGE_PCT);
    return Number.isFinite(fromEnv) ? fromEnv : DEFAULT_MAX_CHANGE_PCT;
  })();

  const supabase = createClient(B2BCENTER_SUPABASE_URL, B2BCENTER_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Node 20 has no native WebSocket; supabase-js builds a Realtime client even
    // though this engine only does REST queries. Provide `ws` so it loads cleanly.
    realtime: { transport: WebSocket },
  });

  if (mode === 'apply') {
    logger.info(
      `B2BCenter APPLY mode (guarded, quantity-only). maxChangePct=${resolvedMaxChangePct}%, ` +
        `allowLargeApply=${allowLargeApply === true}.`,
    );
  } else {
    logger.info('B2BCenter dry-run mode: no Supabase writes will be performed.');
  }

  const results = [];
  for (const target of targets) {
    try {
      results.push(
        await runSupplier(target, {
          supabase,
          tenantId: B2BCENTER_TENANT_ID,
          mode,
          confirm,
          allowLargeApply,
          maxChangePct: resolvedMaxChangePct,
          previewToken,
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
    dryRun: mode !== 'apply',
    results,
    hasErrors: results.some(
      (r) => r.error || r.blocked || (r.counts && r.counts.errors > 0),
    ),
  };
}
