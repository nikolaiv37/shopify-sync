#!/usr/bin/env node
/**
 * Export Shopify products into a V3 job folder.
 *
 * READ-ONLY. No mutations.
 *
 * Usage:
 *   node scripts/product-renaming-v3/export-job-products.js --job=<jobId>
 *   node scripts/product-renaming-v3/export-job-products.js --job=<jobId> --resume
 */

import { createShopifyClient } from './lib/shopify-client.js';
import {
  jobDir,
  jobExists,
  readJson,
  updateJobStatus,
  writeJsonAtomic,
} from './lib/job-store.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { job: null, resume: false };
  for (const a of args) {
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else if (a === '--resume') opts.resume = true;
  }
  return opts;
}

function buildQuery(filters) {
  if (filters.query) return filters.query;
  const parts = [];
  if (filters.status) parts.push(`status:${filters.status}`);
  if (filters.vendor) parts.push(`product.vendor:${filters.vendor}`);
  return parts.join(' ');
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.job) {
    console.error('ERROR: --job=<jobId> is required.');
    process.exit(1);
  }
  if (!(await jobExists(opts.job))) {
    console.error(`ERROR: Job folder does not exist: ${jobDir(opts.job)}`);
    process.exit(1);
  }

  const job = await readJson(opts.job, 'job');
  if (!job) {
    console.error('ERROR: job.json missing.');
    process.exit(1);
  }

  const filters = job.filters || {};
  const query = buildQuery(filters);
  console.log(`[${new Date().toISOString()}] V3 Job ${opts.job}`);
  console.log(`Query: ${query || '(empty)'}`);
  console.log(`Limit: ${filters.limit || '(none)'}`);
  console.log(`Resume: ${opts.resume ? 'yes' : 'no'}`);

  let existing = await readJson(opts.job, 'export');
  let products = [];
  let cursor = null;
  if (opts.resume && existing && Array.isArray(existing.products)) {
    products = existing.products;
    cursor = existing.cursor || null;
    console.log(`Resuming from ${products.length} products, cursor=${cursor ? 'present' : 'null'}`);
  }

  const client = createShopifyClient();
  await client.ensureToken();
  const seenIds = new Set(products.map((p) => p.id));

  for await (const page of client.paginateProducts({ query, startCursor: cursor })) {
    for (const p of page.nodes) {
      if (seenIds.has(p.id)) continue;
      products.push({
        id: p.id,
        handle: p.handle,
        title: p.title,
        descriptionHtml: p.descriptionHtml,
        vendor: p.vendor,
        productType: p.productType,
        tags: p.tags,
        status: p.status,
        seoTitle: p.seo?.title || null,
        seoDescription: p.seo?.description || null,
        variantSkus: (p.variants?.nodes || []).map((v) => ({
          id: v.id, sku: v.sku, title: v.title,
        })),
      });
      seenIds.add(p.id);
      if (filters.limit && products.length >= filters.limit) break;
    }

    await writeJsonAtomic(opts.job, 'export', {
      jobId: opts.job,
      query,
      filters,
      timestamp: new Date().toISOString(),
      totalExported: products.length,
      cursor: page.endCursor,
      hasNextPage: page.hasNextPage,
      products,
    });

    if (filters.limit && products.length >= filters.limit) {
      console.log(`Reached limit ${filters.limit}.`);
      break;
    }
    if (products.length % 200 === 0) {
      console.log(`Exported ${products.length}... (page ${page.page})`);
    }
  }

  await writeJsonAtomic(opts.job, 'export', {
    jobId: opts.job,
    query,
    filters,
    timestamp: new Date().toISOString(),
    totalExported: products.length,
    cursor: null,
    hasNextPage: false,
    products,
  });

  await updateJobStatus(opts.job, {
    status: 'exported',
    phase: { ...(job.phase || {}), exported: true },
    exportSummary: {
      totalExported: products.length,
      query,
      completedAt: new Date().toISOString(),
    },
  });

  console.log();
  console.log('========== Export complete ==========');
  console.log(`Total exported: ${products.length}`);
  console.log(`Folder:         ${jobDir(opts.job)}`);
  console.log('=====================================');
  console.log();
  console.log(`Next: npm run rename:v3:plan -- --job=${opts.job}`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
