/**
 * Optional AI fallback — STUB ONLY.
 *
 * V2 deliberately does NOT call any real AI API in this commit. The stub
 * exists so plan-job and validate-job can route problematic items here in
 * the future without re-architecting.
 *
 * Contract for future implementations:
 *   - Input: { product, detectedCategory, detectedOldModel, reason }
 *   - Output: strict JSON { newTitle, newSeoTitle, newSeoDescription }
 *   - Output MUST round-trip through quality-gates.decide() before apply.
 *   - Triggered only for: no_model_detected, unresolved_truncated_fragment,
 *     duplicate_unresolved, title_rebuilt_from_scratch, medium-risk
 *     because too many words were removed.
 *
 * Activation requires both:
 *   - process.env.AI_FALLBACK_ENABLED === 'true'
 *   - process.env.AI_FALLBACK_API_KEY set
 * Without both, this module always returns { used: false }.
 */

const ELIGIBLE_REASONS = new Set([
  'no_model_detected',
  'unresolved_truncated_fragment',
  'duplicate_unresolved',
  'title_rebuilt_from_scratch',
  'too_many_words_removed',
]);

export function isAiEnabled() {
  return process.env.AI_FALLBACK_ENABLED === 'true' && !!process.env.AI_FALLBACK_API_KEY;
}

export function isEligibleForFallback(reason) {
  return ELIGIBLE_REASONS.has(reason);
}

/**
 * Stub. Real implementations should:
 *  1. Build a strict-JSON prompt with the controlled dictionary + category.
 *  2. Call the model.
 *  3. Parse JSON.parse(response).
 *  4. Return { used: true, candidate: {...} } and let the caller re-run
 *     quality-gates.decide() before applying.
 */
export async function proposeRenameFallback(_ctx) {
  if (!isAiEnabled()) return { used: false, reason: 'ai_disabled' };
  return { used: false, reason: 'ai_stub_not_implemented' };
}
