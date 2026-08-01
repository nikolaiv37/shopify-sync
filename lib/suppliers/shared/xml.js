/**
 * Shared XML helpers for supplier catalog parsing.
 *
 * Extracted verbatim (behaviour-preserving) from the inline helpers in
 * export-missing-products.js / list_b2bmarkt_categories.js so supplier adapters
 * and their CLI wrappers share one implementation.
 */

import { XMLParser } from 'fast-xml-parser';

/** Coerce a fast-xml-parser value (string | number | array | {#text|__cdata}) to trimmed text. */
export function extractText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return extractText(val[0]);
  if (typeof val === 'object') {
    return extractText(val['#text'] ?? val.__cdata ?? '');
  }
  return String(val).trim();
}

/** Depth-first search for the first array of `<productTag>` elements. */
export function findProductArray(node, productTag) {
  if (!node || typeof node !== 'object') return null;
  for (const key of Object.keys(node)) {
    if (key === productTag) {
      const v = node[key];
      return Array.isArray(v) ? v : [v];
    }
    const found = findProductArray(node[key], productTag);
    if (found) return found;
  }
  return null;
}

/** Parse a supplier XML string into an array of raw product nodes. */
export function parseCatalog(xmlText, productTag) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
    attributesGroupName: '$attrs',
  });
  const parsed = parser.parse(xmlText);
  const products = findProductArray(parsed, productTag);
  if (!products) {
    throw new Error(`Could not find <${productTag}> elements in XML`);
  }
  return products;
}
