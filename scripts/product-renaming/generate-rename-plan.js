#!/usr/bin/env node
/**
 * Generate a rename plan from exported product data.
 *
 * READ-ONLY. No mutations.
 *
 * Usage:
 *   node scripts/product-renaming/generate-rename-plan.js --input=logs/product-renaming/export-products-*.json
 *   node scripts/product-renaming/generate-rename-plan.js --input=... --category=garden --limit=100
 *   node scripts/product-renaming/generate-rename-plan.js --input=... --category=sofas --limit=50
 *   node scripts/product-renaming/generate-rename-plan.js --input=... --out=my-plan.json
 *
 * Output:
 *   logs/product-renaming/rename-plan-YYYY-MM-DDTHH-mm-ss.json
 *   logs/product-renaming/rename-preview-YYYY-MM-DDTHH-mm-ss.csv
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeText,
  detectCategoryFromProduct,
  detectProductTypeFromTitle,
  detectModelNameFromTitle,
  buildRenamedTitle,
  getDictionaryForCategory,
  pickNewName,
  extractPieces,
  repairTruncatedFragments,
  cleanBrokenFragments,
  TRUNCATED_PATTERNS,
  KNOWN_MODEL_NAMES,
} from './name-dictionaries.js';

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  console.log(`[${nowIso()}] ${line}`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    input: null,
    category: null,
    limit: null,
    out: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--input=')) opts.input = a.slice('--input='.length);
    else if (a.startsWith('--category=')) opts.category = a.slice('--category='.length);
    else if (a.startsWith('--limit=')) {
      const v = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a === '--limit') {
      const v = Number.parseInt(args[++i], 10);
      if (Number.isFinite(v) && v > 0) opts.limit = v;
    } else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
  }

  return opts;
}

function escapeModelNameForRegex(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeSmCodes(text) {
  if (!text) return text;
  return text.replace(/\bSM\d{4,}\b/gi, '').replace(/\s{2,}/g, ' ').trim();
}

function replaceAllKnownModels(text, newModel) {
  if (!text) return text;
  let result = text;
  for (const modelName of KNOWN_MODEL_NAMES) {
    const escaped = escapeModelNameForRegex(modelName);
    result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), newModel);
  }
  return result;
}

function generateDescriptionReplacement(descriptionHtml, oldModel, newModel) {
  if (!descriptionHtml || !oldModel) return null;
  const escaped = escapeModelNameForRegex(oldModel);
  const regex = new RegExp(escaped, 'gi');
  if (regex.test(descriptionHtml)) {
    return { from: oldModel, to: newModel };
  }
  return null;
}

function generateSeoTitle(oldSeoTitle, oldModel, newModel, newTitle) {
  let base = oldSeoTitle || newTitle;
  if (!base) return null;

  base = removeSmCodes(base);
  base = replaceAllKnownModels(base, newModel);
  if (oldModel) {
    base = base.replace(new RegExp(escapeModelNameForRegex(oldModel), 'gi'), newModel);
  }

  base = normalizeText(base);
  if (!base.endsWith('| Mebelcenter')) {
    base += ' | Mebelcenter';
  }
  return base;
}

function generateSeoDescription(oldSeoDescription, oldModel, newModel) {
  if (!oldSeoDescription) return null;
  let desc = removeSmCodes(oldSeoDescription);
  desc = replaceAllKnownModels(desc, newModel);
  if (oldModel) {
    desc = desc.replace(new RegExp(escapeModelNameForRegex(oldModel), 'gi'), newModel);
  }
  return normalizeText(desc);
}

function hasTruncatedFragment(text) {
  if (!text) return false;
  for (const pattern of TRUNCATED_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function assessRisk(product, detectedModel, newName, newTitle, newSeoTitle, newSeoDescription, reasons, hadTruncatedFragment, wasTruncatedRemoved) {
  const oldTitle = normalizeText(product.title || '');

  if (!detectedModel) {
    reasons.push('no model name detected — title rebuilt from scratch');
    if (!newTitle) return 'skip';
    return 'medium';
  }

  if (!newTitle) {
    reasons.push('could not generate new title');
    return 'high';
  }

  if (newTitle.length < 30) {
    reasons.push('new title too short');
    return 'high';
  }

  if (newTitle.length > 120) {
    reasons.push('new title too long');
    return 'medium';
  }

  if (newTitle.toLowerCase().includes(detectedModel.toLowerCase())) {
    reasons.push('old model name still present in new title');
    return 'high';
  }

  if (newSeoTitle && newSeoTitle.toLowerCase().includes(detectedModel.toLowerCase())) {
    reasons.push('old model name still present in new SEO title');
    return 'medium';
  }
  if (newSeoDescription && newSeoDescription.toLowerCase().includes(detectedModel.toLowerCase())) {
    reasons.push('old model name still present in new SEO description');
    return 'medium';
  }

  if (hasTruncatedFragment(newTitle)) {
    reasons.push('incomplete/truncated title fragment remains');
    return 'high';
  }

  if (hadTruncatedFragment && wasTruncatedRemoved) {
    reasons.push('truncated fragment removed (could not repair)');
    return 'medium';
  }

  if (newTitle.length < oldTitle.length * 0.5) {
    reasons.push('new title significantly shorter than original');
    return 'medium';
  }

  const hasPieces = /\d+\s*части/i.test(oldTitle);
  const newHasPieces = /\d+\s*части/i.test(newTitle);
  if (hasPieces && !newHasPieces) {
    reasons.push('piece count lost from title');
    return 'medium';
  }

  return 'low';
}

function disambiguateTitle(newTitle, product, allTitles) {
  if (!allTitles.has(newTitle)) return newTitle;

  const pieces = extractPieces(product.title);
  const colorMatch = product.title.match(/\b(бежов|сив|черен|бял|кафяв|екрю|кремав|тъмносив|светлосив|антрацит|капучино)\b/i);
  const materialMatch = product.title.match(/\b(алуминий|дърво|акация|дъб|метал|ратан|полипропилен|бук|стъкло)\b/i);

  const suffixes = [];
  if (pieces) suffixes.push(pieces);
  if (colorMatch) suffixes.push(colorMatch[1]);
  if (materialMatch) suffixes.push(materialMatch[1]);

  if (suffixes.length > 0) {
    const disambiguated = `${newTitle} (${suffixes.join(', ')})`;
    if (!allTitles.has(disambiguated)) return disambiguated;
  }

  let counter = 2;
  while (allTitles.has(`${newTitle} (${counter})`)) counter++;
  return `${newTitle} (${counter})`;
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.input) {
    console.error('ERROR: --input is required. Path to exported products JSON.');
    process.exit(1);
  }

  log(`Input: ${opts.input}`);
  if (opts.category) log(`Category filter: ${opts.category}`);
  if (opts.limit) log(`Limit: ${opts.limit}`);

  const rawData = JSON.parse(await fs.readFile(opts.input, 'utf-8'));
  const products = rawData.products || rawData;

  if (!Array.isArray(products)) {
    console.error('ERROR: Input JSON must contain a "products" array or be an array.');
    process.exit(1);
  }

  log(`Loaded ${products.length} products from export.`);

  const plan = [];
  let nameIndex = 0;
  const usedNames = new Map();
  const usedTitles = new Set();

  for (const product of products) {
    const detectedCategory = opts.category || detectCategoryFromProduct(product);
    const detectedModel = detectModelNameFromTitle(product.title);
    const productType = detectProductTypeFromTitle(product.title);
    const dict = getDictionaryForCategory(detectedCategory);

    const nameKey = `${detectedCategory}-${detectedModel || 'unknown'}`;
    let newName;
    if (usedNames.has(nameKey)) {
      newName = usedNames.get(nameKey);
    } else {
      newName = pickNewName(detectedCategory, nameIndex);
      usedNames.set(nameKey, newName);
      nameIndex++;
    }

    let rawNewTitle = buildRenamedTitle(product, detectedCategory, newName);
    let hadTruncatedFragment = false;
    let wasTruncatedRemoved = false;

    if (rawNewTitle) {
      const repairResult = repairTruncatedFragments(rawNewTitle, product.descriptionHtml);
      rawNewTitle = repairResult.text;

      if (repairResult.wasModified) {
        hadTruncatedFragment = true;
        const stillHasTruncated = hasTruncatedFragment(rawNewTitle);
        if (!stillHasTruncated) {
          wasTruncatedRemoved = true;
        }
      }

      if (hasTruncatedFragment(rawNewTitle)) {
        rawNewTitle = cleanBrokenFragments(rawNewTitle);
        hadTruncatedFragment = true;
        if (!wasTruncatedRemoved) {
          wasTruncatedRemoved = true;
        }
      }

      rawNewTitle = normalizeText(rawNewTitle);
    }

    const reasons = [];

    const newTitle = rawNewTitle ? disambiguateTitle(rawNewTitle, product, usedTitles) : (product.title || '');
    if (rawNewTitle && newTitle !== rawNewTitle) {
      reasons.push('title disambiguated to avoid duplicate');
    }
    usedTitles.add(newTitle);

    const descReplacement = generateDescriptionReplacement(
      product.descriptionHtml,
      detectedModel,
      newName,
    );

    const newSeoTitle = generateSeoTitle(
      product.seoTitle,
      detectedModel,
      newName,
      newTitle,
    );

    const newSeoDescription = generateSeoDescription(
      product.seoDescription,
      detectedModel,
      newName,
    );

    const risk = assessRisk(product, detectedModel, newName, rawNewTitle, newSeoTitle, newSeoDescription, reasons, hadTruncatedFragment, wasTruncatedRemoved);

    const titleChanged = normalizeText(newTitle) !== normalizeText(product.title);

    plan.push({
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
      descriptionReplacement: descReplacement,
      oldSeoTitle: product.seoTitle,
      newSeoTitle,
      oldSeoDescription: product.seoDescription,
      newSeoDescription,
      risk,
      reasons,
    });

    if (opts.limit && plan.length >= opts.limit) break;
  }

  const outDir = path.join('logs', 'product-renaming');
  await fs.mkdir(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const planPath = opts.out
    ? path.resolve(opts.out)
    : path.join(outDir, `rename-plan-${timestamp}.json`);

  await fs.writeFile(planPath, JSON.stringify({
    timestamp: nowIso(),
    input: opts.input,
    filters: {
      category: opts.category,
      limit: opts.limit,
    },
    totalProducts: plan.length,
    plan,
  }, null, 2));

  log(`Rename plan: ${planPath}`);

  const csvPath = path.join(outDir, `rename-preview-${timestamp}.csv`);
  const csvHeader = 'handle,vendor,productType,detectedCategory,detectedProductType,risk,detectedOldModelName,newCollectionName,oldTitle,newTitle,titleChanged,reasons';
  const csvRows = plan.map((item) => {
    const fields = [
      item.handle,
      item.vendor || '',
      item.productType || '',
      item.detectedCategory,
      item.detectedProductType || '',
      item.risk,
      item.detectedOldModelName || '',
      item.newCollectionName,
      `"${(item.oldTitle || '').replace(/"/g, '""')}"`,
      `"${(item.newTitle || '').replace(/"/g, '""')}"`,
      item.titleChanged,
      `"${item.reasons.join('; ')}"`,
    ];
    return fields.join(',');
  });
  await fs.writeFile(csvPath, `${csvHeader}\n${csvRows.join('\n')}\n`);

  log(`CSV preview: ${csvPath}`);

  const riskCounts = { low: 0, medium: 0, high: 0, skip: 0 };
  for (const item of plan) riskCounts[item.risk]++;

  console.log();
  console.log('========== Summary ==========');
  console.log(`Total products processed: ${plan.length}`);
  console.log(`Risk distribution:`);
  console.log(`  Low:    ${riskCounts.low}`);
  console.log(`  Medium: ${riskCounts.medium}`);
  console.log(`  High:   ${riskCounts.high}`);
  console.log(`  Skip:   ${riskCounts.skip}`);
  console.log(`Plan JSON: ${planPath}`);
  console.log(`CSV preview: ${csvPath}`);
  console.log('=============================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
