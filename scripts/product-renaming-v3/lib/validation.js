/**
 * V3 per-item validation helpers — used by plan-job (initial decision) and
 * validate-job (re-check after duplicate analysis).
 *
 * Status grid:
 *   skipped_already_renamed — Protection A or B matched
 *   skipped_no_model        — no safe old model detected
 *   needs_review            — ambiguous detection, multi-occurrence in title,
 *                             too many description occurrences, suspicious
 *                             new-name choice, or duplicate new title
 *   blocked                 — invalid product id, missing title, hard
 *                             quality failure, no replacement happened in
 *                             title where one was expected
 *   ready                   — clean, single-occurrence title replacement,
 *                             no duplicate new title, mutationAllowed=true
 */

import { countModel } from './replacement.js';

const TITLE_MAX_OCCURRENCES = 1;
const DESCRIPTION_MAX_OCCURRENCES = 20;

/**
 * Hard failures: never apply, regardless of any other field.
 */
export function hardFailures(item) {
  const failures = [];
  if (!item.productId) failures.push('missing_product_id');
  if (!item.handle || !String(item.handle).trim()) failures.push('missing_handle');
  if (!item.oldTitle || !String(item.oldTitle).trim()) failures.push('missing_old_title');
  if (item.newTitle != null && typeof item.newTitle !== 'string') {
    failures.push('new_title_not_string');
  }
  return failures;
}

/**
 * Compute the per-item decision based purely on the item itself. validate-job
 * adds a second-pass duplicate check on top of this.
 */
export function decide(item) {
  if (item.alreadyRenamed) {
    return {
      status: 'skipped_already_renamed',
      mutationAllowed: false,
      reasons: item.alreadyRenamedReasons || ['already_renamed'],
    };
  }

  const failures = hardFailures(item);
  if (failures.length > 0) {
    return { status: 'blocked', mutationAllowed: false, reasons: failures };
  }

  // V3 standard field is item.oldModel. Accept item.detectedOldModel as an
  // alias so any future callers that emit the V2-style name still work.
  const oldModel = item.oldModel || item.detectedOldModel || null;

  if (!oldModel) {
    if (item.ambiguousModel) {
      return {
        status: 'needs_review',
        mutationAllowed: false,
        reasons: ['ambiguous_model_candidates', ...(item.ambiguousCandidates || []).map((c) => `candidate:${c}`)],
      };
    }
    return {
      status: 'skipped_no_model',
      mutationAllowed: false,
      reasons: ['no_old_model_detected'],
    };
  }

  const reviewReasons = [];

  // Title replacement count check.
  const titleCount = item.replacementCounts?.title ?? 0;
  if (titleCount === 0) {
    return {
      status: 'blocked',
      mutationAllowed: false,
      reasons: ['title_no_replacement_made'],
    };
  }
  if (titleCount > TITLE_MAX_OCCURRENCES) {
    reviewReasons.push(`title_too_many_occurrences(${titleCount})`);
  }

  // Title must not still contain the old model after replacement.
  if (item.newTitle && countModel(item.newTitle, oldModel) > 0) {
    return {
      status: 'blocked',
      mutationAllowed: false,
      reasons: ['old_model_still_in_new_title'],
    };
  }

  // Title must contain the new name.
  if (item.newTitle && !item.newTitle.includes(item.newModel)) {
    return {
      status: 'blocked',
      mutationAllowed: false,
      reasons: ['new_model_missing_from_title'],
    };
  }

  // descriptionHtml count check.
  const descCount = item.replacementCounts?.descriptionHtml ?? 0;
  if (descCount > DESCRIPTION_MAX_OCCURRENCES) {
    reviewReasons.push(`description_too_many_occurrences(${descCount})`);
  }

  // SEO title / description: either 0 (left unchanged) or any positive count.
  // Both are acceptable — no review reason.

  // Suspicious detected model: very short Latin word, or a word that looks
  // like a generic English noun the supplier did not intend as a model.
  if (oldModel.length < 4) {
    reviewReasons.push('suspicious_short_model');
  }

  // Title length sanity — V3 does not rebuild, so a huge length delta
  // suggests the regex matched something it shouldn't have.
  if (item.oldTitle && item.newTitle) {
    const delta = Math.abs(item.newTitle.length - item.oldTitle.length);
    if (delta > Math.max(20, oldModel.length + (item.newModel?.length || 0))) {
      reviewReasons.push('unexpected_title_length_delta');
    }
  }

  if (reviewReasons.length > 0) {
    return { status: 'needs_review', mutationAllowed: false, reasons: reviewReasons };
  }
  return { status: 'ready', mutationAllowed: true, reasons: [] };
}

export const REPLACEMENT_LIMITS = {
  TITLE_MAX_OCCURRENCES,
  DESCRIPTION_MAX_OCCURRENCES,
};
