/**
 * Persistent name allocation per (category, old-model) key.
 *
 * V1 picked a new dictionary name by an incrementing in-memory index. That is
 * not stable across runs and not stable across resumed exports. V2 keeps a
 * persisted map inside the job folder so:
 *
 *  - The same old model in the same category always maps to the same new name
 *    within a job (even if planning is re-run, or run in multiple passes).
 *  - Unknown-model items get a deterministic "unknown" slot per category.
 *  - Duplicate new titles (same category+name but different old model) are
 *    disambiguated by allocating the next free dictionary name first, falling
 *    back to a numeric suffix if the dictionary is exhausted.
 */

import { getDictionaryForCategory } from '../../product-renaming/name-dictionaries.js';
import { readJson, writeJsonAtomic } from './job-store.js';

export async function loadAllocation(jobId) {
  const data = (await readJson(jobId, 'allocation')) || {};
  return {
    // { "garden::Pacific": "Аурора" }
    keyToName: data.keyToName || {},
    // { garden: ["Аурора", "Ривиера"] } — names already used per category
    usedByCategory: data.usedByCategory || {},
    // { garden: 2 } — next dictionary index to try for that category
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
 * Return the new dictionary name for (category, oldModel), allocating one
 * if needed. Mutates `alloc` in-place. Caller is responsible for persisting.
 */
export function allocateName(alloc, category, oldModel) {
  const k = key(category, oldModel);
  if (alloc.keyToName[k]) return alloc.keyToName[k];

  const dict = getDictionaryForCategory(category);
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
    // Dictionary fully consumed — wrap with numeric suffix.
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

/**
 * Allocate a stable disambiguation suffix for duplicate new titles.
 * The suffix is derived from the product (pieces / color / material) when
 * possible, otherwise a numeric counter. Mutates `titleUseCounts` in place.
 */
export function disambiguateTitle(newTitle, productTitle, titleUseCounts) {
  const used = titleUseCounts.get(newTitle) || 0;
  if (used === 0) {
    titleUseCounts.set(newTitle, 1);
    return newTitle;
  }

  const piecesMatch = productTitle?.match(/(\d+\s*части)/i);
  const colorMatch = productTitle?.match(
    /\b(бежов|сив|черен|бял|кафяв|екрю|кремав|тъмносив|светлосив|антрацит|капучино)\b/i,
  );
  const materialMatch = productTitle?.match(
    /\b(алуминий|дърво|акация|дъб|метал|ратан|полипропилен|бук|стъкло)\b/i,
  );

  const suffixes = [];
  if (piecesMatch) suffixes.push(piecesMatch[1]);
  if (colorMatch) suffixes.push(colorMatch[1]);
  if (materialMatch) suffixes.push(materialMatch[1]);

  if (suffixes.length > 0) {
    const candidate = `${newTitle} (${suffixes.join(', ')})`;
    const candidateUsed = titleUseCounts.get(candidate) || 0;
    if (candidateUsed === 0) {
      titleUseCounts.set(candidate, 1);
      titleUseCounts.set(newTitle, used + 1);
      return candidate;
    }
  }

  let counter = 2;
  while (titleUseCounts.has(`${newTitle} (${counter})`)) counter++;
  const fallback = `${newTitle} (${counter})`;
  titleUseCounts.set(fallback, 1);
  titleUseCounts.set(newTitle, used + 1);
  return fallback;
}
