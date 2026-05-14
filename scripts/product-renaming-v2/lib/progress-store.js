/**
 * Apply-job checkpoint and append-only log.
 *
 * apply-progress.json is rewritten after every product, so a crashed run
 * can resume from the next index. apply-log.ndjson is append-only — one
 * line per product attempt — and is the source of truth for the audit.
 * rollback.json accumulates only the previous values of products that were
 * actually mutated successfully (and only on real --apply, never --dry-run).
 */

import { appendNdjson, readJson, writeJsonAtomic } from './job-store.js';

const PROGRESS_KEY = 'applyProgress';

export async function loadProgress(jobId) {
  return (await readJson(jobId, PROGRESS_KEY)) || null;
}

export async function initProgress(jobId, batchId, totalEligible) {
  const progress = {
    batchId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalEligible,
    nextIndex: 0,
    counts: {
      applied: 0,
      failed: 0,
      skipped: 0,
      already_applied: 0,
      manual_change_detected: 0,
      dry_logged: 0,
    },
  };
  await writeJsonAtomic(jobId, PROGRESS_KEY, progress);
  return progress;
}

export async function saveProgress(jobId, progress) {
  progress.updatedAt = new Date().toISOString();
  await writeJsonAtomic(jobId, PROGRESS_KEY, progress);
}

export async function logApplyEntry(jobId, entry) {
  await appendNdjson(jobId, 'applyLog', entry);
}

export async function loadRollback(jobId) {
  return (await readJson(jobId, 'rollback')) || { rollbackItems: [] };
}

export async function appendRollbackItem(jobId, item) {
  const current = await loadRollback(jobId);
  current.rollbackItems.push(item);
  current.updatedAt = new Date().toISOString();
  await writeJsonAtomic(jobId, 'rollback', current);
}

export async function loadFailed(jobId) {
  return (await readJson(jobId, 'failed')) || { items: [] };
}

export async function appendFailedItem(jobId, item) {
  const current = await loadFailed(jobId);
  current.items.push(item);
  current.updatedAt = new Date().toISOString();
  await writeJsonAtomic(jobId, 'failed', current);
}
