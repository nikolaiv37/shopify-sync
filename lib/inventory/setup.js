import { NAMESPACE, IDENTITY_KEY, OWNERSHIP_KEY, LOCK_KEY } from './config.js';
import { requireConfirmation } from './service.js';
import { createInventoryStore } from './shopify.js';

// Runtime definitions are used because this is an existing client-credentials
// operations app, with no CLI-managed Shopify app TOML or deployment lifecycle.
export const CREATE_DEFINITION = `mutation inventoryDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) { createdDefinition { id key } userErrors { field message code } }
}`;
export async function initializeIdentityDefinitions({ confirm, store = createInventoryStore() } = {}) {
  requireConfirmation(confirm); const app = await store.appInfo();
  if (!app.scopes.includes('write_products')) throw new Error('Requires Shopify write_products scope; do not change credentials automatically.');
  const outcomes = [];
  for (const [key, name] of [[IDENTITY_KEY, 'Mebelcenter supplier identity'], [OWNERSHIP_KEY, 'Mebelcenter stock ownership']]) {
    const data = await store.read(`query inventoryDefinitionExists($key: String!) { metafieldDefinitions(first: 10, ownerType: PRODUCTVARIANT, namespace: "${NAMESPACE}", key: $key) { nodes { id key type { name } access { admin } } } }`, { key });
    const definitions = data.metafieldDefinitions.nodes;
    if (definitions.length) {
      if (definitions.length !== 1 || definitions[0].type.name !== 'json' || definitions[0].access.admin !== 'MERCHANT_READ') throw new Error('Existing identity definition has incompatible type/access; review manually.');
      outcomes.push({ key, status: 'already' }); continue;
    }
    // Do not retry definition writes blindly on uncertain outcomes.
    const result = await store.setDefinition({ name, namespace: NAMESPACE, key, type: 'json', ownerType: 'PRODUCTVARIANT', access: { admin: 'MERCHANT_READ' } });
    outcomes.push({ key, status: 'created', id: result.id });
  }
  return outcomes;
}
export async function recoverWriterLock({ confirm, expectedHolder, reason, store = createInventoryStore() } = {}) {
  requireConfirmation(confirm);
  if (!expectedHolder || !reason) throw new Error('Recovery requires exact observed holder and an audit reason after verifying no operation is still active.');
  const app = await store.appInfo(); const lock = app.lock ? JSON.parse(app.lock.value) : null;
  if (lock?.holder !== expectedHolder) throw new Error('Lock holder changed or absent; recovery aborted.');
  return store.setMetafields([store.metadataInput(app.id, LOCK_KEY, { holder: null, recoveredHolder: expectedHolder, reason, recoveredAt: new Date().toISOString() }, app.lock.compareDigest)]);
}
