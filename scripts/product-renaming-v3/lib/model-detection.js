/**
 * Conservative old-model detection for V3.
 *
 * V3's job is much narrower than V1/V2: do NOT rebuild titles. Only detect
 * the old supplier/series name (almost always a Latin word like ENASTRON,
 * ELYSIA, PEGASUS, AURORA) and flag whether it can be safely replaced.
 *
 * Detection rules, in priority order:
 *   1. Tokens immediately following "серия" / "Series" / "series" — these
 *      are unambiguously the model name.
 *   2. Latin words that look like supplier model names (length 3..30, no
 *      digits-only, not in BANNED/MATERIAL sets), boosted if in the V1
 *      KNOWN_MODEL_NAMES set.
 *   3. Cyrillic ALL-CAPS words (4+ letters) like АНДРОМЕДА — rare but
 *      occasionally appears in transliterated supplier titles.
 *
 * Detection NEVER returns:
 *   - A V3 controlled name (Protection B — the product is already renamed).
 *   - A material/color/furniture-type word.
 *   - A pure-numeric or dimensional token (90x200).
 *
 * If two or more equally-confident Latin candidates exist that disagree on
 * which is the "real" model, the result is { detected: null, ambiguous: true }
 * and the caller routes the item to needs_review.
 */

import {
  BANNED_MODEL_WORDS,
  KNOWN_MODEL_NAMES,
  MATERIAL_FABRIC_WORDS,
} from '../../product-renaming/name-dictionaries.js';
import {
  V3_COMMON_NAME_EXCLUSIONS,
  V3_CONTROLLED_NAMES,
  V3_DICTIONARIES,
  V3_FURNITURE_PREFIXES,
} from './dictionaries.js';

const SERIES_KEYWORDS = ['серия', 'Серия', 'series', 'Series', 'SERIES'];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLatinWord(w) {
  return /^[A-Za-z][A-Za-z0-9.\-]{1,29}$/.test(w);
}

function isCyrillicAllCaps(w) {
  return /^[А-ЯЁ]{4,30}$/.test(w);
}

function isPureDigits(w) {
  return /^\d+$/.test(w) || /^\d+x\d+$/i.test(w) || /^\d+мм$/i.test(w);
}

function isBanned(w) {
  return BANNED_MODEL_WORDS.has(w) || BANNED_MODEL_WORDS.has(w.toLowerCase());
}

function isMaterial(w) {
  return MATERIAL_FABRIC_WORDS.has(w.toLowerCase());
}

function isControlled(w) {
  return V3_CONTROLLED_NAMES.has(w);
}

function tokenize(title) {
  if (!title) return [];
  return title
    .replace(/[(),.:;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Protection A: title starts with "<furniture prefix> <controlled name>".
 * Returns { matched: true, prefix, name } or { matched: false }.
 */
export function isAlreadyRenamedByPrefix(title) {
  if (!title) return { matched: false };
  const trimmed = title.trim();
  // Sort prefixes longest-first so "Градински трапезен комплект" beats
  // "Градински комплект" when both could match the start of the title.
  const sortedPrefixes = [...V3_FURNITURE_PREFIXES].sort((a, b) => b.length - a.length);
  for (const prefix of sortedPrefixes) {
    for (const name of V3_CONTROLLED_NAMES) {
      const re = new RegExp(`^${escapeRegex(prefix)}\\s+${escapeRegex(name)}(\\b|\\s|–|-|,|\\(|$)`, 'i');
      if (re.test(trimmed)) return { matched: true, prefix, name };
    }
  }
  return { matched: false };
}

/**
 * Protection B: a controlled V3 name appears inside the title body without
 * the canonical furniture prefix. Catches manually-renamed products like
 *   "Комплект градински мебели Аурора 4 части ..."
 * which clearly contain one of OUR names but don't start with a recognized
 * prefix.
 *
 * Conservative on purpose:
 *   - When `category` is provided, only that category's dictionary is
 *     consulted. So `Нова` from the tables dictionary will not flag a
 *     garden product, and vice versa.
 *   - Common/everyday names (Нова, Елит, Класика, Роял, Аура, Кристал,
 *     Астра, Вега, Сити, Прима, Оптимал) are EXCLUDED from body-only
 *     matching because they appear in ordinary supplier titles
 *     (e.g. "Нова градинска маса" is not "already renamed").
 *   - When `category` is not provided, the union of all dictionaries minus
 *     the exclusion set is used.
 *
 * Protection A (prefix + name) is still allowed to use the full
 * V3_CONTROLLED_NAMES set including common names, because the strong
 * furniture prefix carries the disambiguation.
 */
export function isAlreadyRenamedByControlledName(title, category = null) {
  if (!title) return { matched: false };
  const dict = category && V3_DICTIONARIES[category]
    ? V3_DICTIONARIES[category]
    : Array.from(V3_CONTROLLED_NAMES);
  const candidates = new Set(dict.filter((n) => !V3_COMMON_NAME_EXCLUSIONS.has(n)));
  if (candidates.size === 0) return { matched: false };

  const tokens = tokenize(title);
  for (const t of tokens) {
    const cleaned = t.replace(/[,.:;()]/g, '');
    if (candidates.has(cleaned)) {
      return { matched: true, name: cleaned, category: category || null };
    }
  }
  return { matched: false };
}

/**
 * Detect the old model name to replace.
 *
 * Returns:
 *   { detected: string, source: 'series' | 'latin' | 'cyrillic_caps', knownModel: bool }
 *   { detected: null, ambiguous: true, candidates: string[] }
 *   { detected: null, ambiguous: false }
 */
export function detectOldModel(title) {
  const tokens = tokenize(title);
  if (tokens.length === 0) return { detected: null, ambiguous: false };

  // Rule 1 — "серия X" / "Series X". The word(s) immediately after the keyword
  // are the model. We accept the next 1..2 tokens that look like a model.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!SERIES_KEYWORDS.includes(tokens[i])) continue;
    const next = tokens[i + 1].replace(/[,.:;()]/g, '');
    if (!next) continue;
    if (isControlled(next)) return { detected: null, ambiguous: false };
    if (isLatinWord(next) && !isMaterial(next) && !isPureDigits(next) && !isBanned(next)) {
      return { detected: next, source: 'series', knownModel: KNOWN_MODEL_NAMES.has(next) };
    }
    if (isCyrillicAllCaps(next)) {
      return { detected: next, source: 'series', knownModel: false };
    }
  }

  // Rule 2 — Latin candidates.
  const latinCandidates = [];
  for (const t of tokens) {
    const w = t.replace(/[,.:;()]/g, '');
    if (!w || w.length < 3) continue;
    if (!isLatinWord(w)) continue;
    if (isPureDigits(w)) continue;
    if (isBanned(w)) continue;
    if (isMaterial(w)) continue;
    // Already-renamed protection: a controlled name should not be detected
    // as the old model. Caller checks this earlier too, but be defensive.
    if (isControlled(w)) continue;
    const score = KNOWN_MODEL_NAMES.has(w) ? 20 : 10;
    latinCandidates.push({ word: w, score });
  }
  if (latinCandidates.length > 0) {
    // Deduplicate while preserving first occurrence.
    const seen = new Set();
    const unique = [];
    for (const c of latinCandidates) {
      if (seen.has(c.word.toLowerCase())) continue;
      seen.add(c.word.toLowerCase());
      unique.push(c);
    }
    unique.sort((a, b) => b.score - a.score);
    if (unique.length === 1) {
      return { detected: unique[0].word, source: 'latin', knownModel: unique[0].score === 20 };
    }
    // 2+ unique latin candidates — only safe if exactly one is a known model.
    const known = unique.filter((c) => c.score === 20);
    if (known.length === 1) {
      return { detected: known[0].word, source: 'latin', knownModel: true };
    }
    return { detected: null, ambiguous: true, candidates: unique.map((c) => c.word) };
  }

  // Rule 3 — Cyrillic ALL-CAPS like АНДРОМЕДА.
  for (const t of tokens) {
    const w = t.replace(/[,.:;()]/g, '');
    if (isCyrillicAllCaps(w) && !isBanned(w) && !isControlled(w)) {
      return { detected: w, source: 'cyrillic_caps', knownModel: false };
    }
  }

  return { detected: null, ambiguous: false };
}
