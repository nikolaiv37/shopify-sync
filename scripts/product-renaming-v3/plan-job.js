#!/usr/bin/env node
/**
 * Generate plan.json for a V3 job.
 *
 * READ-ONLY. No mutations.
 *
 * Pipeline per product:
 *   1. Already-renamed protection (prefix match OR controlled-name body match)
 *      → skipped_already_renamed.
 *   2. Detect old model.
 *      - none           → skipped_no_model
 *      - ambiguous      → needs_review
 *      - controlled     → skipped_already_renamed (model-level protection)
 *   3. Allocate a new V3 controlled name (deterministic per category+oldModel).
 *   4. Replace old model with the new name in title, seo.title, seo.description,
 *      descriptionHtml. Counts are recorded.
 *   5. Quality decision (status grid in lib/validation.js):
 *      ready | needs_review | blocked
 */

import {
  detectCategoryFromProduct,
} from '../product-renaming/name-dictionaries.js';
import {
  hashJobFile,
  jobDir,
  jobExists,
  readJson,
  updateJobStatus,
  writeJsonAtomic,
} from './lib/job-store.js';
import {
  detectOldModel,
  isAlreadyRenamedByControlledName,
  isAlreadyRenamedByPrefix,
} from './lib/model-detection.js';
import { allocateName, loadAllocation, saveAllocation } from './lib/name-allocation.js';
import { V3_CONTROLLED_NAMES, getV3Dictionary } from './lib/dictionaries.js';
import { replaceModel } from './lib/replacement.js';
import { decide } from './lib/validation.js';

/**
 * Build a per-category dictionary-capacity report.
 *
 * For each category seen in the plan among ready + needs_review items, we
 * report:
 *   dictionarySize      total names in V3_DICTIONARIES[category]
 *   uniqueOldModels     distinct oldModel values that came in for this cat
 *   allocatedNames      distinct new names actually allocated for this cat
 *   fallbackCount       new names that exhausted the dictionary ("Аурора 2")
 *   fallbackExamples    up to 5 such fallback names
 *
 * Items with status skipped_already_renamed / skipped_no_model / blocked are
 * excluded — they would not be applied anyway, so they should not influence
 * the "do we need a bigger dictionary" decision.
 */
function computeDictionaryCapacity(plan, alloc) {
  const ELIGIBLE = new Set(['ready', 'needs_review']);
  const perCategory = new Map();
  for (const item of plan) {
    if (!ELIGIBLE.has(item.status)) continue;
    if (!item.oldModel) continue;
    const cat = item.detectedCategory || 'generic';
    if (!perCategory.has(cat)) {
      perCategory.set(cat, {
        category: cat,
        dictionarySize: getV3Dictionary(cat).length,
        uniqueOldModels: new Set(),
        allocatedNames: new Set(),
        fallbackCount: 0,
        fallbackExamples: [],
      });
    }
    const stats = perCategory.get(cat);
    stats.uniqueOldModels.add(item.oldModel);
    if (item.newModel) stats.allocatedNames.add(item.newModel);
  }

  // Cross-check fallbacks against the persisted alloc state so we still
  // surface fallbacks that might not appear among ready/needs_review items
  // (rare but possible — e.g. a fallback got allocated then the item was
  // demoted to blocked).
  const fallbacksByCategory = alloc.fallbacksByCategory || {};
  for (const [cat, names] of Object.entries(fallbacksByCategory)) {
    if (!perCategory.has(cat)) {
      perCategory.set(cat, {
        category: cat,
        dictionarySize: getV3Dictionary(cat).length,
        uniqueOldModels: new Set(),
        allocatedNames: new Set(),
        fallbackCount: 0,
        fallbackExamples: [],
      });
    }
    const stats = perCategory.get(cat);
    for (const n of names) {
      stats.allocatedNames.add(n);
      stats.fallbackCount++;
      if (stats.fallbackExamples.length < 5) stats.fallbackExamples.push(n);
    }
  }

  return Array.from(perCategory.values()).map((s) => ({
    category: s.category,
    dictionarySize: s.dictionarySize,
    uniqueOldModels: s.uniqueOldModels.size,
    allocatedNames: s.allocatedNames.size,
    fallbackCount: s.fallbackCount,
    fallbackExamples: s.fallbackExamples,
  }));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { job: null, category: null };
  for (const a of args) {
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else if (a.startsWith('--category=')) opts.category = a.slice('--category='.length);
  }
  return opts;
}

function planItem(product, categoryOverride, alloc) {
  const detectedCategory = categoryOverride || detectCategoryFromProduct(product) || 'generic';

  // Protection A — title-prefix.
  const prefixMatch = isAlreadyRenamedByPrefix(product.title);
  if (prefixMatch.matched) {
    return {
      productId: product.id,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      detectedCategory,
      oldTitle: product.title,
      newTitle: product.title,
      oldModel: null,
      newModel: prefixMatch.name,
      alreadyRenamed: true,
      alreadyRenamedReasons: [`prefix_match:${prefixMatch.prefix}`, `controlled_name:${prefixMatch.name}`],
      changedFields: [],
      replacementCounts: {
        title: 0, seoTitle: 0, seoDescription: 0, descriptionHtml: 0,
      },
      oldSeoTitle: product.seoTitle,
      newSeoTitle: product.seoTitle,
      oldSeoDescription: product.seoDescription,
      newSeoDescription: product.seoDescription,
      descriptionReplacement: null,
    };
  }

  // Protection B — controlled-name body match (category-scoped, with
  // common-name exclusions enforced inside the helper).
  const bodyMatch = isAlreadyRenamedByControlledName(product.title, detectedCategory);
  if (bodyMatch.matched) {
    return {
      productId: product.id,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      detectedCategory,
      oldTitle: product.title,
      newTitle: product.title,
      oldModel: null,
      newModel: bodyMatch.name,
      alreadyRenamed: true,
      alreadyRenamedReasons: [`controlled_name_in_body:${bodyMatch.name}`],
      changedFields: [],
      replacementCounts: {
        title: 0, seoTitle: 0, seoDescription: 0, descriptionHtml: 0,
      },
      oldSeoTitle: product.seoTitle,
      newSeoTitle: product.seoTitle,
      oldSeoDescription: product.seoDescription,
      newSeoDescription: product.seoDescription,
      descriptionReplacement: null,
    };
  }

  const detection = detectOldModel(product.title);

  if (!detection.detected) {
    return {
      productId: product.id,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      detectedCategory,
      oldTitle: product.title,
      newTitle: null,
      oldModel: null,
      newModel: null,
      alreadyRenamed: false,
      ambiguousModel: !!detection.ambiguous,
      ambiguousCandidates: detection.candidates || [],
      detectionSource: null,
      changedFields: [],
      replacementCounts: {
        title: 0, seoTitle: 0, seoDescription: 0, descriptionHtml: 0,
      },
      oldSeoTitle: product.seoTitle,
      newSeoTitle: product.seoTitle,
      oldSeoDescription: product.seoDescription,
      newSeoDescription: product.seoDescription,
      descriptionReplacement: null,
    };
  }

  // Defensive: detection should never return a controlled name, but guard
  // anyway so a future detection-rule change cannot cause us to re-rename
  // an already-renamed product.
  if (V3_CONTROLLED_NAMES.has(detection.detected)) {
    return {
      productId: product.id,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      detectedCategory,
      oldTitle: product.title,
      newTitle: product.title,
      oldModel: null,
      newModel: detection.detected,
      alreadyRenamed: true,
      alreadyRenamedReasons: [`detection_returned_controlled_name:${detection.detected}`],
      changedFields: [],
      replacementCounts: {
        title: 0, seoTitle: 0, seoDescription: 0, descriptionHtml: 0,
      },
      oldSeoTitle: product.seoTitle,
      newSeoTitle: product.seoTitle,
      oldSeoDescription: product.seoDescription,
      newSeoDescription: product.seoDescription,
      descriptionReplacement: null,
    };
  }

  const oldModel = detection.detected;
  const allocation = allocateName(alloc, detectedCategory, oldModel);
  const newModel = allocation.name;
  const fallbackAllocated = allocation.fallbackAllocated;

  const titleR = replaceModel(product.title, oldModel, newModel);
  const seoTitleR = replaceModel(product.seoTitle, oldModel, newModel);
  const seoDescR = replaceModel(product.seoDescription, oldModel, newModel);
  const descR = replaceModel(product.descriptionHtml, oldModel, newModel);

  const changedFields = [];
  if (titleR.count > 0 && titleR.text !== product.title) changedFields.push('title');
  if (seoTitleR.count > 0 && seoTitleR.text !== product.seoTitle) changedFields.push('seo.title');
  if (seoDescR.count > 0 && seoDescR.text !== product.seoDescription) changedFields.push('seo.description');
  if (descR.count > 0 && descR.text !== product.descriptionHtml) changedFields.push('descriptionHtml');

  // Description replacement is recorded as metadata (from/to + count) so
  // apply-job can re-apply it against the latest Shopify state, not against
  // the exported snapshot. Same approach as V2.
  const descriptionReplacement = descR.count > 0
    ? { from: oldModel, to: newModel, exportCount: descR.count }
    : null;

  return {
    productId: product.id,
    handle: product.handle,
    vendor: product.vendor,
    productType: product.productType,
    detectedCategory,
    oldTitle: product.title,
    newTitle: titleR.text,
    oldModel,
    newModel,
    alreadyRenamed: false,
    detectionSource: detection.source,
    knownModel: !!detection.knownModel,
    fallbackAllocated,
    changedFields,
    replacementCounts: {
      title: titleR.count,
      seoTitle: seoTitleR.count,
      seoDescription: seoDescR.count,
      descriptionHtml: descR.count,
    },
    oldSeoTitle: product.seoTitle,
    newSeoTitle: seoTitleR.count > 0 ? seoTitleR.text : product.seoTitle,
    oldSeoDescription: product.seoDescription,
    newSeoDescription: seoDescR.count > 0 ? seoDescR.text : product.seoDescription,
    oldDescriptionHtml: product.descriptionHtml || null,
    descriptionReplacement,
  };
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
  const exportData = await readJson(opts.job, 'export');
  if (!exportData?.products) {
    console.error('ERROR: export.json missing or empty. Run rename:v3:export first.');
    process.exit(1);
  }

  const categoryOverride = opts.category || job.filters?.category || null;
  const alloc = await loadAllocation(opts.job);

  const plan = [];
  const counts = {
    ready: 0,
    needs_review: 0,
    blocked: 0,
    skipped_already_renamed: 0,
    skipped_no_model: 0,
  };

  for (const product of exportData.products) {
    const item = planItem(product, categoryOverride, alloc);
    const decision = decide(item);
    Object.assign(item, decision);
    plan.push(item);
    counts[decision.status] = (counts[decision.status] || 0) + 1;
  }

  await saveAllocation(opts.job, alloc);

  // Per-category dictionary-capacity report. Counts are computed from the
  // plan items (ready + needs_review) so the numbers reflect what apply
  // could actually touch. Status-job consumes these directly.
  const dictionaryCapacity = computeDictionaryCapacity(plan, alloc);

  const exportHash = await hashJobFile(opts.job, 'export');
  await writeJsonAtomic(opts.job, 'plan', {
    jobId: opts.job,
    pipelineVersion: 'v3',
    timestamp: new Date().toISOString(),
    exportHash,
    exportFilters: exportData.filters || null,
    exportQuery: exportData.query || null,
    exportTotal: exportData.totalExported ?? null,
    jobFilters: job.filters || null,
    categoryOverride: categoryOverride || null,
    totalItems: plan.length,
    counts,
    dictionaryCapacity,
    plan,
  });

  const planHash = await hashJobFile(opts.job, 'plan');
  await updateJobStatus(opts.job, {
    status: 'planned',
    phase: { ...(job.phase || {}), planned: true },
    planSummary: {
      ...counts,
      totalItems: plan.length,
      plannedAt: new Date().toISOString(),
      exportHash,
      planHash,
    },
  });

  console.log();
  console.log('========== V3 Plan complete ==========');
  console.log(`Total items:                ${plan.length}`);
  console.log(`Ready:                      ${counts.ready}`);
  console.log(`Needs review:               ${counts.needs_review}`);
  console.log(`Blocked:                    ${counts.blocked}`);
  console.log(`Skipped (already renamed):  ${counts.skipped_already_renamed}`);
  console.log(`Skipped (no model):         ${counts.skipped_no_model}`);
  console.log('======================================');
  if (dictionaryCapacity.length > 0) {
    console.log();
    console.log('--- Dictionary capacity ---');
    for (const s of dictionaryCapacity) {
      console.log(`  ${s.category}: dict=${s.dictionarySize}, uniqueOldModels=${s.uniqueOldModels}, allocated=${s.allocatedNames}, fallbacks=${s.fallbackCount}`);
      if (s.fallbackCount > 0) {
        console.log(`    fallback examples: ${s.fallbackExamples.join(', ')}`);
        console.log(`    WARNING: dictionary exhausted for category "${s.category}". Consider expanding the category dictionary before apply.`);
      }
    }
  }
  console.log();
  console.log(`Next: npm run rename:v3:validate -- --job=${opts.job}`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
