/**
 * Deterministic category → { type, tags } resolution.
 *
 * Ported from scripts/clean_b2bmarkt_import.py (normalize_category_mapping +
 * match_rule). Supports both map formats:
 *   - old:  { "<cat>": { type, tags } }
 *   - new:  { "<cat>": { default: {type,tags}, rules: [{match:[...],type,tags}] } }
 *
 * Rules are matched by case-insensitive substring against the product's
 * title + description (the same signal the Python cleaner used). No AI.
 */

import fs from 'node:fs/promises';

/** Load and parse a category-map JSON file. Returns {} if the file is absent. */
export async function loadCategoryMap(mapPath) {
  try {
    const raw = await fs.readFile(mapPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

/** Normalise one map entry to { default: {type,tags}, rules: [] }. */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if ('default' in raw) {
    return {
      default: raw.default || { type: '', tags: [] },
      rules: Array.isArray(raw.rules) ? raw.rules : [],
    };
  }
  if ('type' in raw || 'tags' in raw) {
    return { default: { type: raw.type || '', tags: raw.tags || [] }, rules: [] };
  }
  return null;
}

function matchRule(rules, text) {
  const haystack = text.toLowerCase();
  for (const rule of rules) {
    const patterns = Array.isArray(rule.match) ? rule.match : [];
    for (const pattern of patterns) {
      if (pattern && haystack.includes(String(pattern).toLowerCase())) {
        return rule;
      }
    }
  }
  return null;
}

/**
 * Resolve { type, tags, categoryKey, matched } for a product.
 *
 * @param {object} product   canonical product (has .categories[], .title, .description)
 * @param {object} categoryMap  parsed map JSON
 * @param {string|null} [forcedCategory] when the user picked one category, prefer it
 * @returns {{ type: string, tags: string[], categoryKey: string|null, mapped: boolean }}
 */
export function resolveCategory(product, categoryMap, forcedCategory = null) {
  const candidateKeys = [];
  if (forcedCategory) candidateKeys.push(forcedCategory);
  for (const c of product.categories || []) {
    if (c.text && !candidateKeys.includes(c.text)) candidateKeys.push(c.text);
  }

  let categoryKey = null;
  let entry = null;
  for (const key of candidateKeys) {
    const normalized = normalizeEntry(categoryMap[key]);
    if (normalized) {
      categoryKey = key;
      entry = normalized;
      break;
    }
  }

  if (!entry) {
    // Unmapped: fall back to the most specific category text as the Type.
    const fallbackText = candidateKeys[candidateKeys.length - 1] || '';
    return { type: fallbackText, tags: [], categoryKey: fallbackText || null, mapped: false };
  }

  const text = [product.title, product.description].filter(Boolean).join(' ');
  const rule = matchRule(entry.rules, text);
  const chosen = rule || entry.default;
  return {
    type: chosen.type || '',
    tags: Array.isArray(chosen.tags) ? chosen.tags.slice() : [],
    categoryKey,
    mapped: true,
  };
}
