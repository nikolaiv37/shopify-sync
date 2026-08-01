/**
 * Supplier registry. Both adapters expose the same interface:
 *   config, parseProducts(xml), listCategories(products),
 *   matchesCategory(node, cat), extractProduct(node), matchKeys(product)
 */

import * as b2bmarkt from './b2bmarkt/adapter.js';
import * as megapap from './megapap/adapter.js';

export const SUPPLIERS = { b2bmarkt, megapap };

/** Resolve an adapter by key; throws on unknown supplier. */
export function getSupplier(key) {
  const adapter = SUPPLIERS[key];
  if (!adapter) {
    throw new Error(`Unknown supplier "${key}". Expected one of: ${Object.keys(SUPPLIERS).join(', ')}`);
  }
  return adapter;
}
