/**
 * Pure model-name replacement helpers for V3.
 *
 * Replacement is deliberately surgical: only the detected old model token is
 * substituted. Material/color/dimension words, product-type words, prefixes,
 * separators, and HTML structure are all preserved.
 *
 * Counts are exposed to the caller so plan-job can decide ready vs.
 * needs_review based on the replacement-count rules in the V3 spec:
 *   title.count                     must be exactly 1 (0 or >1 → needs_review)
 *   seoTitle.count / seoDescription must be 0 (skipped) or any (replaced)
 *   descriptionHtml.count           must be 0..20 (>20 → needs_review)
 */

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive global regex that matches the old model word at
 * Latin-friendly word boundaries. We require an ASCII boundary because
 * \b in JS only recognizes ASCII word chars — that is exactly right for our
 * Latin model names (ENASTRON, ELYSIA, ...). For Cyrillic ALL-CAPS models
 * we fall back to a non-Cyrillic-letter boundary.
 */
function buildModelRegex(oldModel) {
  const escaped = escapeRegex(oldModel);
  if (/[А-ЯЁ]/.test(oldModel)) {
    // Cyrillic boundary: surrounded by start/end OR non-Cyrillic-letter.
    return new RegExp(`(^|[^А-Яа-яЁё])(${escaped})(?![А-Яа-яЁё])`, 'gi');
  }
  return new RegExp(`\\b${escaped}\\b`, 'gi');
}

/**
 * Replace every occurrence of `oldModel` with `newName` and return both the
 * new text and the number of substitutions made.
 *
 * For Cyrillic patterns the regex captures the leading boundary character so
 * we have to splice it back in during replacement.
 */
export function replaceModel(text, oldModel, newName) {
  if (!text || !oldModel) return { text: text ?? null, count: 0 };
  const re = buildModelRegex(oldModel);
  let count = 0;
  const replaced = text.replace(re, (match, ...rest) => {
    count++;
    if (/[А-ЯЁ]/.test(oldModel)) {
      // rest = [boundary, modelMatch, offset, full]
      const [boundary] = rest;
      return `${boundary}${newName}`;
    }
    return newName;
  });
  return { text: replaced, count };
}

/**
 * Convenience wrapper: count how many times `oldModel` appears without
 * mutating anything. Used by plan-job to detect the "old model still
 * present after replacement" failure mode for validation.
 */
export function countModel(text, oldModel) {
  if (!text || !oldModel) return 0;
  const re = buildModelRegex(oldModel);
  return (text.match(re) || []).length;
}
