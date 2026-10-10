/** Approved supplier SKU migrations. Field names are case-sensitive XML tags. */
export const SKU_MIGRATIONS = Object.freeze({
  megapap: Object.freeze({
    key: 'megapap',
    name: 'Megapap',
    vendor: 'Mebelcenter',
    oldField: 'model',
    newField: 'sku',
  }),
  symetron: Object.freeze({
    key: 'symetron',
    name: 'Symetron',
    vendor: 'Europe',
    oldField: 'ProductCode',
    newField: 'ItemCode',
  }),
  b2bmarkt: Object.freeze({
    key: 'b2bmarkt',
    name: 'B2BMarkt',
    vendor: 'Europe',
    oldField: 'ProductCode',
    newField: 'ItemCode',
  }),
});

export function getSkuMigration(key) {
  const migration = SKU_MIGRATIONS[key];
  if (!migration) {
    const error = new Error(`Unknown SKU supplier "${key}".`);
    error.statusCode = 400;
    throw error;
  }
  return migration;
}

