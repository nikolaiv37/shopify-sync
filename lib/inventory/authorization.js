import crypto from 'node:crypto';
import { INVENTORY_VERSION, PREVIEW_TTL_MS } from './config.js';
export function signingKey(env = process.env) {
  const secret = env.INVENTORY_PREVIEW_SECRET || env.SHOPIFY_CLIENT_SECRET;
  if (!secret) throw new Error('Липсва ключ за подписване на прегледа.');
  return crypto.createHmac('sha256', secret).update(`inventory-preview:${env.SHOPIFY_STORE_DOMAIN || ''}`).digest();
}
export function signPreview(payload, { key = signingKey(), now = Date.now() } = {}) {
  const encoded = Buffer.from(JSON.stringify({ ...payload, version: INVENTORY_VERSION, issuedAt: now, expiresAt: now + PREVIEW_TTL_MS })).toString('base64url');
  return `${encoded}.${crypto.createHmac('sha256', key).update(encoded).digest('base64url')}`;
}
export function verifyPreview(token, expected, { key = signingKey(), now = Date.now() } = {}) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 409 }); };
  if (typeof token !== 'string' || token.length > 200000) fail('Липсва валиден подписан преглед.');
  const [encoded, sig, extra] = token.split('.');
  const digest = crypto.createHmac('sha256', key).update(encoded || '').digest();
  const supplied = Buffer.from(sig || '', 'base64url');
  if (extra || supplied.length !== digest.length || !crypto.timingSafeEqual(supplied, digest)) fail('Прегледът е променен или невалиден.');
  let payload; try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { fail('Невалиден преглед.'); }
  if (payload.version !== INVENTORY_VERSION || !Number.isFinite(payload.expiresAt) || now >= payload.expiresAt || payload.issuedAt > now) fail('Прегледът е изтекъл. Направете нов преглед.');
  for (const [field, value] of Object.entries(expected)) if (payload[field] !== value) fail(`Прегледът не съответства: ${field}.`);
  return payload;
}
