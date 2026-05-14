#!/usr/bin/env node
/**
 * Show the current status of a V3 job (or list V3 jobs).
 *
 * READ-ONLY. No Shopify calls.
 *
 * Usage:
 *   node scripts/product-renaming-v3/status-job.js --job=<jobId>
 *   node scripts/product-renaming-v3/status-job.js --list
 */

import {
  hashJobFile,
  jobDir,
  jobExists,
  listJobs,
  readJson,
  readNdjson,
} from './lib/job-store.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { job: null, list: false };
  for (const a of args) {
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else if (a === '--list') opts.list = true;
  }
  return opts;
}

function pad(label, value) {
  return `${(label + ':').padEnd(32)}${value}`;
}

function hashLine(label, expected, current) {
  if (!expected && !current) return pad(label, '(not yet generated)');
  if (!expected) return pad(label, `${current?.slice(0, 12)}... (no expected)`);
  if (!current) return pad(label, `MISSING (expected ${expected.slice(0, 12)}...)`);
  const match = expected === current;
  return pad(label, `${match ? 'MATCH' : 'MISMATCH'}  current=${current.slice(0, 12)}  recorded=${expected.slice(0, 12)}`);
}

async function showOne(jobId) {
  if (!(await jobExists(jobId))) {
    console.error(`ERROR: Job folder does not exist: ${jobDir(jobId)}`);
    process.exit(1);
  }

  const job = await readJson(jobId, 'job');
  const exportData = await readJson(jobId, 'export');
  const planData = await readJson(jobId, 'plan');
  const validation = await readJson(jobId, 'validation');
  const progress = await readJson(jobId, 'applyProgress');
  const rollback = await readJson(jobId, 'rollback');
  const failed = await readJson(jobId, 'failed');
  const applyLog = await readNdjson(jobId, 'applyLog');

  const exported = exportData?.totalExported || 0;
  const planCounts = planData?.counts || {};
  const ready = planCounts.ready || 0;
  const needsReview = planCounts.needs_review || 0;
  const blocked = planCounts.blocked || 0;
  const skippedAlready = planCounts.skipped_already_renamed || 0;
  const skippedNoModel = planCounts.skipped_no_model || 0;

  const applied = progress?.counts?.applied || 0;
  const failures = progress?.counts?.failed || (failed?.items?.length || 0);
  const alreadyApplied = progress?.counts?.already_applied || 0;
  const manualChange = progress?.counts?.manual_change_detected || 0;
  const dryLogged = progress?.counts?.dry_logged || 0;
  const rollbackCount = rollback?.rollbackItems?.length || 0;

  const currentExportHash = await hashJobFile(jobId, 'export');
  const currentPlanHash = await hashJobFile(jobId, 'plan');
  const currentValidationHash = await hashJobFile(jobId, 'validation');

  const planExpectedExportHash = planData?.exportHash || null;
  const validationExpectedExportHash = validation?.exportHash || null;
  const validationExpectedPlanHash = validation?.planHash || null;

  console.log();
  console.log(`========== V3 Job ${jobId} ==========`);
  console.log(pad('Job ID', jobId));
  console.log(pad('Folder', jobDir(jobId)));
  console.log(pad('Status', job?.status || '(unknown)'));
  console.log(pad('Created', job?.createdAt || '(unknown)'));
  console.log(pad('Updated', job?.updatedAt || '(unknown)'));
  console.log();
  console.log('--- Filters ---');
  console.log(pad('Category', job?.filters?.category || '(auto)'));
  console.log(pad('Query', job?.filters?.query || '(none)'));
  console.log(pad('Vendor', job?.filters?.vendor || '(any)'));
  console.log(pad('Status filter', job?.filters?.status || '(none)'));
  console.log(pad('Limit', job?.filters?.limit ?? '(none)'));
  console.log();
  console.log('--- Export ---');
  console.log(pad('exported (count)', exported));
  console.log();
  console.log('--- Plan counts ---');
  console.log(pad('planned', planData?.totalItems || 0));
  console.log(pad('ready', ready));
  console.log(pad('needs_review', needsReview));
  console.log(pad('blocked', blocked));
  console.log(pad('skipped_already_renamed', skippedAlready));
  console.log(pad('skipped_no_model', skippedNoModel));
  console.log();
  console.log('--- Validation ---');
  console.log(pad('canApply', validation?.canApply == null ? '(no validation)' : String(validation.canApply)));
  console.log(pad('duplicate titles', validation?.duplicates?.length || 0));
  console.log();
  console.log('--- Apply counts ---');
  console.log(pad('applied', applied));
  console.log(pad('failed', failures));
  console.log(pad('already_applied', alreadyApplied));
  console.log(pad('manual_change_detected', manualChange));
  console.log(pad('dry_logged', dryLogged));
  console.log(pad('rollback items recorded', rollbackCount));
  if (progress) {
    console.log(pad('apply batchId', progress.batchId));
    console.log(pad('nextIndex / total', `${progress.nextIndex} / ${progress.totalEligible}`));
  }
  console.log();
  console.log('--- Hash integrity ---');
  console.log(hashLine('export.json (plan ref)', planExpectedExportHash, currentExportHash));
  console.log(hashLine('export.json (val ref)', validationExpectedExportHash, currentExportHash));
  console.log(hashLine('plan.json (val ref)', validationExpectedPlanHash, currentPlanHash));
  console.log(pad('validation.json hash', currentValidationHash ? `${currentValidationHash.slice(0, 12)}...` : '(not yet generated)'));
  const allMatch = (!planExpectedExportHash || planExpectedExportHash === currentExportHash)
    && (!validationExpectedExportHash || validationExpectedExportHash === currentExportHash)
    && (!validationExpectedPlanHash || validationExpectedPlanHash === currentPlanHash);
  console.log(pad('All hashes match?', allMatch ? 'YES' : 'NO — re-run plan & validate before apply'));
  console.log();
  if (applyLog.length > 0) {
    const last = applyLog[applyLog.length - 1];
    console.log('--- Last apply-log entry ---');
    console.log(`  ${last.timestamp}  ${last.handle}  ${last.mutationStatus}`);
    console.log();
  }
  console.log('======================================');
}

async function showList() {
  const jobs = await listJobs();
  if (jobs.length === 0) {
    console.log('No V3 jobs found.');
    return;
  }
  console.log();
  console.log('V3 jobs (most recent first):');
  for (const id of jobs.sort().reverse()) {
    const job = await readJson(id, 'job');
    console.log(`  ${id.padEnd(50)} ${job?.status || '(unknown)'}`);
  }
  console.log();
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.list) return showList();
  if (!opts.job) {
    console.error('ERROR: --job=<jobId> or --list is required.');
    process.exit(1);
  }
  return showOne(opts.job);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
