import { extractText } from '../suppliers/shared/xml.js';

function add(map, key, value) {
  if (!key) return;
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** Build an immutable old-SKU → new-SKU snapshot from one supplier feed. */
export function buildSkuFeedIndex(products, migration) {
  const entries = [];
  const byOldSku = new Map();
  const byNewSku = new Map();
  let missingOldSku = 0;
  let missingNewSku = 0;

  for (const node of products) {
    const oldSku = extractText(node?.[migration.oldField]);
    const newSku = extractText(node?.[migration.newField]);
    if (!oldSku) missingOldSku++;
    if (!newSku) missingNewSku++;
    if (!oldSku || !newSku) continue;
    const entry = {
      oldSku,
      newSku,
      title: extractText(node?.name ?? node?.Name),
    };
    entries.push(entry);
    add(byOldSku, oldSku, entry);
    add(byNewSku, newSku, entry);
  }

  const duplicateOldSkus = new Set([...byOldSku].filter(([, rows]) => rows.length > 1).map(([sku]) => sku));
  const duplicateNewSkus = new Set([...byNewSku].filter(([, rows]) => rows.length > 1).map(([sku]) => sku));
  return { entries, byOldSku, byNewSku, duplicateOldSkus, duplicateNewSkus, missingOldSku, missingNewSku };
}

function vendorRows(rows, vendor) {
  return (rows || []).filter((row) => !vendor || row.vendor === vendor);
}

/** Classify every feed product without mutating Shopify. */
export function classifySkuMigration({ feedIndex, shopifyBySku, migration }) {
  const rows = [];
  const summary = {
    totalFeedProducts: feedIndex.entries.length,
    toChange: 0,
    alreadyChanged: 0,
    unmatched: 0,
    conflicts: 0,
    duplicateTargetProducts: 0,
    duplicateTargetValues: feedIndex.duplicateNewSkus.size,
    missingOldSku: feedIndex.missingOldSku,
    missingNewSku: feedIndex.missingNewSku,
  };

  for (const entry of feedIndex.entries) {
    const duplicateTarget = feedIndex.duplicateNewSkus.has(entry.newSku);
    if (duplicateTarget) summary.duplicateTargetProducts++;
    const oldAll = shopifyBySku.get(entry.oldSku) || [];
    const oldMatches = vendorRows(oldAll, migration.vendor);
    const newMatches = vendorRows(shopifyBySku.get(entry.newSku), migration.vendor);
    const base = {
      ...entry,
      variantId: null,
      productId: null,
      shopifyTitle: null,
      vendor: migration.vendor,
      duplicateTarget,
      selectable: false,
      reason: null,
    };

    if (feedIndex.duplicateOldSkus.has(entry.oldSku)) {
      rows.push({ ...base, status: 'conflict', reason: 'duplicate-feed-old-sku' });
      summary.conflicts++;
      continue;
    }
    if (oldMatches.length > 1) {
      rows.push({ ...base, status: 'conflict', reason: 'duplicate-shopify-old-sku' });
      summary.conflicts++;
      continue;
    }
    if (oldMatches.length === 1) {
      const match = oldMatches[0];
      rows.push({
        ...base,
        status: entry.oldSku === entry.newSku ? 'already' : 'change',
        variantId: match.variantId,
        productId: match.productId,
        shopifyTitle: match.productTitle,
        selectable: entry.oldSku !== entry.newSku,
      });
      if (entry.oldSku === entry.newSku) summary.alreadyChanged++;
      else summary.toChange++;
      continue;
    }
    if (newMatches.length > 0) {
      rows.push({
        ...base,
        status: 'already',
        variantId: newMatches.length === 1 ? newMatches[0].variantId : null,
        productId: newMatches.length === 1 ? newMatches[0].productId : null,
        shopifyTitle: newMatches.length === 1 ? newMatches[0].productTitle : null,
      });
      summary.alreadyChanged++;
      continue;
    }
    if (oldAll.length > 0) {
      rows.push({ ...base, status: 'conflict', reason: 'vendor-mismatch' });
      summary.conflicts++;
      continue;
    }
    rows.push({ ...base, status: 'unmatched', reason: 'not-in-shopify' });
    summary.unmatched++;
  }

  return { rows, summary };
}

