/**
 * Apply-job checkpoint and append-only log for V3.
 *
 * Same shape as V2: apply-progress.json is rewritten after every product so
 * a crashed run resumes from nextIndex; apply-log.ndjson is append-only and
 * is the audit source of truth; rollback.json accumulates only previous
 * values of products that were successfully mutated by a real --apply.
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
