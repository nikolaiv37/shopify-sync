import crypto from 'node:crypto';
import { BATCH_SIZE, INVENTORY_VERSION, PREVIEW_TTL_MS, SUPPLIERS, supplierConfig } from './config.js';
import { loadFeeds, feedFingerprint, fingerprint } from './feeds.js';
import { classifyInventory, discoverIdentities, decodeIdentity, decodeOwnership } from './identity.js';
import { signPreview, verifyPreview } from './authorization.js';
import { createInventoryStore } from './shopify.js';

const error = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
export function requireConfirmation(confirm) { if (confirm !== true) throw error('Реалната операция изисква изрично потвърждение.', 400); }
const outcomeCounts = results => ({ updated: results.filter(r => r.status === 'success').length, skipped: results.filter(r => ['stale', 'conflict', 'already', 'skipped'].includes(r.status)).length, errors: results.filter(r => r.status === 'failed').length });
export function createInventoryService({ store = createInventoryStore(), getFeeds = loadFeeds, auth = {}, now = () => Date.now() } = {}) {
  async function snapshot(onProgress, supplier, setupRunId) {
    onProgress?.({ stage: 'feed', supplier });
    const [feeds, location, app] = await Promise.all([scopedFeeds(supplier), store.location(), store.appInfo()]);
    onProgress?.({ stage: 'shopify', supplier });
    let variants;
    if (setupRunId) {
      const journal = await store.readJournal(app.id, setupRunId);
      const run = journal.value;
      if (run?.operation !== 'backfill' || run.feedSupplier !== supplier || run.locationId !== location.id || !Array.isArray(run.variantIds)) throw error('Няма завършено съпоставяне за този доставчик. Направете нов преглед.');
      variants = [];
      for (let offset = 0; offset < run.variantIds.length; offset += BATCH_SIZE) {
        const ids = run.variantIds.slice(offset, offset + BATCH_SIZE);
        variants.push(...(store.readVariantBatch ? await store.readVariantBatch(ids, location.id) : (await Promise.all(ids.map(id => store.readVariant(id, location.id)))).filter(Boolean)));
        onProgress?.({ stage: 'quantities', processed: variants.length, total: run.variantIds.length });
      }
    } else variants = await store.readVariants(location.id, onProgress, supplier, supplier ? feeds[supplier].records : []);
    return { feeds, location, app, variants, feedHash: feedFingerprint(feeds) };
  }
  async function scopedFeeds(supplier) {
    const loaded = await getFeeds({ supplier });
    return Object.fromEntries(Object.keys(SUPPLIERS).map(key => [key, (!supplier || key === supplier) ? loaded[key] : { records: [], fingerprint: 'not-requested' }]));
  }
  async function batchSnapshot(payload) {
    const [feeds, location, app] = await Promise.all([scopedFeeds(payload.feedSupplier), store.location(), store.appInfo()]);
    const ids = [...new Set(payload.items.map(item => item.variantId))];
    const variants = store.readVariantBatch ? await store.readVariantBatch(ids, location.id) : (await Promise.all(ids.map(id => store.readVariant(id, location.id)))).filter(Boolean);
    return { feeds, location, app, variants, feedHash: feedFingerprint(feeds) };
  }
  function discoveryReport(snap, supplier, overrides = {}) {
    const generatedAt = new Date(now()).toISOString();
    const discovered = discoverIdentities({ ...snap, locationId: snap.location.id, overrides, now: generatedAt });
    const resolutions = {
      'missing-identifier': 'Repair the canonical supplier identifier in the source feed; do not substitute ItemCode.',
      'duplicate-supplier-identifier': 'Ask the supplier to disambiguate duplicate canonical records before mapping.',
      'duplicate-shopify-destination': 'Inspect the listed variant mappings and resolve the duplicate canonical identity through a separately reviewed migration.',
      'ambiguous-evidence': 'Inspect candidate variant GIDs and exact legacy references; obtain another independent reference before mapping.',
      'insufficient-evidence': 'Obtain an independent barcode, historical import reference, or exact legacy identifier; a current SKU alone is insufficient.',
      'cross-supplier-or-destination-conflict': 'Verify both canonical identities and ProductId against the candidate destination. An ownership override cannot establish identity.',
      'ownership-source-missing': 'Review the recorded owner and absent source. Transfer ownership only through an explicit reasoned override.',
      'invalid-ownership-override': 'Choose a verified supplier identity and provide an auditable reason.',
      'existing-identity-conflict': 'Review the existing immutable mapping and source evidence before a separately authorized correction.',
      'missing-shopify-variant': 'Use the Missing Products workflow after reviewing the catalog record; no inventory write is proposed.',
    };
    const variantById = new Map(snap.variants.map(v => [v.variantId, v]));
    const rows = discovered.rows.filter(row => !supplier || row.supplier === supplier).map(row => ({ ...row, currentQuantity: variantById.get(row.variantId)?.available ?? null, delta: null, suggestedResolution: resolutions[row.reason] || null }));
    const proposals = discovered.proposals.filter(p => !supplier || p.ownership.locations[snap.location.id]?.supplier === supplier);
    const runId = crypto.randomUUID();
    const base = { kind: 'backfill', target: 'shopify', supplier: 'all', feedSupplier: supplier, locationId: snap.location.id, feedHash: snap.feedHash, runId, overrides, decisionAt: generatedAt };
    return { version: INVENTORY_VERSION, runId, generatedAt, expiresAt: new Date(now() + PREVIEW_TTL_MS).toISOString(), location: snap.location, supplier, summary: discovered.summary, rows, proposedMappings: proposals.length, prerequisites: snap.app.scopes.includes('write_products') ? [] : ['Нужен е Shopify scope write_products за запис на идентичностите.'], batches: tokensFor(base, proposals) };
  }
  function tokensFor(payload, items) {
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) batches.push(signPreview({ ...payload, part: i / BATCH_SIZE, totalParts: Math.ceil(items.length / BATCH_SIZE), items: items.slice(i, i + BATCH_SIZE) }, { ...auth, now: now() }));
    return batches;
  }
  async function discovery({ overrides = {}, onProgress, supplier } = {}) {
    if (supplier !== undefined) supplierConfig(supplier);
    return discoveryReport(await snapshot(onProgress, supplier), supplier, overrides);
  }
  async function preview({ supplier, onProgress, allowPartial = false, setupRunId } = {}) {
    supplierConfig(supplier); const snap = await snapshot(onProgress, supplier, setupRunId);
    const prerequisites = [];
    try { await store.requireDefinitions(); }
    catch (e) { if (e.statusCode !== 409) throw e; prerequisites.push(e.message); }
    const classified = classifyInventory({ ...snap, supplier, locationId: snap.location.id });
    const discovery = discoverIdentities({ ...snap, locationId: snap.location.id });
    for (const row of classified.rows) if (row.reason === 'missing-persisted-mapping') {
      const candidate = discovery.rows.find(r => r.rowId === row.rowId);
      if (candidate?.status === 'unmatched') row.reason = 'missing-shopify-variant';
    }
    const mappingMissing = classified.rows.filter(r => r.reason === 'missing-persisted-mapping').length;
    const ready = mappingMissing === 0 && classified.summary.conflicts === 0 && prerequisites.length === 0;
    const eligible = classified.rows.filter(r => r.status === 'change' || r.status === 'already').length;
    const changePercent = eligible ? Math.round(classified.summary.changes / eligible * 1000) / 10 : 0;
    const runId = crypto.randomUUID();
    const base = { kind: 'inventory', target: 'shopify', supplier, feedSupplier: supplier, locationId: snap.location.id, feedHash: snap.feedHash, runId, changePercent, thresholdExceeded: changePercent > 40 };
    const canWrite = snap.app.scopes.includes('write_inventory');
    if (!canWrite) prerequisites.push('Shopify scope write_inventory is required.');
    const partial = allowPartial === true;
    const authorized = prerequisites.length === 0 && (ready || partial);
    return { version: INVENTORY_VERSION, runId, generatedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + PREVIEW_TTL_MS).toISOString(), supplier, destination: 'shopify', location: snap.location, mappingReady: ready, mappingMissing, partial, canApply: authorized && classified.summary.changes > 0, changePercent, thresholdExceeded: changePercent > 40, prerequisites, setup: mappingMissing || prerequisites.length ? discoveryReport(snap, supplier) : undefined, ...classified, batches: authorized ? tokensFor({ ...base, partial }, classified.rows.filter(r => r.status === 'change')) : [] };
  }
  async function journaled(payload, operation, callback) {
    return store.withWriterLock(async ({ app, markUncertain }) => {
      const journal = await store.readJournal(app.id, payload.runId);
      if (journal.value?.completed?.[payload.part]) return { results: [], counts: journal.value.completed[payload.part], replayed: true };
      const state = journal.value || { runId: payload.runId, operation, supplier: payload.supplier, feedSupplier: payload.feedSupplier, target: 'shopify', locationId: payload.locationId, startedAt: new Date(now()).toISOString(), totalParts: payload.totalParts, completed: {}, totals: { updated: 0, skipped: 0, errors: 0 }, problems: [] };
      try {
        const results = await callback(markUncertain);
        if (operation === 'backfill') state.variantIds = [...new Set([...(state.variantIds || []), ...results.filter(r => ['success', 'already'].includes(r.status)).map(r => r.variantId)])];
        const counts = outcomeCounts(results); state.completed[payload.part] = counts;
        for (const key of ['updated', 'skipped', 'errors']) state.totals[key] += counts[key];
        state.problems = [...state.problems, ...results.filter(r => r.status !== 'success' && r.status !== 'already')].slice(0, 20);
        state.finishedAt = new Date(now()).toISOString();
        state.status = Object.keys(state.completed).length < payload.totalParts ? 'partial' : state.totals.errors || state.totals.skipped ? 'partial_failure' : 'complete';
        try { await store.saveJournal(app.id, payload.runId, state, journal.digest); } catch (e) { markUncertain(); throw e; }
        return { results, counts, run: state };
      } catch (e) { throw e; }
    });
  }
  function authorize(token, kind, supplier, confirm) {
    requireConfirmation(confirm);
    const payload = verifyPreview(token, { kind, supplier, target: 'shopify' }, { ...auth, now: now() });
    if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > BATCH_SIZE) throw error('Невалидна партида.');
    return payload;
  }
  async function persistBatch({ token, confirm, allowOwnershipChange = false, initializeDefinitions = false } = {}) {
    const payload = authorize(token, 'backfill', 'all', confirm);
    if (payload.items.some(p => p.ownershipChange) && allowOwnershipChange !== true) throw error('Промяна на собственост изисква отделно потвърждение.');
    if (initializeDefinitions === true) {
      const { initializeIdentityDefinitions } = await import('./setup.js');
      await initializeIdentityDefinitions({ confirm: true, store });
    }
    await store.requireDefinitions();
    return journaled(payload, 'backfill', async markUncertain => {
      const snap = await batchSnapshot(payload);
      if (!snap.app.scopes.includes('write_products')) throw error('Липсва Shopify scope write_products.', 403);
      if (snap.location.id !== payload.locationId || snap.feedHash !== payload.feedHash) throw error('Локацията или каталогът е променен. Направете нов преглед на съпоставянето.');
      const current = discoverIdentities({ ...snap, locationId: payload.locationId, overrides: payload.overrides, now: payload.decisionAt });
      const results = [], eligible = [];
      for (const proposal of payload.items) {
        const v = snap.variants.find(v => v.variantId === proposal.variantId);
        const already = v && fingerprint(decodeIdentity(v.identityValue)) === fingerprint(proposal.identity) && fingerprint(decodeOwnership(v.ownershipValue)) === fingerprint(proposal.ownership);
        if (already) { results.push({ variantId: proposal.variantId, status: 'already' }); continue; }
        const live = current.proposals.find(p => p.variantId === proposal.variantId);
        if (!live || fingerprint(live) !== fingerprint(proposal)) { results.push({ variantId: proposal.variantId, status: 'conflict', reason: 'identity-evidence-changed' }); continue; }
        eligible.push(live);
      }
      for (let offset = 0; offset < eligible.length; offset += 12) {
        const group = eligible.slice(offset, offset + 12);
        try {
          if (store.persistProposals) await store.persistProposals(group);
          else for (const proposal of group) await store.persistProposal(proposal);
          const checks = store.readVariantBatch ? await store.readVariantBatch(group.map(p => p.variantId), payload.locationId) : await Promise.all(group.map(p => store.readVariant(p.variantId, payload.locationId)));
          for (const proposal of group) {
            const check = checks.find(v => v?.variantId === proposal.variantId);
            if (!check || fingerprint(decodeIdentity(check.identityValue)) !== fingerprint(proposal.identity) || fingerprint(decodeOwnership(check.ownershipValue)) !== fingerprint(proposal.ownership)) throw new Error('Identity persistence verification failed.');
            results.push({ variantId: proposal.variantId, status: 'success' });
          }
        } catch (e) {
          if (!e.definiteRejection) { markUncertain(); throw error('Неясен резултат от запис на идентичност. Заключването остава за проверка: ' + e.message, 503); }
          results.push(...group.map(p => ({ variantId: p.variantId, status: 'failed', reason: e.message })));
        }
      }
      return results;
    });
  }
  async function applyBatch({ supplier, token, confirm, allowLargeApply = false } = {}) {
    supplierConfig(supplier); const payload = authorize(token, 'inventory', supplier, confirm);
    if (payload.thresholdExceeded && allowLargeApply !== true) throw error('Промените надхвърлят 40%. Изисква се отделно одобрение на голяма синхронизация.');
    await store.requireDefinitions();
    return journaled(payload, 'inventory', async markUncertain => {
      const snap = await batchSnapshot(payload);
      if (!snap.app.scopes.includes('write_inventory')) throw error('Липсва Shopify scope write_inventory.', 403);
      if (snap.location.id !== payload.locationId || snap.feedHash !== payload.feedHash) throw error('Локацията или каталогът е променен. Направете нов преглед.');
      const classified = classifyInventory({ ...snap, supplier, locationId: payload.locationId });
      if (classified.summary.conflicts && payload.partial !== true) throw error('Идентичностите вече не са готови за синхронизация. Направете нов преглед.');
      const results = [], eligible = [];
      for (const request of payload.items) {
        const indexed = classified.rows.find(r => r.rowId === request.rowId);
        if (!indexed || !['change', 'already'].includes(indexed.status)) {
          results.push({ variantId: request.variantId, rowId: request.rowId, status: 'conflict', reason: indexed?.reason || 'mapping-changed' }); continue;
        }
        const record = snap.feeds[supplier].records.find(r => r.rowId === request.rowId);
        const live = snap.variants.find(v => v.variantId === request.variantId);
        const fresh = live && record ? classifyInventory({ supplier, feeds: { ...snap.feeds, [supplier]: { ...snap.feeds[supplier], records: [record] } }, variants: [live], locationId: payload.locationId }).rows[0] : null;
        if (!fresh || !['change', 'already'].includes(fresh.status) || fresh.variantId !== request.variantId || fresh.inventoryItemId !== request.inventoryItemId || fresh.identityDigest !== request.identityDigest || fresh.ownershipDigest !== request.ownershipDigest || fresh.quantity !== request.quantity) {
          results.push({ variantId: request.variantId, rowId: request.rowId, status: 'conflict', reason: fresh?.reason || 'identity-or-ownership-changed' }); continue;
        }
        if (fresh.status === 'already') { results.push({ variantId: request.variantId, rowId: request.rowId, status: 'already' }); continue; }
        if (fresh.currentQuantity !== request.currentQuantity) { results.push({ variantId: request.variantId, rowId: request.rowId, status: 'stale', reason: 'quantity-changed-after-preview' }); continue; }
        eligible.push(request);
      }
      if (eligible.length) {
        try {
          if (store.setQuantities) results.push(...await store.setQuantities(eligible, payload.locationId, payload.runId));
          else for (const request of eligible) results.push({ variantId: request.variantId, rowId: request.rowId, ...await store.setQuantity(request, payload.locationId, payload.runId) });
        } catch (e) {
          markUncertain(); throw error('Неясен резултат от Shopify. Операцията е спряна за проверка: ' + e.message, 503);
        }
      }
      return results;
    });
  }
  return { discovery, preview, persistBatch, applyBatch, history: () => store.history(), snapshot };
}
