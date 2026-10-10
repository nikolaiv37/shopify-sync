import fs from 'node:fs/promises';
import { getSupplier } from '../suppliers/index.js';
import { createShopifyClient } from '../shopify/client.js';
import { fetchVariantIndex, fetchVariantsByIds } from '../shopify/variants.js';
import { getSkuMigration, SKU_MIGRATIONS } from './config.js';
import { buildSkuFeedIndex, classifySkuMigration } from './engine.js';

export const SKU_APPLY_BATCH_SIZE = 25;
export const SKU_API_VERSION = 'inventory-item-sku-v2';
const MAX_BATCH_ITEMS = 100;
const MUTATION_CHUNK = 100;
const MUTATION_CONCURRENCY = 8;
const FEED_TTL_MS = 5 * 60 * 1000;
const feedCache = new Map();

const SKU_BULK_MUTATION = `
  mutation skuBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`;

export function getSkuSupplierInfo() {
  return Object.values(SKU_MIGRATIONS).map((item) => ({ ...item, batchSize: SKU_APPLY_BATCH_SIZE }));
}

async function getFeedSnapshot(supplierKey) {
  const adapter = getSupplier(supplierKey);
  const migration = getSkuMigration(supplierKey);
  const xmlPath = adapter.config.defaultXml;
  const stat = await fs.stat(xmlPath);
  const cached = feedCache.get(supplierKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.loadedAt < FEED_TTL_MS) return cached;

  const products = adapter.parseProducts(await fs.readFile(xmlPath, 'utf8'));
  const entry = {
    mtimeMs: stat.mtimeMs,
    loadedAt: Date.now(),
    feedSnapshotAt: new Date(stat.mtimeMs).toISOString(),
    feedIndex: buildSkuFeedIndex(products, migration),
  };
  feedCache.set(supplierKey, entry);
  return entry;
}

export async function previewSkuMigration({ supplierKey, createClient = createShopifyClient } = {}) {
  const migration = getSkuMigration(supplierKey);
  const { feedIndex, feedSnapshotAt } = await getFeedSnapshot(supplierKey);
  const client = createClient();
  const { bySku, total } = await fetchVariantIndex(client);
  const classified = classifySkuMigration({ feedIndex, shopifyBySku: bySku, migration });
  return {
    supplier: { ...migration, batchSize: SKU_APPLY_BATCH_SIZE },
    generatedAt: new Date().toISOString(),
    feedSnapshotAt,
    shopifyVariantsScanned: total,
    ...classified,
  };
}

function groupWrites(writes) {
  const grouped = new Map();
  for (const write of writes) {
    const list = grouped.get(write.productId) ?? [];
    list.push(write);
    grouped.set(write.productId, list);
  }
  const jobs = [];
  for (const [productId, rows] of grouped) {
    for (let i = 0; i < rows.length; i += MUTATION_CHUNK) jobs.push({ productId, rows: rows.slice(i, i + MUTATION_CHUNK) });
  }
  return jobs;
}

export async function executeWriteJobs(client, jobs) {
  const completed = [];
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const jobIndex = nextIndex++;
      if (jobIndex >= jobs.length) return;
      const job = jobs[jobIndex];
      try {
        const data = await client.gqlWithRetry(
          SKU_BULK_MUTATION,
          {
            productId: job.productId,
            variants: job.rows.map((row) => ({
              id: row.variantId,
              inventoryItem: { sku: row.newSku },
            })),
          },
          `sku ${job.productId}`,
          2,
        );
        const errors = data?.productVariantsBulkUpdate?.userErrors || [];
        if (errors.length) {
          const message = errors.map((error) => error.message).join('; ').slice(0, 300);
          completed.push(...job.rows.map((row) => ({ ...row, status: 'failed', error: message })));
        } else {
          completed.push(...job.rows.map((row) => ({ ...row, status: 'success' })));
        }
      } catch (error) {
        const message = String(error?.message || error).slice(0, 300);
        completed.push(...job.rows.map((row) => ({ ...row, status: 'failed', error: message })));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MUTATION_CONCURRENCY, jobs.length || 1) }, worker));
  return completed;
}

export async function applySkuBatch({ supplierKey, items, createClient = createShopifyClient } = {}) {
  const migration = getSkuMigration(supplierKey);
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error('Няма избрани SKU промени.');
    error.statusCode = 400;
    throw error;
  }
  if (items.length > MAX_BATCH_ITEMS) {
    const error = new Error(`Партидата е твърде голяма (максимум ${MAX_BATCH_ITEMS}).`);
    error.statusCode = 400;
    throw error;
  }

  console.log(`[sku:${supplierKey}] batch received (${items.length} item(s))`);
  const { feedIndex, feedSnapshotAt } = await getFeedSnapshot(supplierKey);
  const requested = items
    .filter((item) => item && typeof item.variantId === 'string')
    .map((item) => ({
      variantId: item.variantId,
      oldSku: String(item.oldSku || '').trim(),
      requestedNewSku: String(item.newSku || '').trim(),
    }));
  const client = createClient();
  console.log(`[sku:${supplierKey}] reading ${requested.length} live variant(s)`);
  const live = await fetchVariantsByIds(client, requested.map((item) => item.variantId));
  const results = [];
  const writes = [];

  for (const request of requested) {
    const base = { variantId: request.variantId, oldSku: request.oldSku, newSku: request.requestedNewSku };
    const mappingRows = feedIndex.byOldSku.get(request.oldSku) || [];
    if (mappingRows.length !== 1 || mappingRows[0].newSku !== request.requestedNewSku) {
      results.push({ ...base, status: 'conflict', reason: 'feed-mapping-changed' });
      continue;
    }
    const node = live.get(request.variantId);
    if (!node) {
      results.push({ ...base, status: 'conflict', reason: 'variant-missing' });
      continue;
    }
    if (node.vendor !== migration.vendor) {
      results.push({ ...base, status: 'conflict', reason: 'vendor-mismatch' });
      continue;
    }
    if (node.sku === request.requestedNewSku) {
      results.push({ ...base, status: 'already' });
      continue;
    }
    if (node.sku !== request.oldSku) {
      results.push({ ...base, status: 'skipped_stale', reason: 'sku-changed-after-preview' });
      continue;
    }
    writes.push({ ...base, productId: node.productId });
  }

  const jobs = groupWrites(writes);
  console.log(`[sku:${supplierKey}] applying ${writes.length} write(s) across ${jobs.length} product mutation(s), concurrency=${MUTATION_CONCURRENCY}`);
  results.push(...await executeWriteJobs(client, jobs));
  console.log(`[sku:${supplierKey}] batch complete (${results.filter((row) => row.status === 'success').length} updated, ${results.filter((row) => row.status !== 'success' && row.status !== 'already').length} skipped/failed)`);

  return { results, feedSnapshotAt };
}
