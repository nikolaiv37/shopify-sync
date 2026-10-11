export const INVENTORY_VERSION = 'inventory-v2.2';
export const NAMESPACE = '$app:mebelcenter_inventory';
export const IDENTITY_KEY = 'supplier_identity';
export const OWNERSHIP_KEY = 'stock_ownership';
export const LOCK_KEY = 'writer_lock';
export const BATCH_SIZE = 100;
export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const SUPPLIERS = Object.freeze({
  megapap: { key: 'megapap', name: 'MegaPap', vendor: 'Mebelcenter', idField: 'model', skuField: 'sku', quantityField: 'quantity', feedEnv: ['MEGAPAP_FEED_URL'] },
  b2bmarkt: { key: 'b2bmarkt', name: 'B2BMarkt', vendor: 'Europe', idField: 'ProductCode', skuField: 'ItemCode', quantityField: 'Stock', feedEnv: ['B2BMARKT_MAIN_URL'] },
  symetron: { key: 'symetron', name: 'Symetron', vendor: 'Europe', idField: 'ProductCode', skuField: 'ItemCode', quantityField: 'Stock', feedEnv: ['B2BMARKT_SYMETRON_URL', 'B2BMARKT_SYMETRON_EN_URL'] },
});
export function supplierConfig(key) {
  if (!Object.hasOwn(SUPPLIERS, key)) throw Object.assign(new Error('Непознат доставчик.'), { statusCode: 400 });
  return SUPPLIERS[key];
}
