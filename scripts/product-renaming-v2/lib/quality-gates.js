/**
 * Deterministic quality gates and already-renamed detection for V2.
 *
 * Ported from V1's validate-rename-plan.js so plan-job and validate-job share
 * the same rules. Any AI fallback output must round-trip through these gates
 * before being applied.
 */

import {
  CATEGORY_TITLE_PREFIXES,
  DICTIONARIES,
  KNOWN_MODEL_NAMES,
} from '../../product-renaming/name-dictionaries.js';

export const BANNED_PATTERNS = [
  /^\d{4,}$/,
  /^[A-Z]{5,}$/,
  /^[а-яА-ЯёЁ\s]{0,2}$/,
  /SKU|ProductCode|item[_-]?code|model[_-]?no/i,
];

export const BANNED_NAMES = [
  'test', 'temp', 'tmp', 'untitled', 'unnamed', 'placeholder',
  'лол', 'тест', 'временен', 'без име',
];

export const PRODUCT_TYPE_WORDS = [
  'диван', 'сет', 'комплект', 'маса', 'стол', 'фотьойл',
  'спалня', 'легло', 'гардероб', 'шкаф', 'скрин', 'тоалетка',
  'трапезария', 'бар', 'лаундж', 'шезлонг', 'люлка', 'беседка',
  'пергола', 'чадър', 'хамак', 'полутрап', 'daybed',
  'табла', 'нощно', 'основа', 'матрак', 'ракла',
  'поставка', 'тролей', 'библиотека', 'секция', 'витрина',
  'офис', 'геймърски', 'резервна', 'част', 'материя',
  'перфорирана', 'щори', 'перде', 'килим', 'постелка',
  'павилион', 'трапезен',
];

export const TRUNCATED_INDICATORS = [
  /\s[пП]\s*$/i, /\s[оО]\s*$/i,
  /\bWICKE\b/i, /\bSintere\b/i, /\bOLEF\b/i, /\bкамъ\b/i,
  /\bSINT\b/i, /\bWICK\b/i, /\bOlefi\b/i, /Olefin\s+п\b/i,
  /-си\b\s*$/i, /-P\.E\.\s*$/i, /\sOL\b(?!\w)/i, /\sO\b\s*$/i,
  /тек-син\b/i, /-синтерован\s*$/i, /синтерован\s*$/i,
];

export const UGLY_PATTERNS = [
  { pattern: /плат\s+Olefin\s+плат/i, label: '"плат Olefin плат" duplicate' },
  { pattern: /плат\s+и\s+Olefin\s+плат/i, label: '"плат и Olefin плат" duplicate' },
  { pattern: /и\s+Olefin\s+плат\s+и\s/i, label: '"и Olefin плат и" ugly connector' },
  { pattern: /алуминий-беж\b/i, label: '"алуминий-беж" unnormalized separator' },
  { pattern: /алуминий-крем\b/i, label: '"алуминий-крем" unnormalized separator' },
  { pattern: /тек-син\b/i, label: '"тек-син" truncated fragment' },
  { pattern: /\bкамъ\b/i, label: '"камъ" truncated fragment' },
  { pattern: /\bWICKE\b/i, label: '"WICKE" truncated fragment' },
  { pattern: /\bOLEF\b/i, label: '"OLEF" truncated fragment' },
  { pattern: /\bOlefi\b/i, label: '"Olefi" truncated fragment' },
  { pattern: /\bSintere\b/i, label: '"Sintere" truncated fragment' },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detects whether a product title is already in the controlled-name format.
 * This is checked BEFORE model detection so reruns and partial-apply jobs
 * mark already-renamed products as skipped instead of re-renaming them.
 */
export function isAlreadyRenamed(title) {
  if (!title) return false;
  const trimmed = title.trim();
  for (const [category, prefixes] of Object.entries(CATEGORY_TITLE_PREFIXES)) {
    const dict = DICTIONARIES[category] || [];
    for (const prefix of Object.values(prefixes)) {
      for (const name of dict) {
        const escaped = `${escapeRegex(prefix)}\\s+${escapeRegex(name)}`;
        const re = new RegExp(`^${escaped}(\\b|\\s|–|-|,|\\(|$)`, 'i');
        if (re.test(trimmed)) return { category, name, prefix };
      }
    }
  }
  return false;
}

/**
 * Hard quality failures — items that hit any of these can never go to apply,
 * regardless of risk label. Returns string[] of failure reasons.
 */
export function hardQualityFailures(item) {
  const failures = [];
  const title = item.newTitle || '';

  if (!item.handle || !item.handle.trim()) failures.push('handle is empty');
  if (!title.trim()) failures.push('new title is empty');

  if (title) {
    if (title.includes(',,')) failures.push('contains double comma');
    if (/[,–-]\s*$/.test(title.trim())) failures.push('ends with punctuation');
    if (/\s+(и|с|за)\s*$/.test(title.trim())) failures.push('ends with connector word');
    if (title.length < 30) failures.push(`title too short (${title.length})`);
    if (title.length > 120) failures.push(`title too long (${title.length})`);
    if (title.includes('&')) failures.push('contains "&" (should be "и")');

    const lower = title.toLowerCase();
    if (!PRODUCT_TYPE_WORDS.some((w) => lower.includes(w))) {
      failures.push('missing product-type keyword');
    }
    for (const pattern of BANNED_PATTERNS) {
      if (pattern.test(title)) { failures.push('banned pattern'); break; }
    }
    for (const banned of BANNED_NAMES) {
      if (lower.includes(banned)) { failures.push(`banned word "${banned}"`); break; }
    }
    for (const pattern of TRUNCATED_INDICATORS) {
      if (pattern.test(title)) { failures.push('truncated title fragment'); break; }
    }
    for (const ugly of UGLY_PATTERNS) {
      if (ugly.pattern.test(title)) failures.push(`ugly pattern: ${ugly.label}`);
    }

    if (item.detectedOldModelName && item.titleChanged) {
      const re = new RegExp(escapeRegex(item.detectedOldModelName), 'i');
      if (re.test(title)) failures.push('old model still present in new title');
    }
  }

  return failures;
}

/**
 * Pattern-based soft warnings — every match here pushes the item into the
 * needs_review bucket (not blocked) and surfaces a structured reason label
 * for the review CSV / validation summary. These are conservative checks
 * found from real dry-run output; they catch cases where the deterministic
 * rebuilder produced a technically-passing title that a human should still
 * eyeball before applying.
 */
export function patternQualityWarnings(item) {
  const t = item.newTitle || '';
  const reasons = [];
  if (!t) return reasons;

  // Numeric disambiguation suffix added by the duplicate resolver, e.g. " (2)".
  // It is the rebuilder's last-resort and almost always deserves human review.
  if (/\(\d+\)/.test(t)) reasons.push('numeric_disambiguation_suffix');

  // Truncated "екрю" → "ек" leftover. Three shapes have shown up in dry-runs:
  //   "...бежово и ек"  ← trailing
  //   "... и ек ..."    ← mid-sentence
  //   "...ек (..."      ← ек immediately before a paren group
  // JS \b only recognizes ASCII word chars, so we use explicit end-of-string
  // or non-Cyrillic-letter boundaries instead.
  const ekEnd = '(?![А-Яа-яЁё])';
  if (new RegExp(`бежово\\s+и\\s+ек${ekEnd}`, 'i').test(t)) reasons.push('broken_trailing_fragment');
  else if (new RegExp(`\\sи\\s+ек${ekEnd}`, 'i').test(t)) reasons.push('broken_trailing_fragment');
  else if (new RegExp(`(^|[^А-Яа-яЁё])ек\\s*\\(`, 'i').test(t)) reasons.push('broken_trailing_fragment');

  // Body restates the prefix product-type after the dash.
  // Dining: "Градински трапезен комплект {Name} – Комплект трапезна маса ..."
  const diningPrefix = /^Градински\s+трапезен\s+комплект\s+\S+\s*–\s*/i;
  const diningMatch = t.match(diningPrefix);
  if (diningMatch) {
    const body = t.slice(diningMatch[0].length);
    if (/^(Комплект\s+трапезна\s+маса|Сет\s+трапезария|Комплект\s+градинска\s+трапезария)/i.test(body)) {
      reasons.push('dining_body_repeats_type');
      reasons.push('redundant_product_type_wording');
    }
  }

  // Lounge: "Градински лаундж сет {Name} – Комплект градински салон ..." etc.
  const loungePrefix = /^Градински\s+лаундж\s+сет\s+\S+\s*–\s*/i;
  const loungeMatch = t.match(loungePrefix);
  if (loungeMatch) {
    const body = t.slice(loungeMatch[0].length);
    if (/^(Комплект\s+градински\s+салон|Сет\s+за\s+външен\s+кът|Комплект\s+за\s+външен\s+кът)/i.test(body)) {
      reasons.push('lounge_body_repeats_type');
      reasons.push('redundant_product_type_wording');
    }
  }

  return Array.from(new Set(reasons));
}

/**
 * Reason labels emitted by patternQualityWarnings, for documentation and
 * for the validation summary counters.
 */
export const PATTERN_QUALITY_REASONS = [
  'numeric_disambiguation_suffix',
  'broken_trailing_fragment',
  'dining_body_repeats_type',
  'lounge_body_repeats_type',
  'redundant_product_type_wording',
];

/**
 * Soft warnings — non-blocking signals that should land in the review queue.
 */
export function softWarnings(item) {
  const warnings = [];
  const title = item.newTitle || '';
  const oldTitle = item.oldTitle || '';

  const hasPieces = /\d+\s*части/i.test(oldTitle);
  const newHasPieces = /\d+\s*части/i.test(title);
  if (hasPieces && !newHasPieces) warnings.push('piece count lost');

  if (oldTitle.length > 0 && title.length > 0) {
    const oldWords = oldTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !/^\d/.test(w));
    const newWords = title.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !/^\d/.test(w));
    if (oldWords.length > 5) {
      const preserved = oldWords.filter((w) => newWords.includes(w));
      if (preserved.length < oldWords.length * 0.25) {
        warnings.push('many words removed from original');
      }
    }
  }

  if (item.detectedOldModelName) {
    const re = new RegExp(escapeRegex(item.detectedOldModelName), 'i');
    if (item.newSeoTitle && re.test(item.newSeoTitle)) warnings.push('old model in new SEO title');
    if (item.newSeoDescription && re.test(item.newSeoDescription)) warnings.push('old model in new SEO description');
  }

  // Pattern-based reasons (numeric suffix, broken "ек" fragment, body that
  // repeats the prefix product type). These force needs_review, not blocked.
  for (const r of patternQualityWarnings(item)) warnings.push(r);

  return warnings;
}

/**
 * Compute the per-item gating decision. Plan-job uses this; validate-job
 * uses the same function for parity.
 *
 * status:
 *   "skipped"      — already renamed or no change needed
 *   "blocked"      — hard failure OR risk=high; never apply
 *   "needs_review" — has warnings or risk=medium
 *   "ready"        — risk=low and no hard failures and no warnings
 */
export function decide(item) {
  if (item.alreadyRenamed) {
    return { status: 'skipped', skipReason: 'already_renamed', mutationAllowed: false };
  }
  if (!item.titleChanged) {
    return { status: 'skipped', skipReason: 'no_change', mutationAllowed: false };
  }
  const failures = hardQualityFailures(item);
  if (failures.length > 0 || item.risk === 'high') {
    return {
      status: 'blocked',
      blockReasons: failures.length > 0 ? failures : ['risk_high'],
      mutationAllowed: false,
    };
  }
  const warnings = softWarnings(item);
  if (warnings.length > 0 || item.risk === 'medium') {
    return {
      status: 'needs_review',
      reviewReasons: warnings,
      mutationAllowed: false,
    };
  }
  return { status: 'ready', mutationAllowed: true };
}

export { KNOWN_MODEL_NAMES };
