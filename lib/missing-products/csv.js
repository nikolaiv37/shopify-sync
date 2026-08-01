/**
 * Shopify import CSV writer for prepared product rows.
 */

import { SHOPIFY_COLUMNS } from './transform.js';

function escapeField(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Serialize transform rows to a Shopify-import CSV string.
 * @param {object[]} rows  rows keyed by SHOPIFY_COLUMNS
 * @param {string[]} [columns]
 */
export function rowsToCsv(rows, columns = SHOPIFY_COLUMNS) {
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeField(row[col])).join(','));
  }
  return lines.join('\n') + '\n';
}
