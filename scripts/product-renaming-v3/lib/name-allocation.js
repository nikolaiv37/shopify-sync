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
    // Per-category list of names that were generated as "<base> 2",
    // "<base> 3", ... because the dictionary was exhausted. Used for
    // dictionary-capacity reporting in plan-job and status-job.
    fallbacksByCategory: data.fallbacksByCategory || {},
    // Per-key boolean: was this allocation a fallback? Lets plan-job stamp
    // each item with fallbackAllocated without recomputing.
    fallbackByKey: data.fallbackByKey || {},
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
 * Return the new V3 controlled name for (category, oldModel) along with a
 * fallbackAllocated flag indicating whether the name was generated as a
 * "<base> 2" suffix because the category dictionary was exhausted.
 *
 * Returns: { name, fallbackAllocated }
 *
 * Allocations are persisted on `alloc` in-place; caller saves.
 */
export function allocateName(alloc, category, oldModel) {
  const k = key(category, oldModel);
  if (alloc.keyToName[k]) {
    return {
      name: alloc.keyToName[k],
      fallbackAllocated: !!(alloc.fallbackByKey && alloc.fallbackByKey[k]),
    };
  }

  const dict = getV3Dictionary(category);
  const used = new Set(alloc.usedByCategory[category] || []);
  let idx = alloc.nextIndex[category] || 0;
  let fallbackAllocated = false;

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
    fallbackAllocated = true;
  }

  used.add(chosen);
  alloc.keyToName[k] = chosen;
  alloc.usedByCategory[category] = Array.from(used);
  alloc.nextIndex[category] = idx;

  if (fallbackAllocated) {
    alloc.fallbackByKey = alloc.fallbackByKey || {};
    alloc.fallbackByKey[k] = true;
    alloc.fallbacksByCategory = alloc.fallbacksByCategory || {};
    alloc.fallbacksByCategory[category] = alloc.fallbacksByCategory[category] || [];
    if (!alloc.fallbacksByCategory[category].includes(chosen)) {
      alloc.fallbacksByCategory[category].push(chosen);
    }
  }

  return { name: chosen, fallbackAllocated };
}
