/**
 * Shared Shopify Admin GraphQL client for product-renaming V2.
 *
 * Owns: access-token acquisition, gql() with retry + throttle handling,
 * and a couple of typed helpers (fetchProduct, paginate, productUpdate).
 *
 * Mutation policy is enforced by callers — this client only exposes
 * exactly the fields V1 already mutates (title, seo.title, seo.description,
 * descriptionHtml). It deliberately exposes no setters for handle, SKU,
 * vendor, productType, tags, variants, price, inventory, images, status,
 * or collections.
 */

import 'dotenv/config';

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2025-10',
} = process.env;

function requireEnv() {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      'Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in .env',
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createShopifyClient() {
  requireEnv();
  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const tokenUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`;
  let accessToken = null;

  async function fetchAccessToken() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
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
      throw new Error(`Access-token request failed: HTTP ${res.status} ${text.slice(0, 400)}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Access-token response not JSON: ${text.slice(0, 400)}`);
    }
    if (!json.access_token) {
      throw new Error(`Access-token response missing access_token: ${text.slice(0, 400)}`);
    }
    return json.access_token;
  }

  async function ensureToken() {
    if (!accessToken) accessToken = await fetchAccessToken();
    return accessToken;
  }

  async function gql(query, variables = {}) {
    await ensureToken();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response: ${text.slice(0, 400)}`);
    }
    if (json.errors) {
      const msg = JSON.stringify(json.errors);
      const err = new Error(`GraphQL errors: ${msg.slice(0, 800)}`);
      err.isSchemaError = msg.includes('Field ') && msg.includes("doesn't exist on type");
      throw err;
    }
    return json.data;
  }

  async function gqlWithRetry(query, variables, label, maxTries = 6) {
    let attempt = 0;
    for (;;) {
      try {
        return await gql(query, variables);
      } catch (e) {
        if (e.isSchemaError) throw e;
        attempt++;
        if (attempt > maxTries) throw e;
        const throttled = e.message?.includes('THROTTLED') || e.message?.includes('rate limit');
        const wait = throttled ? 5000 : Math.min(1000 * 2 ** (attempt - 1), 15000);
        console.warn(
          `[${label}] ${throttled ? 'THROTTLED' : 'ERROR'} (try ${attempt}/${maxTries}), sleeping ${wait}ms: ${String(e.message).slice(0, 180)}`,
        );
        await sleep(wait);
      }
    }
  }

  const PRODUCT_FIELDS = `
    id
    handle
    title
    descriptionHtml
    vendor
    productType
    tags
    status
    seo { title description }
    variants(first: 5) {
      nodes { id sku title }
    }
  `;

  async function* paginateProducts({ query, pageSize = 100, startCursor = null }) {
    let cursor = startCursor;
    let page = 0;
    for (;;) {
      page++;
      const data = await gqlWithRetry(
        `query products($cursor: String, $query: String!) {
          products(first: ${pageSize}, after: $cursor, query: $query) {
            pageInfo { hasNextPage endCursor }
            nodes { ${PRODUCT_FIELDS} }
          }
        }`,
        { cursor, query },
        `page ${page}`,
      );
      const pageInfo = data.products.pageInfo;
      yield {
        page,
        nodes: data.products.nodes,
        endCursor: pageInfo.endCursor,
        hasNextPage: pageInfo.hasNextPage,
      };
      if (!pageInfo.hasNextPage) return;
      cursor = pageInfo.endCursor;
      await sleep(150);
    }
  }

  async function fetchProduct(productId) {
    const data = await gqlWithRetry(
      `query product($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          seo { title description }
          descriptionHtml
        }
      }`,
      { id: productId },
      `fetch ${productId.slice(-10)}`,
    );
    return data.product;
  }

  /**
   * Apply the limited mutation scope. Caller passes only the fields it wants
   * to update; anything not in this signature is intentionally unreachable.
   */
  async function updateProductRename({ productId, newTitle, newSeoTitle, newSeoDescription, newDescriptionHtml }) {
    const input = { id: productId };
    if (newTitle !== undefined && newTitle !== null) input.title = newTitle;
    if (newSeoTitle !== undefined && newSeoTitle !== null) {
      input.seo = input.seo || {};
      input.seo.title = newSeoTitle;
    }
    if (newSeoDescription !== undefined && newSeoDescription !== null) {
      input.seo = input.seo || {};
      input.seo.description = newSeoDescription;
    }

    const mutation = `mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id title handle seo { title description } }
        userErrors { field message }
      }
    }`;

    const main = await gqlWithRetry(mutation, { input }, `update ${productId.slice(-10)}`);

    if (newDescriptionHtml) {
      const descMutation = `mutation productUpdateDescription($input: ProductInput!) {
        productUpdate(input: $input) {
          product { id descriptionHtml }
          userErrors { field message }
        }
      }`;
      const descResult = await gqlWithRetry(
        descMutation,
        { input: { id: productId, descriptionHtml: newDescriptionHtml } },
        `update-desc ${productId.slice(-10)}`,
      );
      const descErrors = descResult.productUpdate?.userErrors || [];
      if (descErrors.length > 0) {
        return {
          userErrors: [...(main.productUpdate.userErrors || []), ...descErrors],
          product: main.productUpdate.product,
        };
      }
    }

    return main.productUpdate;
  }

  return {
    ensureToken,
    gql: gqlWithRetry,
    paginateProducts,
    fetchProduct,
    updateProductRename,
    apiVersion: SHOPIFY_API_VERSION,
    domain: SHOPIFY_STORE_DOMAIN,
  };
}

export { sleep };
