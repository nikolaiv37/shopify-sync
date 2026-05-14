#!/usr/bin/env node
/**
 * Create a new product-renaming V3 job.
 *
 * READ-ONLY. Does not touch Shopify.
 *
 * Usage:
 *   node scripts/product-renaming-v3/create-job.js --category=garden
 *   node scripts/product-renaming-v3/create-job.js --category=garden --query="tag:Градински сетове" --status=ACTIVE
 *   node scripts/product-renaming-v3/create-job.js --category=chairs --query="tag:Тапицирани столове" --status=ACTIVE
 *
 * Writes:
 *   logs/product-renaming-v3/jobs/<jobId>/job.json
 */

import { ensureJobDir, jobDir, newJobId, writeJsonAtomic } from './lib/job-store.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    category: null,
    vendor: null,
    status: 'ACTIVE',
    query: null,
    limit: null,
    jobId: null,
    note: null,
  };
  for (const a of args) {
    if (a.startsWith('--category=')) opts.category = a.slice('--category='.length);
    else if (a.startsWith('--vendor=')) opts.vendor = a.slice('--vendor='.length);
    else if (a.startsWith('--status=')) opts.status = a.slice('--status='.length);
    else if (a.startsWith('--query=')) opts.query = a.slice('--query='.length);
    else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a.startsWith('--job-id=')) opts.jobId = a.slice('--job-id='.length);
    else if (a.startsWith('--note=')) opts.note = a.slice('--note='.length);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const jobId = opts.jobId || newJobId(opts.category);
  const now = new Date().toISOString();

  const job = {
    jobId,
    pipelineVersion: 'v3',
    createdAt: now,
    updatedAt: now,
    status: 'created',
    filters: {
      category: opts.category,
      vendor: opts.vendor,
      status: opts.status,
      query: opts.query,
      limit: opts.limit,
    },
    mutationPolicy: {
      allowed: ['title', 'seo.title', 'seo.description', 'descriptionHtml(modelReplacementOnly)'],
      forbidden: [
        'handle', 'sku', 'vendor', 'productType', 'tags',
        'variants', 'price', 'inventory', 'images', 'status', 'collections',
      ],
      strategy: 'model-name-replacement-only (no title rebuild, no prefixes added)',
    },
    note: opts.note || null,
    phase: {
      exported: false,
      planned: false,
      validated: false,
      applied: false,
    },
  };

  await ensureJobDir(jobId);
  await writeJsonAtomic(jobId, 'job', job);

  console.log();
  console.log('========== V3 Job Created ==========');
  console.log(`Job ID:     ${jobId}`);
  console.log(`Folder:     ${jobDir(jobId)}`);
  console.log(`Category:   ${opts.category || '(auto)'}`);
  console.log(`Vendor:     ${opts.vendor || '(any)'}`);
  console.log(`Status:     ${opts.status}`);
  console.log(`Query:      ${opts.query || '(none)'}`);
  console.log(`Limit:      ${opts.limit || '(none)'}`);
  console.log('====================================');
  console.log();
  console.log(`Next: npm run rename:v3:export -- --job=${jobId}`);
  console.log();

  process.stdout.write(`${jobId}\n`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
