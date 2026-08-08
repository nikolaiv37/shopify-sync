/**
 * Canonical supplier pricing configuration.
 *
 * ONE source of truth for the wholesale → Shopify selling-price multiplier used
 * across the whole app: Missing Products predicted price, Shopify CSV export,
 * the Prices module, and dashboard supplier info. Supplier adapters and the
 * update-prices CLI import their multiplier from here — never hardcode it.
 *
 * Business rules (locked):
 *   B2BMarkt : × 3.1
 *   MegaPap  : × 2.5   (changed from the historical × 1.7)
 *   Symetron : × 3.1
 *
 * The Shopify selling price is ALWAYS derived from the current supplier
 * wholesale price in the feed — never from the existing Shopify price.
 */

export const SUPPLIER_PRICING = Object.freeze({
  b2bmarkt: { multiplier: 3.1 },
  megapap: { multiplier: 2.5 },
  symetron: { multiplier: 3.1 },
});

/** Multiplier for a supplier key, or null when unknown. */
export function getMultiplier(supplierKey) {
  return SUPPLIER_PRICING[supplierKey]?.multiplier ?? null;
}

/** Markup percentage for display, e.g. 2.5 → 150. */
export function markupPercent(multiplier) {
  if (!Number.isFinite(multiplier)) return null;
  return Math.round((multiplier - 1) * 100);
}

/**
 * Prices-page repricing operations. These are chosen PER RUN by the operator on
 * the Prices page and are independent of the per-supplier DEFAULT multiplier
 * (getMultiplier / SUPPLIER_PRICING) that Missing Products + CSV keep using.
 */
export const PriceOperation = Object.freeze({
  SOURCE: 'source', // target = wholesale (×1.0) — "Върни към доставна цена"
  MULTIPLIER: 'multiplier', // target = wholesale × chosen multiplier
});

/** Compare-at ("Сравнителна цена") operations. Extends the selling ops with keep/clear. */
export const CompareOperation = Object.freeze({
  KEEP: 'keep', // do not touch compareAtPrice at all
  CLEAR: 'clear', // set compareAtPrice = null (remove it)
  SOURCE: 'source', // compareAt = wholesale (×1.0)
  MULTIPLIER: 'multiplier', // compareAt = wholesale × chosen multiplier
});

/** Parse a user-entered multiplier ("2.5" or "2,5") to a positive number, else null. */
export function parseMultiplier(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (raw == null) return null;
  const s = String(raw).trim().replace(',', '.');
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The multiplier that a repricing operation actually applies to the wholesale
 * price. SOURCE always means ×1.0; MULTIPLIER means the operator's value.
 * @returns {number|null} null when the operation/multiplier is invalid.
 */
export function effectiveMultiplier(operation, multiplier) {
  if (operation === PriceOperation.SOURCE) return 1;
  if (operation === PriceOperation.MULTIPLIER) return parseMultiplier(multiplier);
  return null;
}

/**
 * Resolve a compare-at target for a wholesale price. Both SOURCE and MULTIPLIER
 * derive from the SOURCE wholesale (×1.0 / ×m) — never from the current price.
 * @returns {{ mode: 'keep'|'set'|'clear', value: number|null, effective: number|null }}
 *   mode 'keep' → omit compareAtPrice entirely; 'clear' → null; 'set' → value.
 */
export function computeCompareTarget(operation, multiplier, wholesale) {
  if (operation === CompareOperation.KEEP) return { mode: 'keep', value: undefined, effective: null };
  if (operation === CompareOperation.CLEAR) return { mode: 'clear', value: null, effective: null };
  const eff = operation === CompareOperation.SOURCE ? 1 : parseMultiplier(multiplier);
  if (eff == null) return { mode: 'set', value: null, effective: null }; // invalid multiplier
  const value = computeTargetPrice(wholesale, eff);
  return { mode: 'set', value, effective: eff };
}

/** Round to 2 decimals using the project's established convention (half-up on .5). */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Format a number as a fixed 2-decimal money string ("250.00"). */
export function moneyString(n) {
  return round2(n).toFixed(2);
}

/**
 * Parse a supplier wholesale price string to a finite non-negative number.
 * Accepts comma or dot decimals ("1,50" → 1.5). Returns null when invalid.
 */
export function parseSourcePrice(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(',', '.');
  if (!s) return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Parse a Shopify money value ("170.00") to a number, or null. */
export function parseShopifyMoney(val) {
  if (val == null) return null;
  const n = Number.parseFloat(String(val));
  return Number.isFinite(n) ? n : null;
}

/**
 * Deterministic target Shopify price from wholesale × multiplier, rounded to 2dp.
 * Returns null when wholesale is missing/invalid so callers can flag it.
 * @returns {number|null}
 */
export function computeTargetPrice(wholesale, multiplier) {
  const src = typeof wholesale === 'number' ? wholesale : parseSourcePrice(wholesale);
  if (src == null || !Number.isFinite(multiplier)) return null;
  return round2(src * multiplier);
}
