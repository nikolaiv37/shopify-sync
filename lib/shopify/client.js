/**
 * Shared Shopify Admin GraphQL client.
 *
 * Consolidates the OAuth `client_credentials` token exchange + GraphQL
 * request/retry logic that was previously copy-pasted inline across many
 * scripts (export-missing-products.js, update-prices.js, etc.). This module is
 * additive: existing scripts keep their own inline clients until they are
 * migrated. New code (missing-products) uses this shared client.
 *
 * Read/write is decided by the caller's queries — this module performs no
 * mutations on its own.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a Shopify client from environment variables.
 *
 * @param {object} [env=process.env]
 * @returns {{ ensureToken(): Promise<string>, gql(query, variables?): Promise<any>,
 *             gqlWithRetry(query, variables?, label?, maxTries?): Promise<any>,
 *             endpoint: string, apiVersion: string, storeDomain: string }}
 */
export function createShopifyClient(env = process.env) {
  const storeDomain = env.SHOPIFY_STORE_DOMAIN;
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  const apiVersion = env.SHOPIFY_API_VERSION || '2025-10';

  if (!storeDomain || !clientId || !clientSecret) {
    throw new Error(
      'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in the environment.',
    );
  }

  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;
  const tokenUrl = `https://${storeDomain}/admin/oauth/access_token`;

  let accessToken = null;

  async function ensureToken() {
    if (accessToken) return accessToken;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Access-token request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Access-token response not JSON: ${text.slice(0, 300)}`);
    }
    if (!json.access_token) {
      throw new Error(`Access-token response missing access_token: ${text.slice(0, 300)}`);
    }
    accessToken = json.access_token;
    return accessToken;
  }

  async function gql(query, variables = {}) {
    const token = await ensureToken();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`);
      err.status = res.status;
      throw err;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
    }
    if (json.errors) {
      const msg = JSON.stringify(json.errors);
      const err = new Error(msg.slice(0, 600));
      err.throttled = msg.includes('THROTTLED');
      throw err;
    }
    return json.data;
  }

  async function gqlWithRetry(query, variables = {}, label = 'gql', maxTries = 6) {
    let attempt = 0;
    for (;;) {
      try {
        return await gql(query, variables);
      } catch (e) {
        attempt++;
        if (attempt > maxTries) throw e;
        const wait = e.throttled ? 5000 : Math.min(1000 * 2 ** (attempt - 1), 15000);
        await sleep(wait);
      }
    }
  }

  return { ensureToken, gql, gqlWithRetry, endpoint, apiVersion, storeDomain };
}
