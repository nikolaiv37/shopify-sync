/**
 * B2BMarkt supplier adapter.
 *
 * Uses the shared B2BMarkt-platform parser (./format.js). Source language: Greek
 * (b2bmarkt_updated.xml). Stable identifier for Shopify comparison: <ProductCode>
 * (matched vs SKU; barcode used as a secondary match by the compare step).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as format from './format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const config = {
  key: 'b2bmarkt',
  name: 'B2BMarkt',
  vendor: 'Europe',
  sourceLang: 'el', // Greek — passed through untranslated (drafts, edited in Shopify)
  productTag: 'Product',
  priceMultiplier: 3.1,
  stripHmCodes: true,
  defaultXml: path.join(REPO_ROOT, 'b2bmarkt_updated.xml'),
  categoryMapPath: path.join(REPO_ROOT, 'config', 'b2bmarkt-category-map.json'),
  categoryLabelsPath: path.join(REPO_ROOT, 'config', 'b2bmarkt-category-labels.json'),
  pathSeparator: ' > ',
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
