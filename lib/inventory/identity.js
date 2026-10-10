import { fingerprint } from './feeds.js';
import { SUPPLIERS } from './config.js';
export const identityKey = (supplier, id) => `${supplier}:${id}`;
export function decodeIdentity(value) {
  if (value == null) return { version: 1, suppliers: {} };
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed.version !== 1 || !parsed.suppliers || Array.isArray(parsed.suppliers)) return null;
    if (Object.entries(parsed.suppliers).some(([key, id]) => !Object.hasOwn(SUPPLIERS, key) || typeof id !== 'string' || !id.trim())) return null;
    return parsed;
  } catch { return null; }
}
export function decodeOwnership(value) {
  if (value == null) return { version: 1, locations: {} };
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed.version !== 1 || !parsed.locations || Array.isArray(parsed.locations)) return null;
    for (const [location, owner] of Object.entries(parsed.locations)) {
      if (!location.startsWith('gid://shopify/Location/') || !Object.hasOwn(SUPPLIERS, owner.supplier) || typeof owner.supplierProductId !== 'string' || !owner.supplierProductId || !owner.reason) return null;
    }
    return parsed;
  } catch { return null; }
}
export function registryIndex(variants) {
  const byIdentity = new Map();
  for (const variant of variants) {
    const identity = decodeIdentity(variant.identityValue);
    if (!identity) continue;
    for (const [supplier, id] of Object.entries(identity.suppliers)) {
      const key = identityKey(supplier, id);
      const list = byIdentity.get(key) || []; list.push(variant); byIdentity.set(key, list);
    }
  }
  return byIdentity;
}
function duplicates(records) {
  const counts = new Map();
  for (const row of records) if (row.supplierProductId) counts.set(row.supplierProductId, (counts.get(row.supplierProductId) || 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}
function evidenceIndex(variants) {
  const indexes = { sku: new Map(), barcode: new Map(), handle: new Map() };
  const productCounts = new Map();
  for (const v of variants) productCounts.set(v.productId, (productCounts.get(v.productId) || 0) + 1);
  for (const v of variants) for (const [kind, value] of [['sku', v.sku], ['barcode', v.barcode], ['handle', v.handle]]) {
    if (!value || (kind === 'handle' && productCounts.get(v.productId) !== 1)) continue;
    const list = indexes[kind].get(value) || []; list.push(v); indexes[kind].set(value, list);
  }
  return indexes;
}
export function discoverIdentities({ feeds, variants, locationId, overrides = {}, now = new Date().toISOString() }) {
  const registry = registryIndex(variants); const indexes = evidenceIndex(variants); const rows = [];
  for (const supplier of Object.keys(SUPPLIERS)) {
    const records = feeds[supplier].records; const duplicate = duplicates(records);
    for (const record of records) {
      const base = { ...record, status: 'unmatched', reason: 'missing-shopify-variant', variantId: null, evidence: [] };
      if (!record.supplierProductId) { rows.push({ ...base, status: 'conflict', reason: 'missing-identifier' }); continue; }
      if (duplicate.has(record.supplierProductId)) { rows.push({ ...base, status: 'conflict', reason: 'duplicate-supplier-identifier' }); continue; }
      const persisted = registry.get(identityKey(supplier, record.supplierProductId)) || [];
      if (persisted.length > 1) { rows.push({ ...base, status: 'conflict', reason: 'duplicate-shopify-destination' }); continue; }
      if (persisted.length === 1) { rows.push({ ...base, status: 'verified', reason: 'persisted-identity', variantId: persisted[0].variantId, evidence: ['persisted-identity'], variant: persisted[0] }); continue; }
      const candidates = new Map(); const uniqueSignals = new Set();
      const probes = [
        ['sku', record.supplierProductId, 'legacy-sku'],
        ['sku', record.itemCode, 'current-sku'],
        ['handle', `mc-${record.supplierProductId.toLowerCase()}`, 'legacy-handle'],
        ['handle', record.platformId ? `mc-${record.platformId.toLowerCase()}` : '', 'platform-handle'],
        // ItemCode masquerading as a barcode is not independent corroboration.
        ['barcode', /^\d{8,14}$/.test(record.barcode) && record.barcode !== record.itemCode && record.barcode !== record.supplierProductId ? record.barcode : '', 'barcode'],
      ];
      for (const [kind, value, label] of probes) {
        if (!value) continue;
        const matches = (indexes[kind].get(value) || []).filter(v => v.vendor === SUPPLIERS[supplier].vendor);
        if (matches.length === 1) uniqueSignals.add(matches[0].variantId);
        for (const v of matches) {
          const candidate = candidates.get(v.variantId) || { variant: v, signals: new Set() };
          // Same string used as old and new SKU counts as one piece of evidence.
          candidate.signals.add(`${kind}:${value}`); candidate.labels = [...(candidate.labels || []), label];
          candidates.set(v.variantId, candidate);
        }
      }
      const strong = [...candidates.values()].filter(c => c.signals.size >= 2);
      if (strong.length !== 1 || uniqueSignals.size > 1) {
        rows.push({ ...base, status: candidates.size ? (strong.length > 1 || uniqueSignals.size > 1 ? 'conflict' : 'insufficient') : 'unmatched', reason: candidates.size ? (strong.length > 1 || uniqueSignals.size > 1 ? 'ambiguous-evidence' : 'insufficient-evidence') : 'missing-shopify-variant', candidates: [...candidates.keys()] }); continue;
      }
      const match = strong[0]; const existing = decodeIdentity(match.variant.identityValue);
      if (!existing || (existing.suppliers[supplier] && existing.suppliers[supplier] !== record.supplierProductId)) {
        rows.push({ ...base, status: 'conflict', reason: 'existing-identity-conflict' }); continue;
      }
      rows.push({ ...base, status: 'verified', reason: 'corroborated-evidence', variantId: match.variant.variantId, evidence: match.labels, variant: match.variant });
    }
  }
  const groups = new Map();
  for (const row of rows.filter(r => r.status === 'verified')) { const list = groups.get(row.variantId) || []; list.push(row); groups.set(row.variantId, list); }
  const proposals = [];
  for (const [variantId, group] of groups) {
    const variant = group[0].variant;
    const identity = decodeIdentity(variant.identityValue); const ownership = decodeOwnership(variant.ownershipValue);
    const supplierCounts = new Map(); for (const row of group) supplierCounts.set(row.supplier, (supplierCounts.get(row.supplier) || 0) + 1);
    const shared = group.length > 1;
    const verifiedOverlap = shared && group.length === 2 && supplierCounts.has('b2bmarkt') && supplierCounts.has('symetron') && group[0].supplierProductId === group[1].supplierProductId && group[0].platformId && group[0].platformId === group[1].platformId;
    if (!identity || !ownership || [...supplierCounts.values()].some(n => n > 1) || (shared && !verifiedOverlap)) {
      for (const row of group) { row.status = 'conflict'; row.reason = 'cross-supplier-or-destination-conflict'; }
      continue;
    }
    const suppliers = { ...identity.suppliers }; for (const row of group) suppliers[row.supplier] = row.supplierProductId;
    // Recorded identities remain even when their source disappears; ownership is never transferred implicitly.
    const existingOwner = ownership.locations[locationId]; const override = overrides[`${variantId}:${locationId}`];
    let owner;
    if (override) {
      if (!override.reason || !suppliers[override.supplier]) { for (const row of group) { row.status = 'conflict'; row.reason = 'invalid-ownership-override'; } continue; }
      owner = { supplier: override.supplier, supplierProductId: suppliers[override.supplier], reason: override.reason, decision: 'explicit-override', decidedAt: now };
    } else if (existingOwner) owner = existingOwner;
    else {
      const known = Object.keys(suppliers);
      if (known.length > group.length) { for (const row of group) { row.status = 'conflict'; row.reason = 'ownership-source-missing'; } continue; }
      const selected = verifiedOverlap ? group.find(r => r.supplier === 'b2bmarkt') : group[0];
      owner = { supplier: selected.supplier, supplierProductId: selected.supplierProductId, reason: verifiedOverlap ? 'verified-overlap-b2bmarkt-priority' : 'verified-exclusive-identity', decision: 'default', decidedAt: now };
    }
    for (const row of group) { row.owner = owner.supplier; row.overlap = verifiedOverlap; }
    const nextIdentity = { version: 1, suppliers };
    const nextOwnership = { version: 1, locations: { ...ownership.locations, [locationId]: owner } };
    const changed = fingerprint(identity) !== fingerprint(nextIdentity) || fingerprint(ownership) !== fingerprint(nextOwnership);
    if (changed) proposals.push({ variantId, identity: nextIdentity, ownership: nextOwnership, identityDigest: variant.identityDigest ?? null, ownershipDigest: variant.ownershipDigest ?? null, evidence: group.map(r => ({ supplier: r.supplier, supplierProductId: r.supplierProductId, evidence: r.evidence })), ownershipChange: !!existingOwner && existingOwner.supplier !== owner.supplier });
  }
  const summary = Object.fromEntries(Object.keys(SUPPLIERS).map(key => [key, {
    total: rows.filter(r => r.supplier === key).length,
    verified: rows.filter(r => r.supplier === key && r.status === 'verified').length,
    unmatched: rows.filter(r => r.supplier === key && r.status === 'unmatched').length,
    insufficient: rows.filter(r => r.supplier === key && r.status === 'insufficient').length,
    conflicts: rows.filter(r => r.supplier === key && r.status === 'conflict').length,
    overlaps: rows.filter(r => r.supplier === key && r.overlap).length,
  }]));
  return { rows: rows.map(({ variant, ...row }) => ({ ...row, shopifyTitle: variant?.title, currentSku: variant?.sku })), proposals, summary };
}

export function classifyInventory({ supplier, feeds, variants, locationId }) {
  const registry = registryIndex(variants); const records = feeds[supplier].records; const duplicate = duplicates(records);
  const rows = records.map(record => {
    const base = { ...record, variantId: null, inventoryItemId: null, currentQuantity: null, currentSku: '', shopifyTitle: '', delta: null, status: 'skipped', reason: null };
    const result = (status, reason, extra = {}) => ({ ...base, ...extra, status, reason });
    if (!record.supplierProductId) return result('conflict', 'missing-identifier');
    if (duplicate.has(record.supplierProductId)) return result('conflict', 'duplicate-supplier-identifier');
    if (record.quantityError) return result('invalid_quantity', record.quantityError);
    const matches = registry.get(identityKey(supplier, record.supplierProductId)) || [];
    if (!matches.length) return result('unmatched', 'missing-persisted-mapping');
    if (matches.length !== 1) return result('conflict', 'duplicate-shopify-destination');
    const v = matches[0]; const ownership = decodeOwnership(v.ownershipValue); const identity = decodeIdentity(v.identityValue);
    const owner = ownership?.locations[locationId];
    const extra = { variantId: v.variantId, inventoryItemId: v.inventoryItemId, currentQuantity: v.available, currentSku: v.sku, shopifyTitle: v.title, identityDigest: v.identityDigest, ownershipDigest: v.ownershipDigest };
    if (!ownership || !identity || !owner || identity.suppliers[owner.supplier] !== owner.supplierProductId) return result('conflict', 'unresolved-ownership', extra);
    if (owner.supplier !== supplier || owner.supplierProductId !== record.supplierProductId) return result('skipped', feeds[owner.supplier].records.some(r => r.supplierProductId === owner.supplierProductId) ? 'owned-by-other-supplier' : 'ownership-source-missing-review', extra);
    // If another supplier is mapped here, it must be the verified, identical platform record.
    for (const [other, id] of Object.entries(identity.suppliers)) {
      if (other === supplier) continue;
      if (supplier === 'megapap' || other === 'megapap') return result('conflict', 'cross-supplier-identity', extra);
      const otherRows = feeds[other].records.filter(r => r.supplierProductId === id);
      if (otherRows.length > 1 || (otherRows.length === 1 && (id !== record.supplierProductId || !record.platformId || otherRows[0].platformId !== record.platformId))) return result('conflict', 'overlap-evidence-changed', extra);
    }
    if (!v.inventoryItemId || !v.tracked) return result('skipped', 'inventory-not-tracked', extra);
    if (!Number.isSafeInteger(v.available)) return result('skipped', 'location-inventory-unavailable', extra);
    return result(v.available === record.quantity ? 'already' : 'change', null, { ...extra, delta: record.quantity - v.available });
  });
  const destinations = new Map();
  for (const row of rows.filter(r => r.status === 'change' || r.status === 'already')) { const list = destinations.get(row.inventoryItemId) || []; list.push(row); destinations.set(row.inventoryItemId, list); }
  for (const list of destinations.values()) if (list.length > 1) for (const row of list) { row.status = 'conflict'; row.reason = 'multiple-rows-one-destination'; }
  const count = status => rows.filter(r => r.status === status).length;
  return { rows, summary: { feedRows: records.length, validRows: records.filter(r => r.supplierProductId && !r.quantityError).length, matched: rows.filter(r => r.variantId).length, unmatched: count('unmatched'), conflicts: count('conflict'), invalidQuantities: records.filter(r => r.quantityError).length, changes: count('change'), alreadyCorrect: count('already'), skipped: rows.length - count('change') - count('already'), errors: 0 } };
}
