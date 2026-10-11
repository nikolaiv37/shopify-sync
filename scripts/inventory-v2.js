#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs/promises';
import { createInventoryService } from '../lib/inventory/service.js';
import { createInventoryStore } from '../lib/inventory/shopify.js';
import { initializeIdentityDefinitions, recoverWriterLock } from '../lib/inventory/setup.js';

const args = process.argv.slice(2); const command = args[0];
const flag = name => args.includes(`--${name}`);
const value = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const supplier = value('supplier'); const file = value('file');
async function main() {
  if (!command || command === 'help') {
    console.log(`Inventory V2 (preview is read-only):
  node scripts/inventory-v2.js discover --file=discovery.json [--overrides=approved-overrides.json]
  node scripts/inventory-v2.js init-definitions --confirm
  node scripts/inventory-v2.js backfill --file=discovery.json --confirm [--allow-ownership-change] [--max-batches=1]
  node scripts/inventory-v2.js preview --supplier=megapap --file=preview.json [--verified-only]
  node scripts/inventory-v2.js apply --supplier=megapap --file=preview.json --confirm [--allow-large-apply] [--max-batches=1]
  node scripts/inventory-v2.js history
  node scripts/inventory-v2.js inspect-lock
  node scripts/inventory-v2.js recover-lock --holder=UUID --reason=reviewed --confirm
Re-running a valid report resumes completed batches from Shopify's durable journal.
Mapping writes and inventory writes are distinct authorized commands.`); return;
  }
  const service = createInventoryService();
  if (command === 'init-definitions') return console.log(JSON.stringify(await initializeIdentityDefinitions({ confirm: flag('confirm') }), null, 2));
  if (command === 'inspect-lock') { const app = await createInventoryStore().appInfo(); return console.log(JSON.stringify({ lock: app.lock ? JSON.parse(app.lock.value) : null }, null, 2)); }
  if (command === 'recover-lock') return console.log(JSON.stringify(await recoverWriterLock({ confirm: flag('confirm'), expectedHolder: value('holder'), reason: value('reason') }), null, 2));
  if (command === 'history') return console.log(JSON.stringify(await service.history(), null, 2));
  if (command === 'discover' || command === 'preview') {
    if (!file) throw new Error('A --file path is required for the inspectable report.');
    const progress = n => console.error(`Read ${n} Shopify variants`);
    const overrides = value('overrides') ? JSON.parse(await fs.readFile(value('overrides'), 'utf8')) : {};
    const report = command === 'discover' ? await service.discovery({ overrides, onProgress: progress }) : await service.preview({ supplier, onProgress: progress, allowPartial: flag('verified-only') });
    await fs.writeFile(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ file, summary: report.summary, proposedMappings: report.proposedMappings, mappingReady: report.mappingReady, prerequisites: report.prerequisites }, null, 2)); return;
  }
  if (command === 'backfill' || command === 'apply') {
    if (!flag('confirm')) throw new Error('Writes require --confirm; preview and backfill/apply are separately authorized.');
    if (!file) throw new Error('A signed preview --file is required.');
    const report = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(report.batches)) throw new Error('Report contains no signed batches.');
    const maxBatches = value('max-batches') === undefined ? Infinity : Number(value('max-batches'));
    if (maxBatches !== Infinity && (!Number.isSafeInteger(maxBatches) || maxBatches < 1)) throw new Error('--max-batches must be a positive integer.');
    let processed = 0;
    for (const [index, token] of report.batches.entries()) {
      const result = command === 'backfill'
        ? await service.persistBatch({ token, confirm: true, allowOwnershipChange: flag('allow-ownership-change') })
        : await service.applyBatch({ supplier, token, confirm: true, allowLargeApply: flag('allow-large-apply') });
      console.log(JSON.stringify({ batch: index + 1, total: report.batches.length, ...result }));
      if (!result.replayed && ++processed >= maxBatches) break;
    }
    return;
  }
  throw new Error(`Unknown command: ${command}. Use help.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
