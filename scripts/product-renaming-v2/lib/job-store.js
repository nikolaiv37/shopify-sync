/**
 * Job-folder layout and atomic read/write helpers for product-renaming V2.
 *
 * Each rename run lives in a single job folder under
 * logs/product-renaming/jobs/<jobId>/. Everything the pipeline needs to
 * resume, audit, or roll back is stored in that folder.
 *
 * Files in a job:
 *   job.json               — meta, filters, mutation policy, status
 *   export.json            — exported products + pagination cursor
 *   allocation-state.json  — persistent {category-model -> name} map
 *   plan.json              — per-item rename plan
 *   validation.json        — categorized validation outcome
 *   review-queue.csv       — flat human-readable queue
 *   apply-progress.json    — checkpoint: last applied index, counts
 *   apply-log.ndjson       — append-only per-product record
 *   rollback.json          — successfully-applied previous values
 *   failed.json            — apply failures
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join('logs', 'product-renaming', 'jobs');

export const FILES = {
  job: 'job.json',
  export: 'export.json',
  allocation: 'allocation-state.json',
  plan: 'plan.json',
  validation: 'validation.json',
  reviewQueue: 'review-queue.csv',
  readyCsv: 'ready.csv',
  needsReviewCsv: 'needs-review.csv',
  blockedCsv: 'blocked.csv',
  duplicatesCsv: 'duplicates.csv',
  applyProgress: 'apply-progress.json',
  applyLog: 'apply-log.ndjson',
  rollback: 'rollback.json',
  failed: 'failed.json',
};

export function jobDir(jobId) {
  return path.join(ROOT, jobId);
}

export function jobFilePath(jobId, key) {
  const filename = FILES[key] || key;
  return path.join(jobDir(jobId), filename);
}

export async function ensureJobDir(jobId) {
  await fs.mkdir(jobDir(jobId), { recursive: true });
}

export async function jobExists(jobId) {
  try {
    const s = await fs.stat(jobDir(jobId));
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function readJson(jobId, key) {
  try {
    const text = await fs.readFile(jobFilePath(jobId, key), 'utf-8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeJsonAtomic(jobId, key, value) {
  await ensureJobDir(jobId);
  const target = jobFilePath(jobId, key);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, target);
}

export async function writeTextAtomic(jobId, key, text) {
  await ensureJobDir(jobId);
  const target = jobFilePath(jobId, key);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, target);
}

export async function appendNdjson(jobId, key, obj) {
  await ensureJobDir(jobId);
  await fs.appendFile(jobFilePath(jobId, key), `${JSON.stringify(obj)}\n`);
}

export async function readNdjson(jobId, key) {
  try {
    const text = await fs.readFile(jobFilePath(jobId, key), 'utf-8');
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export async function listJobs() {
  try {
    return await fs.readdir(ROOT);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export function newJobId(category) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeCat = (category || 'all').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${ts}-${safeCat}`;
}

export async function updateJobStatus(jobId, patch) {
  const current = (await readJson(jobId, 'job')) || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(jobId, 'job', next);
  return next;
}

/**
 * Deterministic SHA256 hash of a job file's raw bytes on disk.
 * All job artifacts are written with writeJsonAtomic (JSON.stringify with
 * indent=2), so the byte stream is stable as long as the file is not edited
 * by hand. Returns null if the file does not exist.
 */
export async function hashJobFile(jobId, key) {
  try {
    const bytes = await fs.readFile(jobFilePath(jobId, key));
    return createHash('sha256').update(bytes).digest('hex');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export { ROOT as JOBS_ROOT };
