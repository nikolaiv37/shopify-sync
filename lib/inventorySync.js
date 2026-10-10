import fs from 'node:fs/promises';
import path from 'node:path';
import { createInventoryService } from './inventory/service.js';
import { SUPPLIERS, supplierConfig } from './inventory/config.js';

/** Compatibility entry point. Legacy apply cannot bypass a signed V2 preview. */
export async function runInventorySync({ supplierKey = 'all', dryRun = true, onLog = () => {}, token, confirm = false, allowLargeApply = false } = {}) {
  const service = createInventoryService();
  if (!dryRun) {
    if (supplierKey === 'all' || !token) throw new Error('Apply requires one supplier and a signed V2 preview. Use scripts/inventory-v2.js apply --file=... --supplier=... --confirm.');
    return service.applyBatch({ supplier: supplierKey, token, confirm, allowLargeApply });
  }
  const targets = supplierKey === 'all' ? Object.keys(SUPPLIERS) : [supplierConfig(supplierKey).key];
  const results = [];
  for (const supplier of targets) {
    onLog(`${supplier}: read-only inventory preview`);
    const preview = await service.preview({ supplier, onProgress: count => onLog(`Shopify variants read: ${count}`) });
    const directory = process.env.LOG_DIR || './logs'; await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${supplier}-DRYRUN-${preview.runId}.json`);
    const summary = { supplier, vendor: SUPPLIERS[supplier].vendor, dryRun: true, date: preview.generatedAt, finishedAt: new Date().toISOString(), elapsedSeconds: null, counts: { ...preview.summary, planned: preview.summary.changes, updated: 0, errors: 0, skipped: { total: preview.summary.skipped + preview.summary.alreadyCorrect } }, previewToken: preview.batches, rows: preview.rows, logFiles: { json: file } };
    await fs.writeFile(file, JSON.stringify(summary, null, 2)); results.push(summary);
  }
  return { supplierKey, dryRun, results, hasErrors: results.some(r => r.counts.conflicts > 0) };
}
