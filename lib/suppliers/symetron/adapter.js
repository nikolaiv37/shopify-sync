/**
 * Symetron supplier adapter.
 *
 * Symetron is a brand distributed through the B2BMarkt platform via its own
 * dedicated feed. The XML schema is IDENTICAL to the main B2BMarkt feed, so this
 * adapter reuses the shared B2BMarkt-platform parser (../b2bmarkt/format.js) and
 * only differs in config (feed source, key/name, category labels).
 *
 * Feed language: English (lang=2) — verified structurally complete (titles,
 * descriptions, categories, prices, stock, weight, images all present with the
 * same coverage as Greek), and easier for the operator to inspect. Text is
 * passed through untranslated. Stable Shopify-match identifier: <ProductCode>.
 *
 * PRICING: `priceMultiplier` below is PROVISIONAL. Symetron has no confirmed
 * Mebelcenter markup rule of its own. It shares the B2BMarkt feed's wholesale
 * (<ZoneFourUnitPrice>) and retail (<RetailCurrentPrice>) fields, so B2BMarkt's
 * ×3.1 is used as a placeholder to keep the scan/CSV pipeline functional. This
 * value must be confirmed by the business before any real export/import.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as format from '../b2bmarkt/format.js';
import { getMultiplier } from '../../pricing/pricing-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const config = {
  key: 'symetron',
  name: 'Symetron',
  vendor: 'Europe', // distributed through B2BMarkt (same 'Europe' distributor grouping)
  sourceLang: 'en', // English feed (lang=2) — passed through untranslated
  productTag: 'Product',
  priceMultiplier: getMultiplier('symetron'), // canonical (× 3.1) — see lib/pricing/pricing-config.js
  stripHmCodes: true,
  defaultXml: path.join(REPO_ROOT, 'symetron_en.xml'),
  categoryMapPath: path.join(REPO_ROOT, 'config', 'symetron-category-map.json'),
  categoryLabelsPath: path.join(REPO_ROOT, 'config', 'symetron-category-labels.json'),
  pathSeparator: ' > ',
  feedUrlEnv: 'B2BMARKT_SYMETRON_EN_URL',
};

/** Parse the catalog XML string into raw product nodes. */
export function parseProducts(xmlText) {
  return format.parseProducts(xmlText, config.productTag);
}

export const listCategories = format.listCategories;
export const matchesCategory = format.matchesCategory;

/** Extract a canonical product object used by compare/transform. */
export function extractProduct(node) {
  return format.extractProduct(node, config.key);
}

export const matchKeys = format.matchKeys;
