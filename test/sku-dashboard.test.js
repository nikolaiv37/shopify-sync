import test from 'node:test';
import assert from 'node:assert/strict';

import { executeWriteJobs } from '../lib/sku/dashboard.js';

test('SKU product mutations run concurrently and return every result', async () => {
  let active = 0;
  let maxActive = 0;
  const client = {
    async gqlWithRetry(_query, variables) {
      for (const variant of variables.variants) {
        assert.equal('sku' in variant, false, 'SKU must not be sent directly on ProductVariantsBulkInput');
        assert.match(variant.inventoryItem?.sku || '', /^new-/);
      }
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return {
        productVariantsBulkUpdate: {
          productVariants: variables.variants,
          userErrors: [],
        },
      };
    },
  };
  const jobs = Array.from({ length: 20 }, (_, index) => ({
    productId: `product:${index}`,
    rows: [{ variantId: `variant:${index}`, oldSku: `old-${index}`, newSku: `new-${index}` }],
  }));

  const results = await executeWriteJobs(client, jobs);
  assert.equal(results.length, 20);
  assert.ok(results.every((row) => row.status === 'success'));
  assert.ok(maxActive > 1, 'mutations should not be sequential');
  assert.ok(maxActive <= 8, 'bounded concurrency must be respected');
});
