#!/usr/bin/env node
/**
 * Apply a V2 job plan to Shopify.
 *
 * Default mode is DRY-RUN. Real mutations only with --apply.
 *
 * Usage:
 *   node scripts/product-renaming-v2/apply-job.js --job=<jobId> --dry-run
 *   node scripts/product-renaming-v2/apply-job.js --job=<jobId> --apply --limit=5
 *   node scripts/product-renaming-v2/apply-job.js --job=<jobId> --apply --resume
 *   node scripts/product-renaming-v2/apply-job.js --job=<jobId> --apply --include-medium
 *   node scripts/product-renaming-v2/apply-job.js --job=<jobId> --apply --concurrency=2
 *
 * Safety rules (preserved from V1):
 *   - High-risk items are NEVER applied.
 *   - Blocked items are NEVER applied.
 *   - --apply requires --limit OR --resume.
 *   - Dry-run never mutates Shopify.
 *   - Stale plan protection: plan must match current export (timestamp + filters + total).
 *   - Shopify-state check before each mutation:
 *       current title == new title  -> already_applied
 *       current title differs from BOTH old and new -> manual_change_detected
 *   - --include-medium only allowed if validation.json was generated with --approve-medium.
 *
 * Allowed mutations:
 *   title, seo.title, seo.description, descriptionHtml (model-name replacement only).
 * Forbidden (never touched):
 *   handle, sku, vendor, productType, tags, variants, price, inventory,
 *   images, status, collections.
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

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    job: null,
    apply: false,
    dryRun: false,
    resume: false,
    limit: null,
    risk: 'low',
    includeMedium: false,
    concurrency: 2,
    confirmFullJob: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--resume') opts.resume = true;
    else if (a.startsWith('--risk=')) opts.risk = a.slice('--risk='.length);
    else if (a === '--include-medium') opts.includeMedium = true;
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
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function normalizeForCompare(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').replace(/[–—]/g, '-').trim().toLowerCase();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyDescriptionReplacement(descriptionHtml, descriptionReplacement) {
  if (!descriptionHtml || !descriptionReplacement) return null;
  const { from, to } = descriptionReplacement;
  if (!from) return null;
  const re = new RegExp(escapeRegex(from), 'gi');
  const count = (descriptionHtml.match(re) || []).length;
  if (count === 0 || count > 20) return null;
  const replaced = descriptionHtml.replace(re, to);
  return replaced === descriptionHtml ? null : replaced;
}

/**
 * Verify export/plan/validation are consistent with each other and with the
 * job. Returns string[] of failure reasons; non-empty means refuse to apply.
 */
async function verifyConsistency(jobId, job, exportData, planData, validation) {
  const reasons = [];

  if (!exportData) reasons.push('export.json missing');
  if (!planData) reasons.push('plan.json missing');
  if (!validation) reasons.push('validation.json missing');
  if (reasons.length > 0) return reasons;

  // Hash check: current bytes of export.json must match the hash plan saw.
  const currentExportHash = await hashJobFile(jobId, 'export');
  const currentPlanHash = await hashJobFile(jobId, 'plan');

  if (!planData.exportHash) {
    reasons.push('plan.json has no exportHash (older format — re-run rename:v2:plan)');
  } else if (currentExportHash !== planData.exportHash) {
    reasons.push(
      `export.json hash mismatch: current=${currentExportHash?.slice(0, 12)} plan recorded=${planData.exportHash.slice(0, 12)}`,
    );
  }

  if (!validation.exportHash || !validation.planHash) {
    reasons.push('validation.json missing exportHash or planHash (re-run rename:v2:validate)');
  } else {
    if (currentExportHash !== validation.exportHash) {
      reasons.push(
        `export.json hash drifted since validation: current=${currentExportHash?.slice(0, 12)} validation recorded=${validation.exportHash.slice(0, 12)}`,
      );
    }
    if (currentPlanHash !== validation.planHash) {
      reasons.push(
        `plan.json hash drifted since validation: current=${currentPlanHash?.slice(0, 12)} validation recorded=${validation.planHash.slice(0, 12)}`,
      );
    }
  }

  // Filter consistency: job.filters must equal what export used must equal
  // what plan recorded. Category override on plan side is allowed but must
  // be the only difference.
  const jobFilters = job?.filters || null;
  const exportFilters = exportData.filters || null;
  const planFilters = planData.exportFilters || planData.jobFilters || null;

  if (jobFilters && exportFilters && !shallowEqual(jobFilters, exportFilters)) {
    reasons.push(
      `job.filters does not match export.filters: ${JSON.stringify(jobFilters)} vs ${JSON.stringify(exportFilters)}`,
    );
  }
  if (exportFilters && planFilters && !shallowEqual(exportFilters, planFilters)) {
    reasons.push(
      `export.filters does not match plan.exportFilters: ${JSON.stringify(exportFilters)} vs ${JSON.stringify(planFilters)}`,
    );
  }

  // categoryOverride at plan time should equal job.filters.category when set.
  const planJobCat = planData.jobFilters?.category ?? null;
  const jobCat = jobFilters?.category ?? null;
  if (jobCat !== planJobCat) {
    reasons.push(`job.filters.category=${jobCat} but plan recorded ${planJobCat}`);
  }

  // Belt-and-suspenders: plan must not be larger than export.
  if (planData.totalItems != null && exportData.totalExported != null) {
    if (planData.totalItems > exportData.totalExported) {
      reasons.push('plan totalItems > export totalExported (impossible — stale)');
    }
  }

  if (validation.canApply === false) {
    reasons.push('validation.canApply is false (no ready items or hard blockers present)');
  }

  return reasons;
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
      console.error('       To apply the entire eligible set in one go, pass --confirm-full-job.');
      console.error('       Resuming an interrupted run still requires --limit unless --confirm-full-job is set.');
      process.exit(1);
    }
    console.warn('');
    console.warn('!!!! WARNING: --confirm-full-job is set !!!!');
    console.warn(`     Apply will run across ALL eligible items in job ${opts.job}`);
    console.warn('     with no --limit safety. Mutations are real and irreversible');
    console.warn('     except via rename:v2:rollback. Make sure validation has been reviewed.');
    console.warn('');
  }

  const job = await readJson(opts.job, 'job');
  const planData = await readJson(opts.job, 'plan');
  const exportData = await readJson(opts.job, 'export');
  const validation = await readJson(opts.job, 'validation');

  if (!planData?.plan) {
    console.error('ERROR: plan.json missing. Run rename:v2:plan first.');
    process.exit(1);
  }
  if (!validation) {
    console.error('ERROR: validation.json missing. Run rename:v2:validate first.');
    process.exit(1);
  }

  const staleReasons = await verifyConsistency(opts.job, job, exportData, planData, validation);
  if (staleReasons.length > 0) {
    console.error('ERROR: Job artifacts are inconsistent or stale:');
    for (const r of staleReasons) console.error(`  - ${r}`);
    console.error('');
    console.error('Re-run the pipeline:');
    console.error(`  npm run rename:v2:plan -- --job=${opts.job}`);
    console.error(`  npm run rename:v2:validate -- --job=${opts.job}`);
    process.exit(1);
  }

  if (opts.includeMedium && !validation.approveMedium) {
    console.error('ERROR: --include-medium requires validation run with --approve-medium.');
    process.exit(1);
  }

  const mode = opts.apply ? 'APPLY' : 'DRY';
  console.log(`[${new Date().toISOString()}] Job ${opts.job}`);
  console.log(`Mode:        ${mode}`);
  console.log(`Risk:        ${opts.risk}${opts.includeMedium ? ' + medium (approved)' : ''}`);
  console.log(`Concurrency: ${opts.concurrency}`);
  if (opts.limit) console.log(`Limit:       ${opts.limit}`);
  if (opts.resume) console.log('Resume:      yes');

  const eligible = planData.plan.filter((item) => {
    if (item.status === 'ready') return true;
    if (opts.includeMedium && item.status === 'needs_review' && item.risk === 'medium') return true;
    return false;
  });

  if (eligible.length === 0) {
    console.log('No eligible items for this run.');
    process.exit(0);
  }

  const blockedCount = planData.plan.filter((i) => i.status === 'blocked').length;
  if (blockedCount > 0 && opts.apply) {
    console.log(`Note: ${blockedCount} blocked items present — these are NEVER applied.`);
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
  const startIndex = progress.nextIndex;

  for (let i = startIndex; i < eligible.length; i++) {
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
      risk: item.risk,
      status: item.status,
      oldTitle: item.oldTitle,
      newTitle: item.newTitle,
      oldSeoTitle: item.oldSeoTitle,
      newSeoTitle: item.newSeoTitle,
      oldSeoDescription: item.oldSeoDescription,
      newSeoDescription: item.newSeoDescription,
      descriptionReplacement: item.descriptionReplacement,
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

    // Shopify-state check.
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

    // Compute description replacement based on what is currently in Shopify,
    // not what was exported, to avoid stomping if the description drifted.
    let newDescriptionHtml = null;
    if (item.descriptionReplacement) {
      newDescriptionHtml = applyDescriptionReplacement(
        currentProduct.descriptionHtml || '',
        item.descriptionReplacement,
      );
    }

    try {
      const result = await client.updateProductRename({
        productId: item.productId,
        newTitle: item.newTitle,
        newSeoTitle: item.newSeoTitle,
        newSeoDescription: item.newSeoDescription,
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

    // Concurrency note: we apply sequentially per product because each apply
    // includes a fetchProduct + mutation that must observe each other's
    // checkpoint. concurrency=2 here means we throttle to ~2 requests/sec.
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
  console.log('========== Apply summary ==========');
  console.log(`Mode:                  ${mode}`);
  console.log(`Eligible:              ${eligible.length}`);
  console.log(`Applied (success):     ${progress.counts.applied}`);
  console.log(`Failed:                ${progress.counts.failed}`);
  console.log(`Already applied:       ${progress.counts.already_applied}`);
  console.log(`Manual change detected:${progress.counts.manual_change_detected}`);
  console.log(`Dry-run logged:        ${progress.counts.dry_logged}`);
  console.log(`Next index:            ${progress.nextIndex} / ${eligible.length}`);
  console.log(`Blocked (never apply): ${blockedCount}`);
  console.log('===================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
