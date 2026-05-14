#!/usr/bin/env node
/**
 * Generate plan.json for a V2 job.
 *
 * READ-ONLY. No mutations.
 *
 * Usage:
 *   node scripts/product-renaming-v2/plan-job.js --job=<jobId>
 *
 * Uses the V1 name-dictionaries.js logic (normalization, model detection,
 * truncated-fragment repair, title building) but adds:
 *   - already-renamed detection BEFORE model detection
 *   - persistent name allocation per (category, old-model) in allocation-state.json
 *   - stable duplicate-title disambiguation
 *   - per-item status: skipped | ready | needs_review | blocked
 */

import {
  cleanBrokenFragments,
  detectCategoryFromProduct,
  detectModelNameFromTitle,
  detectProductTypeFromTitle,
  buildRenamedTitle,
  normalizeText,
  repairTruncatedFragments,
  TRUNCATED_PATTERNS,
  KNOWN_MODEL_NAMES,
} from '../product-renaming/name-dictionaries.js';
import {
  hashJobFile,
  jobExists,
  readJson,
  updateJobStatus,
  writeJsonAtomic,
  jobDir,
} from './lib/job-store.js';
import {
  allocateName,
  disambiguateTitle,
  loadAllocation,
  saveAllocation,
} from './lib/name-allocation.js';
import { decide, isAlreadyRenamed } from './lib/quality-gates.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { job: null, category: null };
  for (const a of args) {
    if (a.startsWith('--job=')) opts.job = a.slice('--job='.length);
    else if (a.startsWith('--category=')) opts.category = a.slice('--category='.length);
  }
  return opts;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeSmCodes(text) {
  if (!text) return text;
  return text.replace(/\bSM\d{4,}\b/gi, '').replace(/\s{2,}/g, ' ').trim();
}

function replaceAllKnownModels(text, newModel) {
  if (!text) return text;
  let result = text;
  for (const modelName of KNOWN_MODEL_NAMES) {
    result = result.replace(new RegExp(`\\b${escapeRegex(modelName)}\\b`, 'gi'), newModel);
  }
  return result;
}

function deduplicateRepeatedWords(text) {
  if (!text) return text;
  let result = text;
  result = result.replace(/(\S+)\s+\1(?![\wА-Яа-яЁё])/gi, '$1');
  result = result.replace(/(\S+)\s+[–-]\s*\1(?![\wА-Яа-яЁё])/gi, '$1');
  result = result.replace(/(\S+)\s*,\s*\1(?![\wА-Яа-яЁё])/gi, '$1');
  return result.replace(/\s{2,}/g, ' ').trim();
}

function generateDescriptionReplacement(descriptionHtml, oldModel, newModel) {
  if (!descriptionHtml || !oldModel) return null;
  const re = new RegExp(escapeRegex(oldModel), 'gi');
  if (re.test(descriptionHtml)) return { from: oldModel, to: newModel };
  return null;
}

function generateSeoTitle(oldSeoTitle, oldModel, newModel, newTitle) {
  let base = oldSeoTitle || newTitle;
  if (!base) return null;
  base = removeSmCodes(base);
  base = replaceAllKnownModels(base, newModel);
  if (oldModel) {
    base = base.replace(new RegExp(escapeRegex(oldModel), 'gi'), newModel);
  }
  base = normalizeText(base);
  base = deduplicateRepeatedWords(base);
  if (!base.endsWith('| Mebelcenter')) base += ' | Mebelcenter';
  return base;
}

function generateSeoDescription(oldSeoDescription, oldModel, newModel) {
  if (!oldSeoDescription) return null;
  let desc = removeSmCodes(oldSeoDescription);
  desc = replaceAllKnownModels(desc, newModel);
  if (oldModel) {
    desc = desc.replace(new RegExp(escapeRegex(oldModel), 'gi'), newModel);
  }
  desc = normalizeText(desc);
  desc = deduplicateRepeatedWords(desc);
  return desc;
}

function hasTruncatedFragment(text) {
  if (!text) return false;
  for (const pattern of TRUNCATED_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function assessRisk(product, detectedModel, newTitle, newSeoTitle, newSeoDescription, reasons, hadTruncated, removedTruncated) {
  const oldTitle = normalizeText(product.title || '');

  if (!detectedModel) {
    reasons.push('no_model_detected');
    if (!newTitle) return 'skip';
    return 'medium';
  }
  if (!newTitle) {
    reasons.push('no_new_title');
    return 'high';
  }
  if (newTitle.length < 30) { reasons.push('new_title_too_short'); return 'high'; }
  if (newTitle.length > 120) { reasons.push('new_title_too_long'); return 'medium'; }
  if (newTitle.toLowerCase().includes(detectedModel.toLowerCase())) {
    reasons.push('old_model_in_new_title');
    return 'high';
  }
  if (newSeoTitle && newSeoTitle.toLowerCase().includes(detectedModel.toLowerCase())) {
    reasons.push('old_model_in_seo_title');
    return 'medium';
  }
  if (newSeoDescription && newSeoDescription.toLowerCase().includes(detectedModel.toLowerCase())) {
    reasons.push('old_model_in_seo_description');
    return 'medium';
  }
  if (hasTruncatedFragment(newTitle)) {
    reasons.push('unresolved_truncated_fragment');
    return 'high';
  }
  if (hadTruncated && removedTruncated) {
    reasons.push('truncated_fragment_removed');
    return 'medium';
  }
  if (newTitle.length < oldTitle.length * 0.5) {
    reasons.push('too_many_words_removed');
    return 'medium';
  }
  const hasPieces = /\d+\s*части/i.test(oldTitle);
  const newHasPieces = /\d+\s*части/i.test(newTitle);
  if (hasPieces && !newHasPieces) {
    reasons.push('piece_count_lost');
    return 'medium';
  }
  return 'low';
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
    console.error('ERROR: export.json missing or empty. Run rename:v2:export first.');
    process.exit(1);
  }

  const categoryOverride = opts.category || job.filters?.category || null;
  const alloc = await loadAllocation(opts.job);
  const titleUseCounts = new Map();

  const plan = [];
  const counts = { skipped: 0, ready: 0, needs_review: 0, blocked: 0 };

  for (const product of exportData.products) {
    const detectedCategory = categoryOverride || detectCategoryFromProduct(product) || 'generic';

    // 1) Already-renamed detection FIRST.
    const renamed = isAlreadyRenamed(product.title);
    if (renamed) {
      const item = {
        productId: product.id,
        handle: product.handle,
        vendor: product.vendor,
        productType: product.productType,
        oldTitle: product.title,
        newTitle: product.title,
        detectedCategory: renamed.category,
        detectedOldModelName: null,
        newCollectionName: renamed.name,
        titleChanged: false,
        alreadyRenamed: true,
        risk: 'skip',
        reasons: ['already_renamed'],
        status: 'skipped',
        skipReason: 'already_renamed',
        mutationAllowed: false,
      };
      plan.push(item);
      counts.skipped++;
      continue;
    }

    const detectedModel = detectModelNameFromTitle(product.title);
    const productType = detectProductTypeFromTitle(product.title);

    const newName = allocateName(alloc, detectedCategory, detectedModel);

    let rawNewTitle = buildRenamedTitle(product, detectedCategory, newName);
    let hadTruncated = false;
    let removedTruncated = false;
    if (rawNewTitle) {
      const repair = repairTruncatedFragments(rawNewTitle, product.descriptionHtml);
      rawNewTitle = repair.text;
      if (repair.wasModified) {
        hadTruncated = true;
        if (!hasTruncatedFragment(rawNewTitle)) removedTruncated = true;
      }
      if (hasTruncatedFragment(rawNewTitle)) {
        rawNewTitle = cleanBrokenFragments(rawNewTitle);
        hadTruncated = true;
        removedTruncated = true;
      }
      rawNewTitle = normalizeText(rawNewTitle);
    }

    const reasons = [];
    const newTitle = rawNewTitle
      ? disambiguateTitle(rawNewTitle, product.title, titleUseCounts)
      : (product.title || '');
    if (rawNewTitle && newTitle !== rawNewTitle) reasons.push('title_disambiguated');

    const descReplacement = generateDescriptionReplacement(product.descriptionHtml, detectedModel, newName);
    const newSeoTitle = generateSeoTitle(product.seoTitle, detectedModel, newName, newTitle);
    const newSeoDescription = generateSeoDescription(product.seoDescription, detectedModel, newName);

    const risk = assessRisk(product, detectedModel, rawNewTitle, newSeoTitle, newSeoDescription, reasons, hadTruncated, removedTruncated);
    const titleChanged = normalizeText(newTitle) !== normalizeText(product.title);

    const item = {
      productId: product.id,
      handle: product.handle,
      vendor: product.vendor,
      productType: product.productType,
      oldTitle: product.title,
      newTitle,
      detectedCategory,
      detectedProductType: productType,
      detectedOldModelName: detectedModel,
      newCollectionName: newName,
      titleChanged: !!titleChanged,
      alreadyRenamed: false,
      descriptionReplacement: descReplacement,
      oldDescriptionHtml: product.descriptionHtml || null,
      oldSeoTitle: product.seoTitle,
      newSeoTitle,
      oldSeoDescription: product.seoDescription,
      newSeoDescription,
      risk,
      reasons,
    };

    const decision = decide(item);
    Object.assign(item, decision);
    counts[decision.status]++;
    plan.push(item);
  }

  await saveAllocation(opts.job, alloc);

  const exportHash = await hashJobFile(opts.job, 'export');
  await writeJsonAtomic(opts.job, 'plan', {
    jobId: opts.job,
    timestamp: new Date().toISOString(),
    exportHash,
    exportFilters: exportData.filters || null,
    exportQuery: exportData.query || null,
    exportTotal: exportData.totalExported ?? null,
    jobFilters: job.filters || null,
    categoryOverride: categoryOverride || null,
    totalItems: plan.length,
    counts,
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
  console.log('========== Plan complete ==========');
  console.log(`Total items:  ${plan.length}`);
  console.log(`Ready:        ${counts.ready}`);
  console.log(`Needs review: ${counts.needs_review}`);
  console.log(`Blocked:      ${counts.blocked}`);
  console.log(`Skipped:      ${counts.skipped}`);
  console.log('===================================');
  console.log();
  console.log(`Next: npm run rename:v2:validate -- --job=${opts.job}`);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});

