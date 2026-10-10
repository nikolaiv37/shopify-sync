import crypto from 'node:crypto';
import { createShopifyClient } from '../shopify/client.js';
import { NAMESPACE, IDENTITY_KEY, OWNERSHIP_KEY, LOCK_KEY } from './config.js';

export const VARIANT_QUERY = `query inventoryVariants($cursor: String, $location: ID!) {
  productVariants(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id sku barcode
      product { id title handle vendor }
      identity: metafield(namespace: "${NAMESPACE}", key: "${IDENTITY_KEY}") { value compareDigest }
      ownership: metafield(namespace: "${NAMESPACE}", key: "${OWNERSHIP_KEY}") { value compareDigest }
      inventoryItem { id tracked inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }
    }
  }
}`;
export const APP_QUERY = `query inventoryApp {
  currentAppInstallation {
    id accessScopes { handle }
    lock: metafield(namespace: "${NAMESPACE}", key: "${LOCK_KEY}") { value compareDigest }
  }
}`;
export const SET_METADATA = `mutation inventoryMetadata($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { ownerType namespace key value compareDigest } userErrors { field message code } }
}`;
export const SET_QUANTITY = `mutation inventorySet($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) { inventoryAdjustmentGroup { id } userErrors { field message code } }
}`;
export function createInventoryStore(client = createShopifyClient()) {
  const read = (query, variables = {}) => client.gqlWithRetry(query, variables, 'inventory-v2');
  // Mutations are deliberately not automatically retried on unknown transport outcomes.
  async function write(query, variables) {
    for (let attempt = 0; ; attempt++) {
      try { return await client.gql(query, variables); }
      catch (error) {
        // Shopify explicitly rejects throttled requests before execution.
        // Retry those rejections, but never an unknown transport outcome.
        if (!(error.throttled || error.status === 429) || attempt >= 6) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  async function appInfo() {
    const data = await read(APP_QUERY); const app = data.currentAppInstallation;
    if (!app?.id) throw new Error('Shopify app installation is unavailable.');
    return { id: app.id, scopes: app.accessScopes.map(s => s.handle), lock: app.lock };
  }
  async function location() {
    const pinned = process.env.SHOPIFY_LOCATION_ID;
    if (pinned) {
      const d = await read('query inventoryLocation($id: ID!) { location(id: $id) { id name isActive } }', { id: pinned });
      if (!d.location?.isActive) throw new Error('SHOPIFY_LOCATION_ID не сочи към активна локация.');
      return d.location;
    }
    const d = await read('query inventoryLocations { locations(first: 50) { nodes { id name isActive } pageInfo { hasNextPage } } }');
    const active = d.locations.nodes.filter(l => l.isActive);
    if (d.locations.pageInfo.hasNextPage || active.length !== 1) throw new Error('Задайте SHOPIFY_LOCATION_ID: има повече от една активна локация.');
    return active[0];
  }
  async function readVariants(locationId, onProgress = () => {}) {
    const rows = []; let cursor = null;
    for (;;) {
      const d = await read(VARIANT_QUERY, { cursor, location: locationId });
      for (const v of d.productVariants.nodes) rows.push({
        variantId: v.id, sku: v.sku?.trim() || '', barcode: v.barcode?.trim() || '',
        productId: v.product.id, title: v.product.title, handle: v.product.handle, vendor: v.product.vendor,
        identityValue: v.identity?.value ?? null, identityDigest: v.identity?.compareDigest ?? null,
        ownershipValue: v.ownership?.value ?? null, ownershipDigest: v.ownership?.compareDigest ?? null,
        inventoryItemId: v.inventoryItem?.id ?? null, tracked: !!v.inventoryItem?.tracked,
        available: v.inventoryItem?.inventoryLevel?.quantities?.find(q => q.name === 'available')?.quantity ?? null,
      });
      onProgress(rows.length);
      if (!d.productVariants.pageInfo.hasNextPage) return rows;
      cursor = d.productVariants.pageInfo.endCursor;
    }
  }
  async function readVariant(id, locationId) {
    const fields = VARIANT_QUERY.split('    nodes {')[1].split('\n    }\n  }')[0];
    const data = await read(`query inventoryVariant($id: ID!, $location: ID!) { node(id: $id) { ... on ProductVariant { ${fields} } } }`, { id, location: locationId });
    const v = data.node;
    if (!v) return null;
    return { variantId: v.id, sku: v.sku?.trim() || '', barcode: v.barcode?.trim() || '', productId: v.product.id, title: v.product.title, handle: v.product.handle, vendor: v.product.vendor,
      identityValue: v.identity?.value ?? null, identityDigest: v.identity?.compareDigest ?? null, ownershipValue: v.ownership?.value ?? null, ownershipDigest: v.ownership?.compareDigest ?? null,
      inventoryItemId: v.inventoryItem?.id ?? null, tracked: !!v.inventoryItem?.tracked, available: v.inventoryItem?.inventoryLevel?.quantities?.find(q => q.name === 'available')?.quantity ?? null };
  }
  async function setMetafields(metafields) {
    const d = await write(SET_METADATA, { metafields });
    const result = d.metafieldsSet;
    if (!result || result.userErrors?.length || result.metafields?.length !== metafields.length) {
      throw Object.assign(new Error(result?.userErrors?.map(e => e.message).join('; ') || 'Metafield write was not confirmed.'), { definiteRejection: !!result?.userErrors?.length, statusCode: 409 });
    }
    return result.metafields;
  }
  const metadataInput = (ownerId, key, value, compareDigest) => ({ ownerId, namespace: NAMESPACE, key, type: 'json', value: JSON.stringify(value), compareDigest });
  async function withWriterLock(callback) {
    const app = await appInfo(); let previous = null;
    try { previous = app.lock ? JSON.parse(app.lock.value) : null; } catch { throw new Error('Invalid inventory writer lock; inspect before recovery.'); }
    if (previous?.holder) throw Object.assign(new Error('Има активна или прекъсната операция. Проверете историята; възстановяването на заключването изисква отделна команда.'), { statusCode: 409 });
    const holder = crypto.randomUUID();
    const values = await setMetafields([metadataInput(app.id, LOCK_KEY, { holder, startedAt: new Date().toISOString() }, app.lock?.compareDigest ?? null)]);
    const lockDigest = values[0].compareDigest;
    // No automatic lease expiry: an unknown Shopify write outcome must not open a second writer.
    let uncertain = false;
    try { return await callback({ app, markUncertain: () => { uncertain = true; } }); }
    finally {
      if (!uncertain) await setMetafields([metadataInput(app.id, LOCK_KEY, { holder: null, releasedAt: new Date().toISOString() }, lockDigest)]);
    }
  }
  async function readJournal(appId, runId) {
    const d = await read(`query inventoryJournal($id: ID!, $key: String!) { node(id: $id) { ... on AppInstallation { metafield(namespace: "${NAMESPACE}", key: $key) { value compareDigest } } } }`, { id: appId, key: `run_${runId}` });
    const meta = d.node?.metafield;
    return { value: meta ? JSON.parse(meta.value) : null, digest: meta?.compareDigest ?? null };
  }
  async function saveJournal(appId, runId, value, digest) { return setMetafields([metadataInput(appId, `run_${runId}`, value, digest)]); }
  async function history() {
    const rows = []; let cursor = null;
    for (;;) {
      const d = await read(`query inventoryHistory($cursor: String) { currentAppInstallation { metafields(first: 100, after: $cursor, namespace: "${NAMESPACE}") { nodes { key value } pageInfo { hasNextPage endCursor } } } }`, { cursor });
      const page = d.currentAppInstallation.metafields;
      for (const m of page.nodes) if (m.key.startsWith('run_')) { try { const v = JSON.parse(m.value); rows.push(v); } catch { /* Unreadable history is not an invented success. */ } }
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
    return rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 30);
  }
  async function requireDefinitions() {
    for (const key of [IDENTITY_KEY, OWNERSHIP_KEY]) {
      const data = await read(`query inventoryDefinitionReady($key: String!) { metafieldDefinitions(first: 10, ownerType: PRODUCTVARIANT, namespace: "${NAMESPACE}", key: $key) { nodes { key type { name } access { admin } } } }`, { key });
      const defs = data.metafieldDefinitions.nodes;
      if (defs.length !== 1 || defs[0].type.name !== 'json' || defs[0].access.admin !== 'MERCHANT_READ') throw Object.assign(new Error('Първо създайте и проверете защитените дефиниции за идентичност и собственост чрез init-definitions.'), { statusCode: 409 });
    }
  }
  async function persistProposal(proposal) {
    return setMetafields([
      metadataInput(proposal.variantId, IDENTITY_KEY, proposal.identity, proposal.identityDigest),
      metadataInput(proposal.variantId, OWNERSHIP_KEY, proposal.ownership, proposal.ownershipDigest),
    ]);
  }
  async function setQuantity(row, locationId, runId) {
    const d = await write(SET_QUANTITY, { input: { name: 'available', reason: 'correction', referenceDocumentUri: `logistics://mebelcenter/inventory/${runId}`, quantities: [{ inventoryItemId: row.inventoryItemId, locationId, quantity: row.quantity, compareQuantity: row.currentQuantity }] } });
    const result = d.inventorySetQuantities;
    if (result?.userErrors?.length) return { status: result.userErrors.some(e => e.code === 'COMPARE_QUANTITY_STALE') ? 'stale' : 'failed', reason: result.userErrors.map(e => e.message).join('; ') };
    return result?.inventoryAdjustmentGroup?.id ? { status: 'success' } : { status: 'failed', reason: 'Shopify did not confirm an inventory adjustment.' };
  }
  async function setDefinition(definition) {
    const data = await write(`mutation inventoryDefinition($definition: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $definition) { createdDefinition { id key } userErrors { field message code } } }`, { definition });
    const result = data.metafieldDefinitionCreate;
    if (result.userErrors?.length || !result.createdDefinition) throw new Error(result.userErrors?.map(e => e.message).join('; ') || 'Definition creation not confirmed.');
    return result.createdDefinition;
  }
  return { requireDefinitions, setDefinition, appInfo, location, readVariants, readVariant, withWriterLock, persistProposal, setQuantity, readJournal, saveJournal, history, read, setMetafields, metadataInput };
}
