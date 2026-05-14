#!/usr/bin/env node
/**
 * Validate a generated rename plan.
 *
 * READ-ONLY. No mutations.
 *
 * Usage:
 *   node scripts/product-renaming/validate-rename-plan.js --plan=logs/product-renaming/rename-plan-*.json
 *
 * Output:
 *   logs/product-renaming/validation-YYYY-MM-DDTHH-mm-ss.json
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KNOWN_MODEL_NAMES } from './name-dictionaries.js';

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  console.log(`[${nowIso()}] ${line}`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { plan: null };

  for (const a of args) {
    if (a.startsWith('--plan=')) opts.plan = a.slice('--plan='.length);
  }

  return opts;
}

const BANNED_PATTERNS = [
  /^\d{4,}$/,
  /^[A-Z]{5,}$/,
  /^[а-яА-ЯёЁ\s]{0,2}$/,
  /SKU|ProductCode|item[_-]?code|model[_-]?no/i,
];

const BANNED_NAMES = [
  'test', 'temp', 'tmp', 'untitled', 'unnamed', 'placeholder',
  'лол', 'тест', 'временен', 'без име',
];

const PRODUCT_TYPE_WORDS = [
  'диван', 'сет', 'комплект', 'маса', 'стол', 'фотьойл',
  'спалня', 'легло', 'гардероб', 'шкаф', 'скрин', 'тоалетка',
  'трапезария', 'бар', 'лаундж', 'шезлонг', 'люлка', 'беседка',
  'пергола', 'чадър', 'хамак', 'полутрап', 'daybed',
  'табла', 'нощно', 'основа', 'матрак', 'ракла',
  'поставка', 'тролей', 'библиотека', 'секция', 'витрина',
  'офис', 'геймърски', 'резервна', 'част', 'материя',
  'перфорирана', 'щори', 'перде', 'килим', 'постелка',
  'павилион', 'трапезен',
];

const TRUNCATED_INDICATORS = [
  /\s[пП]\s*$/i,
  /\s[оО]\s*$/i,
  /\bWICKE\b/i,
  /\bSintere\b/i,
  /\bOLEF\b/i,
  /\bкамъ\b/i,
  /\bSINT\b/i,
  /\bWICK\b/i,
  /\bOlefi\b/i,
  /Olefin\s+п\b/i,
  /-си\b\s*$/i,
  /-P\.E\.\s*$/i,
  /\sOL\b(?!\w)/i,
  /\sO\b\s*$/i,
  /тек-син\b/i,
  /-синтерован\s*$/i,
  /синтерован\s*$/i,
];

const UGLY_PATTERNS = [
  { pattern: /плат\s+Olefin\s+плат/i, label: '"плат Olefin плат" duplicate' },
  { pattern: /плат\s+и\s+Olefin\s+плат/i, label: '"плат и Olefin плат" duplicate' },
  { pattern: /и\s+Olefin\s+плат\s+и\s/i, label: '"и Olefin плат и" ugly connector' },
  { pattern: /алуминий-беж\b/i, label: '"алуминий-беж" unnormalized separator' },
  { pattern: /алуминий-крем\b/i, label: '"алуминий-крем" unnormalized separator' },
  { pattern: /тек-син\b/i, label: '"тек-син" truncated fragment' },
  { pattern: /\bкамъ\b/i, label: '"камъ" truncated fragment' },
  { pattern: /\bWICKE\b/i, label: '"WICKE" truncated fragment' },
  { pattern: /\bOLEF\b/i, label: '"OLEF" truncated fragment' },
  { pattern: /\bOlefi\b/i, label: '"Olefi" truncated fragment' },
  { pattern: /\bSintere\b/i, label: '"Sintere" truncated fragment' },
];

function validatePlan(plan) {
  const issues = [];
  const newTitles = new Map();
  const duplicates = [];
  let lowCount = 0;
  let mediumCount = 0;
  let highCount = 0;
  let skipCount = 0;

  for (const item of plan) {
    const itemIssues = [];

    if (!item.handle || item.handle.trim().length === 0) {
      itemIssues.push('handle is empty');
    }

    if (!item.newTitle || item.newTitle.trim().length === 0) {
      itemIssues.push('new title is empty');
    }

    if (item.newTitle) {
      const title = item.newTitle;

      if (title.includes(',,')) {
        itemIssues.push('contains double comma ",,"');
      }

      if (/[,–-]\s*$/.test(title.trim())) {
        itemIssues.push('ends with punctuation');
      }

      if (/\s+(и|с|за)\s*$/.test(title.trim())) {
        itemIssues.push('ends with connector word');
      }

      const titleLen = title.length;
      if (titleLen < 30) {
        itemIssues.push(`new title too short (${titleLen} chars)`);
      }
      if (titleLen > 120) {
        itemIssues.push(`new title too long (${titleLen} chars)`);
      }

      const lowerTitle = title.toLowerCase();
      const hasProductTypeWord = PRODUCT_TYPE_WORDS.some((w) => lowerTitle.includes(w));
      if (!hasProductTypeWord) {
        itemIssues.push('new title missing product-type keyword');
      }

      for (const pattern of BANNED_PATTERNS) {
        if (pattern.test(title)) {
          itemIssues.push('new title matches banned pattern');
          break;
        }
      }

      for (const banned of BANNED_NAMES) {
        if (lowerTitle.includes(banned)) {
          itemIssues.push(`new title contains banned word: "${banned}"`);
          break;
        }
      }

      if (item.detectedOldModelName && item.titleChanged) {
        const escaped = item.detectedOldModelName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(escaped, 'i').test(title)) {
          itemIssues.push('old model name still present in new title');
        }
      }

      const oldWords = (item.oldTitle || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !/^\d/.test(w));
      const newWords = lowerTitle.split(/\s+/).filter((w) => w.length > 3 && !/^\d/.test(w));
      const preservedWords = oldWords.filter((w) => newWords.includes(w));
      if (oldWords.length > 5 && preservedWords.length < oldWords.length * 0.25) {
        itemIssues.push('new title removes too many words from original');
      }

      const hasPieces = /\d+\s*части/i.test(item.oldTitle || '');
      const newHasPieces = /\d+\s*части/i.test(title);
      if (hasPieces && !newHasPieces) {
        itemIssues.push('piece count lost from title');
      }

      if (hasPieces && newHasPieces) {
        const piecesMatch = title.match(/(\d+\s*части)/i);
        if (piecesMatch) {
          const afterPieces = title.slice(title.indexOf(piecesMatch[0]) + piecesMatch[0].length).trim();
          if (afterPieces && !afterPieces.startsWith(',')) {
            itemIssues.push('missing comma after piece count');
          }
        }
      }

      const dashIdx = title.indexOf('–');
      if (dashIdx >= 0) {
        const afterDash = title.slice(dashIdx + 1);
        if (afterDash.includes(' - ')) {
          itemIssues.push('contains " - " after dash section');
        }
      }

      if (title.includes('&')) {
        itemIssues.push('contains "&" (should be "и")');
      }

      for (const pattern of TRUNCATED_INDICATORS) {
        if (pattern.test(title)) {
          itemIssues.push('incomplete/truncated title fragment');
          break;
        }
      }

      for (const ugly of UGLY_PATTERNS) {
        if (ugly.pattern.test(title)) {
          itemIssues.push(`ugly pattern: ${ugly.label}`);
        }
      }

      const isOnlyPrefix = /^Градински\s+(лаундж\s+сет|трапезен\s+комплект|павилион|комплект)\s+\S+\s*$/i.test(title.trim());
      if (isOnlyPrefix) {
        itemIssues.push('title contains only prefix + name, no details');
      }

      if (newTitles.has(title)) {
        duplicates.push(title);
      }
      newTitles.set(title, item.handle);

      if (item.risk === 'low') {
        for (const pattern of TRUNCATED_INDICATORS) {
          if (pattern.test(title)) {
            itemIssues.push('risk is low but title still has truncated fragment');
            break;
          }
        }
        for (const ugly of UGLY_PATTERNS) {
          if (ugly.pattern.test(title)) {
            itemIssues.push(`risk is low but title has ugly pattern: ${ugly.label}`);
          }
        }
      }

      if (item.detectedOldModelName) {
        const modelName = item.detectedOldModelName.toLowerCase();
        if (item.newSeoTitle && item.newSeoTitle.toLowerCase().includes(modelName)) {
          itemIssues.push('old model name still present in new SEO title');
        }
        if (item.newSeoDescription && item.newSeoDescription.toLowerCase().includes(modelName)) {
          itemIssues.push('old model name still present in new SEO description');
        }
      }
    }

    if (item.risk === 'low') lowCount++;
    else if (item.risk === 'medium') mediumCount++;
    else if (item.risk === 'high') highCount++;
    else if (item.risk === 'skip') skipCount++;

    if (itemIssues.length > 0) {
      issues.push({ handle: item.handle, issues: itemIssues });
    }
  }

  return {
    totalItems: plan.length,
    riskCounts: { low: lowCount, medium: mediumCount, high: highCount, skip: skipCount },
    duplicates: [...new Set(duplicates)],
    duplicateCount: duplicates.length,
    issueCount: issues.length,
    issues,
  };
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.plan) {
    console.error('ERROR: --plan is required. Path to rename plan JSON.');
    process.exit(1);
  }

  log(`Plan: ${opts.plan}`);

  const rawData = JSON.parse(await fs.readFile(opts.plan, 'utf-8'));
  const plan = rawData.plan || rawData;

  if (!Array.isArray(plan)) {
    console.error('ERROR: Plan JSON must contain a "plan" array or be an array.');
    process.exit(1);
  }

  log(`Loaded ${plan.length} items from plan.`);

  const validation = validatePlan(plan);

  const outDir = path.join('logs', 'product-renaming');
  await fs.mkdir(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `validation-${timestamp}.json`);

  await fs.writeFile(outPath, JSON.stringify({
    timestamp: nowIso(),
    plan: opts.plan,
    validation,
  }, null, 2));

  const currentDir = path.join(outDir, 'current');
  await fs.mkdir(currentDir, { recursive: true });
  await fs.writeFile(path.join(currentDir, 'validation.json'), JSON.stringify({
    timestamp: nowIso(),
    plan: opts.plan,
    validation,
  }, null, 2));

  console.log();
  console.log('========== Validation Summary ==========');
  console.log(`Total items:       ${validation.totalItems}`);
  console.log(`Risk distribution:`);
  console.log(`  Low:             ${validation.riskCounts.low}`);
  console.log(`  Medium:          ${validation.riskCounts.medium}`);
  console.log(`  High:            ${validation.riskCounts.high}`);
  console.log(`  Skip:            ${validation.riskCounts.skip}`);
  console.log(`Duplicates:        ${validation.duplicateCount}`);
  console.log(`Items with issues: ${validation.issueCount}`);
  console.log(`Validation output: ${outPath}`);

  if (validation.duplicates.length > 0) {
    console.log();
    console.log('--- Duplicate new titles ---');
    for (const title of validation.duplicates.slice(0, 10)) {
      console.log(`  "${title}"`);
    }
  }

  if (validation.issues.length > 0) {
    console.log();
    console.log('--- Items with validation issues ---');
    for (const item of validation.issues.slice(0, 20)) {
      console.log(`  ${item.handle}: ${item.issues.join('; ')}`);
    }
  }

  const lowRisk = plan.filter((p) => p.risk === 'low');
  const medHighRisk = plan.filter((p) => p.risk === 'medium' || p.risk === 'high');
  const skipped = plan.filter((p) => p.risk === 'skip');

  if (lowRisk.length > 0) {
    console.log();
    console.log('--- First 20 low-risk changes ---');
    for (const item of lowRisk.slice(0, 20)) {
      console.log(`  ${item.handle.padEnd(24)} | ${item.oldTitle.slice(0, 45)} → ${item.newTitle.slice(0, 45)}`);
    }
  }

  if (medHighRisk.length > 0) {
    console.log();
    console.log('--- First 20 medium/high risk ---');
    for (const item of medHighRisk.slice(0, 20)) {
      console.log(`  [${item.risk}] ${item.handle.padEnd(24)} | ${item.oldTitle.slice(0, 45)} → ${item.newTitle?.slice(0, 45) || '(none)'}`);
    }
  }

  if (skipped.length > 0) {
    console.log();
    console.log(`--- Skipped: ${skipped.length} items ---`);
    for (const item of skipped.slice(0, 10)) {
      console.log(`  ${item.handle.padEnd(24)} | ${item.oldTitle.slice(0, 50)}`);
    }
  }

  console.log();
  console.log('========================================');
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
