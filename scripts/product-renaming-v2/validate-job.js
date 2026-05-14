#!/usr/bin/env node
/**
 * Validate the V2 job plan and emit categorized CSV outputs.
 *
 * READ-ONLY. No mutations.
 *
 * Usage:
 *   node scripts/product-renaming-v2/validate-job.js --job=<jobId>
 *   node scripts/product-renaming-v2/validate-job.js --job=<jobId> --approve-medium
 *
 * Writes:
 *   validation.json
 *   ready.csv
 *   needs-review.csv
 *   blocked.csv
 *   duplicates.csv
 *   review-queue.csv (alias of needs-review.csv for convenience)
 *
 * Blocks apply if:
 *   - any 'ready' item has a hard quality failure, or
 *   - any duplicate new title appears among 'ready' items.
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
import { PATTERN_QUALITY_REASONS, decide, hardQualityFailures } from './lib/quality-gates.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { job: null, approveMedium: false };
  for (const a of args) {
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else if (a === '--approve-medium') opts.approveMedium = true;
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
    console.error('ERROR: plan.json missing. Run rename:v2:plan first.');
    process.exit(1);
  }

  const plan = planData.plan;

  const ready = [];
  const needsReview = [];
  const blocked = [];
  const skipped = [];

  const titleCounts = new Map();
  for (const item of plan) {
    if (item.status === 'ready' && item.newTitle) {
      titleCounts.set(item.newTitle, (titleCounts.get(item.newTitle) || 0) + 1);
    }
  }

  const duplicateTitles = new Map();
  for (const [t, c] of titleCounts) if (c > 1) duplicateTitles.set(t, c);

  // Recompute decision for each item to confirm parity with quality-gates.
  for (const rawItem of plan) {
    const item = { ...rawItem };
    const recomputed = decide(item);
    Object.assign(item, recomputed);

    const failures = hardQualityFailures(item);
    item.hardQualityFailures = failures;

    if (item.status === 'ready' && duplicateTitles.has(item.newTitle)) {
      item.status = 'blocked';
      item.blockReasons = [...(item.blockReasons || []), 'duplicate_unresolved'];
      item.mutationAllowed = false;
    }

    if (item.status === 'ready' && failures.length > 0) {
      item.status = 'blocked';
      item.blockReasons = [...(item.blockReasons || []), ...failures];
      item.mutationAllowed = false;
    }

    if (opts.approveMedium && item.status === 'needs_review' && item.risk === 'medium') {
      item.mediumApproved = true;
    }

    if (item.status === 'ready') ready.push(item);
    else if (item.status === 'needs_review') needsReview.push(item);
    else if (item.status === 'blocked') blocked.push(item);
    else if (item.status === 'skipped') skipped.push(item);
  }

  const exportHash = await hashJobFile(opts.job, 'export');
  const planHash = await hashJobFile(opts.job, 'plan');

  // Tally pattern-based quality reasons across needs_review items.
  const qualityReasonCounts = Object.fromEntries(PATTERN_QUALITY_REASONS.map((r) => [r, 0]));
  for (const item of needsReview) {
    const reasons = new Set(item.reviewReasons || []);
    for (const r of PATTERN_QUALITY_REASONS) {
      if (reasons.has(r)) qualityReasonCounts[r]++;
    }
  }

  const hardBlockers = blocked.filter((i) => (i.blockReasons || []).some(
    (r) => r === 'duplicate_unresolved' || /handle is empty|title is empty/.test(r),
  )).length;

  const validation = {
    jobId: opts.job,
    timestamp: new Date().toISOString(),
    exportHash,
    planHash,
    exportFilters: planData.exportFilters || null,
    jobFilters: planData.jobFilters || null,
    categoryOverride: planData.categoryOverride || null,
    counts: {
      total: plan.length,
      ready: ready.length,
      needs_review: needsReview.length,
      blocked: blocked.length,
      skipped: skipped.length,
    },
    duplicates: Array.from(duplicateTitles.entries()).map(([title, count]) => ({ title, count })),
    qualityReasonCounts,
    approveMedium: opts.approveMedium,
    // canApply is informational; apply-job re-checks blocked/ready and hashes.
    canApply: ready.length > 0 && hardBlockers === 0,
    hardBlockers,
  };

  await writeJsonAtomic(opts.job, 'validation', validation);

  const csvCols = [
    'handle', 'productId', 'risk', 'status',
    'detectedCategory', 'detectedOldModelName', 'newCollectionName',
    'oldTitle', 'newTitle', 'reasons', 'blockReasons', 'reviewReasons',
  ];

  function shape(item) {
    return {
      ...item,
      reasons: (item.reasons || []).join('; '),
      blockReasons: (item.blockReasons || []).join('; '),
      reviewReasons: (item.reviewReasons || []).join('; '),
    };
  }

  await writeTextAtomic(opts.job, 'readyCsv', toCsv(ready.map(shape), csvCols));
  await writeTextAtomic(opts.job, 'needsReviewCsv', toCsv(needsReview.map(shape), csvCols));
  await writeTextAtomic(opts.job, 'blockedCsv', toCsv(blocked.map(shape), csvCols));
  await writeTextAtomic(opts.job, 'reviewQueue', toCsv(needsReview.map(shape), csvCols));

  const duplicateRows = Array.from(duplicateTitles.entries()).flatMap(([title, count]) =>
    ready
      .filter((i) => i.newTitle === title)
      .map((i) => ({ title, count, handle: i.handle, productId: i.productId })),
  );
  await writeTextAtomic(
    opts.job,
    'duplicatesCsv',
    toCsv(duplicateRows, ['title', 'count', 'handle', 'productId']),
  );

  const validationHash = await hashJobFile(opts.job, 'validation');
  await updateJobStatus(opts.job, {
    status: 'validated',
    phase: { ...(job.phase || {}), validated: true },
    validationSummary: {
      ...validation.counts,
      duplicates: duplicateTitles.size,
      approveMedium: opts.approveMedium,
      canApply: validation.canApply,
      exportHash,
      planHash,
      validationHash,
      validatedAt: new Date().toISOString(),
    },
  });

  console.log();
  console.log('========== Validation complete ==========');
  console.log(`Total:        ${plan.length}`);
  console.log(`Ready:        ${ready.length}`);
  console.log(`Needs review: ${needsReview.length}`);
  console.log(`Blocked:      ${blocked.length}`);
  console.log(`Skipped:      ${skipped.length}`);
  console.log(`Duplicates:   ${duplicateTitles.size}`);
  const totalPattern = Object.values(qualityReasonCounts).reduce((a, b) => a + b, 0);
  if (totalPattern > 0) {
    console.log('--- Quality reasons in needs_review ---');
    for (const r of PATTERN_QUALITY_REASONS) {
      if (qualityReasonCounts[r] > 0) console.log(`  ${r.padEnd(34)} ${qualityReasonCounts[r]}`);
    }
  }
  if (opts.approveMedium) console.log('Medium-risk items APPROVED for apply.');
  console.log('==========================================');
  console.log();
  console.log(`Next: npm run rename:v2:apply -- --job=${opts.job} --dry-run`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
