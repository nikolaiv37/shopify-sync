import crypto from 'node:crypto';
import { XMLValidator } from 'fast-xml-parser';
import { getSupplier } from '../suppliers/index.js';
import { extractText } from '../suppliers/shared/xml.js';
import { SUPPLIERS, supplierConfig } from './config.js';

export const fingerprint = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
// Supplier feeds use whole, nonnegative decimal units. Never coerce unsupported values.
export function parseQuantity(raw) {
  if (Array.isArray(raw) || typeof raw === 'boolean') return { quantity: null, error: 'invalid-quantity' };
  const text = extractText(raw);
  if (!/^\d+$/.test(text)) return { quantity: null, error: text ? 'invalid-quantity' : 'missing-quantity' };
  const quantity = Number(text);
  return Number.isSafeInteger(quantity) && quantity <= 2147483647
    ? { quantity, error: null } : { quantity: null, error: 'unsupported-quantity' };
}
export function normalizeRecords(key, nodes) {
  const config = supplierConfig(key);
  const scalarText = value => Array.isArray(value) || typeof value === 'boolean' ? '' : extractText(value);
  return nodes.map((node, index) => {
    const { quantity, error } = parseQuantity(node?.[config.quantityField]);
    return {
      rowId: `${key}:${index}`, supplier: key,
      supplierProductId: scalarText(node?.[config.idField]),
      itemCode: scalarText(node?.[config.skuField]),
      platformId: scalarText(node?.ProductId),
      barcode: scalarText(node?.ean ?? node?.BarcodeMain),
      title: extractText(node?.name ?? node?.Name),
      rawQuantity: extractText(node?.[config.quantityField]), quantity, quantityError: error,
    };
  });
}
export async function loadFeeds({ env = process.env, fetchImpl = fetch, supplier } = {}) {
  if (supplier !== undefined) supplierConfig(supplier);
  const pairs = await Promise.all((supplier ? [supplier] : Object.keys(SUPPLIERS)).map(async (key) => {
    const config = supplierConfig(key);
    const name = config.feedEnv.find((entry) => env[entry]);
    if (!name) throw new Error(`Липсва ${config.feedEnv.join(' или ')}. Не може да се провери собствеността между доставчиците.`);
    const response = await fetchImpl(env[name], { headers: { 'User-Agent': 'mebelcenter-inventory-v2' }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${config.name}: доставчикът върна HTTP ${response.status}.`);
    const xml = await response.text();
    if (XMLValidator.validate(xml) !== true) throw new Error(`${config.name}: невалиден XML.`);
    const records = normalizeRecords(key, getSupplier(key).parseProducts(xml));
    if (!records.length) throw new Error(`${config.name}: празен каталог; операцията е блокирана.`);
    return [key, { records, fingerprint: fingerprint(records), fetchedAt: new Date().toISOString(), sourceEnv: name }];
  }));
  return Object.fromEntries(pairs);
}
export function feedFingerprint(feeds) {
  return fingerprint(Object.keys(SUPPLIERS).map((key) => [key, feeds[key]?.fingerprint ?? null]));
}
