#!/usr/bin/env node
/**
 * Apply a V3 job plan to Shopify.
 *
 * Default mode is DRY-RUN. Real mutations only with --apply.
 *
 * Usage:
 *   node scripts/product-renaming-v3/apply-job.js --job=<jobId> --dry-run --limit=20
 *   node scripts/product-renaming-v3/apply-job.js --job=<jobId> --apply --limit=10
 *   node scripts/product-renaming-v3/apply-job.js --job=<jobId> --apply --resume --limit=50
 *   node scripts/product-renaming-v3/apply-job.js --job=<jobId> --apply --confirm-full-job
 *
 * Safety guarantees:
 *   - --apply requires --limit unless --confirm-full-job is set.
 *   - --resume without --limit also requires --confirm-full-job.
 *   - blocked / needs_review / skipped_* items are NEVER applied.
 *   - SHA256 hash chain (export → plan → validation) must match before apply.
 *   - job.filters must equal export.filters must equal plan.exportFilters.
 *   - Per-product Shopify-state check:
 *       current title equals new title → already_applied (no mutation)
 *       current title differs from old AND new → manual_change_detected
 *   - descriptionHtml replacement is recomputed against the LIVE Shopify
 *     description (not the export snapshot), and silently skipped if the
 *     live description no longer contains the old model 1..20 times.
 */

import { createShopifyClient, sleep } from './lib/shopify-client.js';
import {
  hashJobFile,
  jobDir,
  jobExists,
  readJson,
  updateJobStatus,
} from './lib/job-store.js';
import {
  appendFailedItem,
  appendRollbackItem,
  initProgress,
  loadProgress,
  logApplyEntry,
  saveProgress,
} from './lib/progress-store.js';
import { replaceModel } from './lib/replacement.js';

const DESCRIPTION_MAX_OCCURRENCES = 20;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    job: null,
    apply: false,
    dryRun: false,
    resume: false,
    limit: null,
    concurrency: 2,
    confirmFullJob: false,
  };
  for (const a of args) {
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--confirm-full-job') opts.confirmFullJob = true;
    else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a.startsWith('--concurrency=')) {
      const v = Number.parseInt(a.slice('--concurrency='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.concurrency = v;
    }
  }
  return opts;
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return a == null && b == null;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

function normalizeForCompare(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').replace(/[–—]/g, '-').trim().toLowerCase();
}

async function verifyConsistency(jobId, job, exportData, planData, validation) {
  const reasons = [];
  if (!exportData) reasons.push('export.json missing');
  if (!planData) reasons.push('plan.json missing');
  if (!validation) reasons.push('validation.json missing');
  if (reasons.length > 0) return reasons;

  const currentExportHash = await hashJobFile(jobId, 'export');
  const currentPlanHash = await hashJobFile(jobId, 'plan');

  if (!planData.exportHash) {
    reasons.push('plan.json has no exportHash (re-run rename:v3:plan)');
  } else if (currentExportHash !== planData.exportHash) {
    reasons.push(
      `export.json hash mismatch: current=${currentExportHash?.slice(0, 12)} plan=${planData.exportHash.slice(0, 12)}`,
    );
  }
  if (!validation.exportHash || !validation.planHash) {
    reasons.push('validation.json missing exportHash or planHash (re-run rename:v3:validate)');
  } else {
    if (currentExportHash !== validation.exportHash) {
      reasons.push(
        `export.json hash drifted since validation: current=${currentExportHash?.slice(0, 12)} validation=${validation.exportHash.slice(0, 12)}`,
      );
    }
    if (currentPlanHash !== validation.planHash) {
      reasons.push(
        `plan.json hash drifted since validation: current=${currentPlanHash?.slice(0, 12)} validation=${validation.planHash.slice(0, 12)}`,
      );
    }
  }

  const jobFilters = job?.filters || null;
  const exportFilters = exportData.filters || null;
  const planFilters = planData.exportFilters || planData.jobFilters || null;
  if (jobFilters && exportFilters && !shallowEqual(jobFilters, exportFilters)) {
    reasons.push(`job.filters != export.filters: ${JSON.stringify(jobFilters)} vs ${JSON.stringify(exportFilters)}`);
  }
  if (exportFilters && planFilters && !shallowEqual(exportFilters, planFilters)) {
    reasons.push(`export.filters != plan.exportFilters: ${JSON.stringify(exportFilters)} vs ${JSON.stringify(planFilters)}`);
  }

  if (planData.totalItems != null && exportData.totalExported != null
      && planData.totalItems > exportData.totalExported) {
    reasons.push('plan totalItems > export totalExported (impossible — stale)');
  }
  if (validation.canApply === false) {
    reasons.push('validation.canApply is false (no ready items)');
  }
  return reasons;
}

function computeLiveDescriptionReplacement(liveDescriptionHtml, descriptionReplacement) {
  if (!liveDescriptionHtml || !descriptionReplacement) return null;
  const { from, to } = descriptionReplacement;
  if (!from) return null;
  const result = replaceModel(liveDescriptionHtml, from, to);
  if (result.count === 0) return null;
  if (result.count > DESCRIPTION_MAX_OCCURRENCES) return null;
  if (result.text === liveDescriptionHtml) return null;
  return result.text;
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
  if (opts.apply && opts.dryRun) {
    console.error('ERROR: --apply and --dry-run are mutually exclusive.');
    process.exit(1);
  }
  if (opts.apply && !opts.limit) {
    if (!opts.confirmFullJob) {
      console.error('ERROR: --apply requires --limit.');
      console.error('       Pass --confirm-full-job to apply the entire eligible set.');
      console.error('       Resuming an interrupted run also requires --limit unless --confirm-full-job is set.');
      process.exit(1);
    }
    console.warn('');
    console.warn('!!!! WARNING: --confirm-full-job is set !!!!');
    console.warn(`     Apply will run across ALL eligible items in V3 job ${opts.job}`);
    console.warn('     with no --limit safety. Mutations are real and irreversible');
    console.warn('     except via rename:v3:rollback. Make sure validation has been reviewed.');
    console.warn('');
  }
  if (opts.resume && !opts.limit && !opts.confirmFullJob) {
    console.error('ERROR: --resume without --limit requires --confirm-full-job.');
    process.exit(1);
  }

  const job = await readJson(opts.job, 'job');
  const planData = await readJson(opts.job, 'plan');
  const exportData = await readJson(opts.job, 'export');
  const validation = await readJson(opts.job, 'validation');

  if (!planData?.plan) {
    console.error('ERROR: plan.json missing. Run rename:v3:plan first.');
    process.exit(1);
  }
  if (!validation) {
    console.error('ERROR: validation.json missing. Run rename:v3:validate first.');
    process.exit(1);
  }

  const staleReasons = await verifyConsistency(opts.job, job, exportData, planData, validation);
  if (staleReasons.length > 0) {
    console.error('ERROR: Job artifacts are inconsistent or stale:');
    for (const r of staleReasons) console.error(`  - ${r}`);
    console.error('');
    console.error('Re-run the pipeline:');
    console.error(`  npm run rename:v3:plan -- --job=${opts.job}`);
    console.error(`  npm run rename:v3:validate -- --job=${opts.job}`);
    process.exit(1);
  }

  const mode = opts.apply ? 'APPLY' : 'DRY';
  console.log(`[${new Date().toISOString()}] V3 Job ${opts.job}`);
  console.log(`Mode:        ${mode}`);
  console.log(`Concurrency: ${opts.concurrency}`);
  if (opts.limit) console.log(`Limit:       ${opts.limit}`);
  if (opts.resume) console.log('Resume:      yes');

  // Eligibility comes from validation.items (post-demotion), NOT
  // planData.plan. validate-job may have demoted duplicate-new-title
  // ready items to needs_review; reading plan directly would re-include
  // them and silently apply unsafe duplicates.
  if (!Array.isArray(validation.items)) {
    console.error('ERROR: validation.items missing or not an array.');
    console.error('       This validation.json was produced by an older V3 build.');
    console.error(`       Re-run: npm run rename:v3:validate -- --job=${opts.job}`);
    process.exit(1);
  }
  const validatedItems = validation.items;

  const eligible = validatedItems.filter((item) => item.status === 'ready' && item.mutationAllowed === true);
  if (eligible.length === 0) {
    console.log('No ready items. Nothing to apply.');
    process.exit(0);
  }

  const blockedCount = validatedItems.filter((i) => i.status === 'blocked').length;
  const needsReviewCount = validatedItems.filter((i) => i.status === 'needs_review').length;
  if (opts.apply) {
    if (blockedCount > 0) console.log(`Note: ${blockedCount} blocked items present — never applied.`);
    if (needsReviewCount > 0) console.log(`Note: ${needsReviewCount} needs_review items — never applied.`);
  }

  const batchId = `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let progress = opts.resume ? await loadProgress(opts.job) : null;
  if (!progress) {
    progress = await initProgress(opts.job, batchId, eligible.length);
  } else {
    console.log(`Resuming from index ${progress.nextIndex} (batch ${progress.batchId})`);
  }

  const client = createShopifyClient();
  if (opts.apply) await client.ensureToken();

  let appliedThisRun = 0;
  for (let i = progress.nextIndex; i < eligible.length; i++) {
    const item = eligible[i];

    if (opts.limit && appliedThisRun >= opts.limit) {
      console.log(`Reached --limit=${opts.limit}.`);
      break;
    }

    const entry = {
      batchId,
      index: i,
      productId: item.productId,
      handle: item.handle,
      status: item.status,
      oldTitle: item.oldTitle,
      newTitle: item.newTitle,
      oldModel: item.oldModel,
      newModel: item.newModel,
      replacementCounts: item.replacementCounts,
      mode: mode.toLowerCase(),
      mutationStatus: null,
      userErrors: null,
      appliedAt: null,
      timestamp: new Date().toISOString(),
    };

    if (!opts.apply) {
      entry.mutationStatus = 'dry-selected';
      await logApplyEntry(opts.job, entry);
      progress.counts.dry_logged++;
      progress.nextIndex = i + 1;
      await saveProgress(opts.job, progress);
      appliedThisRun++;
      continue;
    }

    let currentProduct;
    try {
      currentProduct = await client.fetchProduct(item.productId);
    } catch (e) {
      entry.mutationStatus = 'fetch_error';
      entry.userErrors = [{ message: String(e.message).slice(0, 500) }];
      await logApplyEntry(opts.job, entry);
      await appendFailedItem(opts.job, entry);
      progress.counts.failed++;
      progress.nextIndex = i + 1;
      await saveProgress(opts.job, progress);
      continue;
    }
    if (!currentProduct || !currentProduct.title) {
      entry.mutationStatus = 'fetch_error';
      entry.userErrors = [{ message: 'product not found' }];
      await logApplyEntry(opts.job, entry);
      await appendFailedItem(opts.job, entry);
      progress.counts.failed++;
      progress.nextIndex = i + 1;
      await saveProgress(opts.job, progress);
      continue;
    }

    const currentTitle = normalizeForCompare(currentProduct.title);
    const oldTitle = normalizeForCompare(item.oldTitle);
    const newTitle = normalizeForCompare(item.newTitle);

    if (currentTitle === newTitle) {
      entry.mutationStatus = 'already_applied';
      await logApplyEntry(opts.job, entry);
      progress.counts.already_applied++;
      progress.nextIndex = i + 1;
      await saveProgress(opts.job, progress);
      continue;
    }
    if (currentTitle !== oldTitle) {
      entry.mutationStatus = 'manual_change_detected';
      entry.currentShopifyTitle = currentProduct.title;
      await logApplyEntry(opts.job, entry);
      progress.counts.manual_change_detected++;
      progress.nextIndex = i + 1;
      await saveProgress(opts.job, progress);
      continue;
    }

    let newDescriptionHtml = null;
    if (item.descriptionReplacement) {
      newDescriptionHtml = computeLiveDescriptionReplacement(
        currentProduct.descriptionHtml || '',
        item.descriptionReplacement,
      );
    }

    try {
      const result = await client.updateProductRename({
        productId: item.productId,
        newTitle: item.newTitle,
        newSeoTitle: item.newSeoTitle != null && item.newSeoTitle !== item.oldSeoTitle ? item.newSeoTitle : null,
        newSeoDescription: item.newSeoDescription != null && item.newSeoDescription !== item.oldSeoDescription ? item.newSeoDescription : null,
        newDescriptionHtml,
      });
      const userErrors = result.userErrors || [];
      if (userErrors.length > 0) {
        entry.mutationStatus = 'failed';
        entry.userErrors = userErrors;
        await logApplyEntry(opts.job, entry);
        await appendFailedItem(opts.job, entry);
        progress.counts.failed++;
      } else {
        entry.mutationStatus = 'success';
        entry.appliedAt = new Date().toISOString();
        await logApplyEntry(opts.job, entry);
        await appendRollbackItem(opts.job, {
          productId: item.productId,
          handle: item.handle,
          oldTitle: currentProduct.title,
          oldSeoTitle: currentProduct.seo?.title || null,
          oldSeoDescription: currentProduct.seo?.description || null,
          oldDescriptionHtml: currentProduct.descriptionHtml || null,
          appliedAt: entry.appliedAt,
          batchId,
        });
        progress.counts.applied++;
        console.log(`OK ${item.handle}: ${item.newTitle.slice(0, 60)}`);
      }
    } catch (e) {
      entry.mutationStatus = 'failed';
      entry.userErrors = [{ message: String(e.message).slice(0, 500) }];
      await logApplyEntry(opts.job, entry);
      await appendFailedItem(opts.job, entry);
      progress.counts.failed++;
      console.warn(`ERROR ${item.handle}: ${e.message.slice(0, 180)}`);
    }

    progress.nextIndex = i + 1;
    await saveProgress(opts.job, progress);
    appliedThisRun++;
    await sleep(Math.max(150, Math.floor(1000 / Math.max(1, opts.concurrency))));
  }

  const allDone = progress.nextIndex >= eligible.length;
  await updateJobStatus(opts.job, {
    status: opts.apply ? (allDone ? 'applied' : 'apply_in_progress') : 'dry_run_complete',
    phase: { ...(job.phase || {}), applied: opts.apply && allDone },
    lastApplySummary: {
      mode: mode.toLowerCase(),
      batchId,
      ...progress.counts,
      eligible: eligible.length,
      nextIndex: progress.nextIndex,
      finishedAt: new Date().toISOString(),
    },
  });

  console.log();
  console.log('========== V3 Apply summary ==========');
  console.log(`Mode:                    ${mode}`);
  console.log(`Eligible:                ${eligible.length}`);
  console.log(`Applied (success):       ${progress.counts.applied}`);
  console.log(`Failed:                  ${progress.counts.failed}`);
  console.log(`Already applied:         ${progress.counts.already_applied}`);
  console.log(`Manual change detected:  ${progress.counts.manual_change_detected}`);
  console.log(`Dry-run logged:          ${progress.counts.dry_logged}`);
  console.log(`Next index:              ${progress.nextIndex} / ${eligible.length}`);
  console.log(`Blocked (never apply):   ${blockedCount}`);
  console.log(`Needs review (never apply): ${needsReviewCount}`);
  console.log('=======================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
