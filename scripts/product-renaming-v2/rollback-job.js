#!/usr/bin/env node
/**
 * Restore products from a job's rollback.json.
 *
 * Default mode is DRY-RUN. Real mutations only with --apply.
 *
 * Usage:
 *   node scripts/product-renaming-v2/rollback-job.js --job=<jobId>
 *   node scripts/product-renaming-v2/rollback-job.js --job=<jobId> --apply
 *   node scripts/product-renaming-v2/rollback-job.js --job=<jobId> --apply --limit=10
 *
 * Only products listed in rollback.json (those successfully mutated by a real
 * apply run) are eligible. Each is restored to the exact title / SEO / desc
 * captured at apply time. The same mutation policy applies — only title,
 * seo.title, seo.description, descriptionHtml are touched.
 */

import { createShopifyClient, sleep } from './lib/shopify-client.js';
import {
  jobDir,
  jobExists,
  readJson,
  writeJsonAtomic,
} from './lib/job-store.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { job: null, apply: false, limit: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else if (a === '--apply') opts.apply = true;
    else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.job) {
    console.error('ERROR: --job=<jobId> is required.');
    process.exit(1);
  }
  if (!(await jobExists(opts.job))) {
    console.error(`ERROR: Job folder does not exist: ${jobDir(opts.job)}`);
    process.exit(1);
  }

  const rollback = await readJson(opts.job, 'rollback');
  if (!rollback?.rollbackItems || rollback.rollbackItems.length === 0) {
    console.log('No rollback items recorded for this job. Nothing to do.');
    process.exit(0);
  }

  const mode = opts.apply ? 'APPLY' : 'DRY';
  console.log(`[${new Date().toISOString()}] Rollback job ${opts.job} mode=${mode}`);
  console.log(`Rollback items: ${rollback.rollbackItems.length}`);
  if (opts.limit) console.log(`Limit: ${opts.limit}`);

  if (opts.apply && !opts.limit && rollback.rollbackItems.length > 50) {
    console.error('ERROR: --apply on more than 50 rollback items requires --limit. Stage in batches.');
    process.exit(1);
  }

  const client = createShopifyClient();
  if (opts.apply) await client.ensureToken();

  const results = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < rollback.rollbackItems.length; i++) {
    if (opts.limit && success + failed >= opts.limit) break;
    const item = rollback.rollbackItems[i];

    const entry = {
      productId: item.productId,
      handle: item.handle,
      mode: mode.toLowerCase(),
      status: null,
      restoredAt: null,
      userErrors: null,
    };

    if (!opts.apply) {
      entry.status = 'dry-selected';
      results.push(entry);
      continue;
    }

    try {
      const result = await client.updateProductRename({
        productId: item.productId,
        newTitle: item.oldTitle,
        newSeoTitle: item.oldSeoTitle,
        newSeoDescription: item.oldSeoDescription,
        newDescriptionHtml: item.oldDescriptionHtml || null,
      });
      const userErrors = result.userErrors || [];
      if (userErrors.length > 0) {
        entry.status = 'failed';
        entry.userErrors = userErrors;
        failed++;
        console.warn(`FAIL ${item.handle}: ${JSON.stringify(userErrors).slice(0, 200)}`);
      } else {
        entry.status = 'success';
        entry.restoredAt = new Date().toISOString();
        success++;
        console.log(`RESTORED ${item.handle}`);
      }
    } catch (e) {
      entry.status = 'failed';
      entry.userErrors = [{ message: String(e.message).slice(0, 500) }];
      failed++;
      console.warn(`ERROR ${item.handle}: ${e.message.slice(0, 180)}`);
    }
    results.push(entry);
    await sleep(300);
  }

  const summary = {
    jobId: opts.job,
    timestamp: new Date().toISOString(),
    mode: mode.toLowerCase(),
    total: rollback.rollbackItems.length,
    attempted: results.length,
    success,
    failed,
    results,
  };
  await writeJsonAtomic(opts.job, `rollback-${mode.toLowerCase()}-summary.json`, summary);

  console.log();
  console.log('========== Rollback summary ==========');
  console.log(`Mode:      ${mode}`);
  console.log(`Total:     ${rollback.rollbackItems.length}`);
  console.log(`Attempted: ${results.length}`);
  console.log(`Success:   ${success}`);
  console.log(`Failed:    ${failed}`);
  console.log('=======================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
