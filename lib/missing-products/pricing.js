/**
 * Deterministic pricing. Ported from clean_*.py:
 *   B2BMARKT_PRICE_MULTIPLIER = 3.10, MEGAPAP_PRICE_MULTIPLIER = 1.70
 * Retail = wholesale × multiplier, rounded to 2 decimals.
 */

/**
 * Normalise a price string to a plain decimal string.
 * '2,103.66' -> '2103.66' (comma = thousands); '1,50' -> '1.50' (comma = decimal).
 * Returns '' when not parseable.
 */
export function normalizePrice(val) {
  if (val == null) return '';
  let s = String(val).trim();
  if (!s) return '';
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
  else if (s.includes(',') && !s.includes('.')) s = s.replace(/,/g, '.');
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

/**
 * Compute the Shopify retail price from a wholesale value and multiplier.
 * @returns {string} formatted "xx.xx", or '' when wholesale is missing/invalid.
 */
export function computeRetailPrice(wholesale, multiplier) {
  const norm = normalizePrice(wholesale);
  if (norm === '') return '';
  const n = Number.parseFloat(norm) * multiplier;
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}
