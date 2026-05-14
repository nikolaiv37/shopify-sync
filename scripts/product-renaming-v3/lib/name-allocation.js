/**
 * Persistent name allocation per (category, old-model) for V3.
 *
 * Same allocation guarantee as V2: the same old model in the same category
 * always maps to the same new V3 controlled name within a job. The state
 * lives in the job folder (allocation-state.json) so re-running plan-job
 * yields a deterministic plan.
 */

import { getV3Dictionary } from './dictionaries.js';
import { readJson, writeJsonAtomic } from './job-store.js';

export async function loadAllocation(jobId) {
  const data = (await readJson(jobId, 'allocation')) || {};
  return {
    keyToName: data.keyToName || {},
    usedByCategory: data.usedByCategory || {},
    nextIndex: data.nextIndex || {},
  };
}

export async function saveAllocation(jobId, alloc) {
  await writeJsonAtomic(jobId, 'allocation', {
    updatedAt: new Date().toISOString(),
    ...alloc,
  });
}

function key(category, oldModel) {
  return `${category || 'generic'}::${(oldModel || 'unknown').toLowerCase()}`;
}

/**
 * Return the new V3 controlled name for (category, oldModel). Allocates one
 * from the dictionary if this (category, oldModel) pair is new, then
 * persists in `alloc` (caller saves).
 *
 * Names are allocated round-robin across the dictionary; if every name has
 * been used, falls back to "<base> 2", "<base> 3", ... (this is rare — the
 * dictionaries are larger than typical per-job model counts).
 */
export function allocateName(alloc, category, oldModel) {
  const k = key(category, oldModel);
  if (alloc.keyToName[k]) return alloc.keyToName[k];

  const dict = getV3Dictionary(category);
  const used = new Set(alloc.usedByCategory[category] || []);
  let idx = alloc.nextIndex[category] || 0;

  let chosen = null;
  for (let tries = 0; tries < dict.length; tries++) {
    const candidate = dict[idx % dict.length];
    idx++;
    if (!used.has(candidate)) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen) {
    const base = dict[(alloc.nextIndex[category] || 0) % dict.length];
    let suffix = 2;
    while (used.has(`${base} ${suffix}`)) suffix++;
    chosen = `${base} ${suffix}`;
    idx = (alloc.nextIndex[category] || 0) + 1;
  }

  used.add(chosen);
  alloc.keyToName[k] = chosen;
  alloc.usedByCategory[category] = Array.from(used);
  alloc.nextIndex[category] = idx;
  return chosen;
}
