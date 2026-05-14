#!/usr/bin/env node
/**
 * Validate the V3 job plan and emit categorized CSV outputs.
 *
 * READ-ONLY. No mutations.
 *
 * Re-runs lib/validation.js per item and adds a second-pass duplicate check:
 * if two ready items would produce the same new title, both are demoted to
 * needs_review with reason "duplicate_new_title" — V3 does not auto-suffix.
 */

import {
  hashJobFile,
  jobDir,
  jobExists,
  readJson,
  updateJobStatus,
  writeJsonAtomic,
  writeTextAtomic,
} from './lib/job-store.js';
import { decide } from './lib/validation.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { job: null };
  for (const a of args) {
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
  }
  return opts;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','));
  return `${header}\n${lines.join('\n')}\n`;
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

  const job = await readJson(opts.job, 'job');
  const planData = await readJson(opts.job, 'plan');
  if (!planData?.plan) {
    console.error('ERROR: plan.json missing. Run rename:v3:plan first.');
    process.exit(1);
  }

  // First pass: re-decide every item (parity check with plan-job).
  const items = planData.plan.map((p) => {
    const item = { ...p };
    const recomputed = decide(item);
    Object.assign(item, recomputed);
    return item;
  });

  // Duplicate-title detection across ready items only.
  const titleCounts = new Map();
  for (const item of items) {
    if (item.status === 'ready' && item.newTitle) {
      titleCounts.set(item.newTitle, (titleCounts.get(item.newTitle) || 0) + 1);
    }
  }
  const duplicateTitles = new Map();
  for (const [t, c] of titleCounts) if (c > 1) duplicateTitles.set(t, c);

  for (const item of items) {
    if (item.status === 'ready' && duplicateTitles.has(item.newTitle)) {
      item.status = 'needs_review';
      item.mutationAllowed = false;
      item.reasons = [...(item.reasons || []), 'duplicate_new_title'];
    }
  }

  const buckets = {
    ready: [], needs_review: [], blocked: [],
    skipped_already_renamed: [], skipped_no_model: [],
  };
  for (const item of items) {
    (buckets[item.status] || (buckets[item.status] = [])).push(item);
  }

  const exportHash = await hashJobFile(opts.job, 'export');
  const planHash = await hashJobFile(opts.job, 'plan');

  const counts = Object.fromEntries(
    Object.entries(buckets).map(([k, v]) => [k, v.length]),
  );
  counts.total = items.length;

  const validation = {
    jobId: opts.job,
    pipelineVersion: 'v3',
    timestamp: new Date().toISOString(),
    exportHash,
    planHash,
    exportFilters: planData.exportFilters || null,
    jobFilters: planData.jobFilters || null,
    categoryOverride: planData.categoryOverride || null,
    counts,
    duplicates: Array.from(duplicateTitles.entries()).map(([title, count]) => ({ title, count })),
    canApply: buckets.ready.length > 0,
    // Source of truth for apply-job. Includes the duplicate-title demotions
    // applied above — apply-job MUST read items from here, never from
    // plan.json directly, otherwise demoted duplicates could be applied.
    items,
  };

  await writeJsonAtomic(opts.job, 'validation', validation);

  // CSVs.
  const shapeCommon = (item) => ({
    handle: item.handle,
    productId: item.productId,
    detectedCategory: item.detectedCategory,
    oldModel: item.oldModel,
    newModel: item.newModel,
    oldTitle: item.oldTitle,
    newTitle: item.newTitle,
    productType: item.productType,
    seoTitle: item.oldSeoTitle,
    changedFields: (item.changedFields || []).join('; '),
    replacementCounts: JSON.stringify(item.replacementCounts || {}),
    reasons: (item.reasons || []).join('; '),
  });

  await writeTextAtomic(
    opts.job,
    'readyCsv',
    toCsv(buckets.ready.map(shapeCommon), [
      'handle', 'oldModel', 'newModel', 'oldTitle', 'newTitle', 'changedFields', 'replacementCounts',
    ]),
  );
  await writeTextAtomic(
    opts.job,
    'skippedAlreadyRenamedCsv',
    toCsv(buckets.skipped_already_renamed.map(shapeCommon), [
      'handle', 'oldTitle', 'reasons',
    ]),
  );
  await writeTextAtomic(
    opts.job,
    'skippedNoModelCsv',
    toCsv(buckets.skipped_no_model.map(shapeCommon), [
      'handle', 'oldTitle', 'productType', 'seoTitle', 'reasons',
    ]),
  );
  await writeTextAtomic(
    opts.job,
    'needsReviewCsv',
    toCsv(buckets.needs_review.map(shapeCommon), [
      'handle', 'oldTitle', 'newTitle', 'oldModel', 'newModel', 'reasons',
    ]),
  );
  await writeTextAtomic(
    opts.job,
    'blockedCsv',
    toCsv(buckets.blocked.map(shapeCommon), [
      'handle', 'oldTitle', 'reasons',
    ]),
  );

  const validationHash = await hashJobFile(opts.job, 'validation');
  await updateJobStatus(opts.job, {
    status: 'validated',
    phase: { ...(job.phase || {}), validated: true },
    validationSummary: {
      ...counts,
      duplicates: duplicateTitles.size,
      canApply: validation.canApply,
      exportHash,
      planHash,
      validationHash,
      validatedAt: new Date().toISOString(),
    },
  });

  console.log();
  console.log('========== V3 Validation complete ==========');
  console.log(`Total:                       ${items.length}`);
  console.log(`Ready:                       ${counts.ready}`);
  console.log(`Needs review:                ${counts.needs_review}`);
  console.log(`Blocked:                     ${counts.blocked}`);
  console.log(`Skipped (already renamed):   ${counts.skipped_already_renamed}`);
  console.log(`Skipped (no model):          ${counts.skipped_no_model}`);
  console.log(`Duplicate new titles:        ${duplicateTitles.size}`);
  console.log(`canApply:                    ${validation.canApply}`);
  console.log('============================================');
  console.log();
  console.log(`Next: npm run rename:v3:apply -- --job=${opts.job} --dry-run --limit=20`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
