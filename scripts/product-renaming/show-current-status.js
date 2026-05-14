#!/usr/bin/env node
/**
 * Show current product-renaming workflow status.
 *
 * Usage:
 *   node scripts/product-renaming/show-current-status.js
 *   npm run rename:status
 */

import fs from 'node:fs';
import path from 'node:path';

const CURRENT_DIR = path.join('logs', 'product-renaming', 'current');

const FILES = {
  'export.json': 'Latest Shopify product export',
  'plan.json': 'Latest rename plan',
  'preview.csv': 'Latest human preview',
  'validation.json': 'Latest validation result',
  'dry-run.json': 'Latest dry-run apply result',
  'apply.json': 'Latest real apply result',
  'rollback.json': 'Latest rollback snapshot',
};

function checkFile(name) {
  const filePath = path.join(CURRENT_DIR, name);
  const exists = fs.existsSync(filePath);
  let size = '';
  let modified = '';
  if (exists) {
    const stat = fs.statSync(filePath);
    size = `${Math.round(stat.size / 1024)}KB`;
    modified = stat.mtime.toLocaleString();
  }
  return { exists, size, modified };
}

function readJson(name) {
  const filePath = path.join(CURRENT_DIR, name);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function checkPlanMatchesExport(plan, export_) {
  if (!plan || !export_) return { matches: false, reason: 'missing data' };

  const planInput = plan.input || null;
  const expectedInput = path.join('logs', 'product-renaming', 'current', 'export.json');

  if (!planInput || planInput !== expectedInput) {
    return { matches: false, reason: 'plan not from current/export.json' };
  }

  const planSource = plan.exportSource || {};
  const planTs = planSource.exportTimestamp || null;
  const planFilters = planSource.exportFilters || null;
  const planTotal = planSource.totalExported || null;

  const exportTs = export_.timestamp || null;
  const exportFilters = export_.filters || null;
  const exportTotal = export_.totalExported || null;

  if (planTs && exportTs && planTs !== exportTs) {
    return { matches: false, reason: 'timestamp mismatch' };
  }

  if (planFilters && exportFilters) {
    if (JSON.stringify(planFilters) !== JSON.stringify(exportFilters)) {
      return { matches: false, reason: 'filters mismatch' };
    }
  }

  if (planTotal !== null && exportTotal !== null && planTotal !== exportTotal) {
    return { matches: false, reason: 'totalExported mismatch' };
  }

  return { matches: true, reason: null };
}

function main() {
  console.log();
  console.log('========== Product Renaming Status ==========');
  console.log();

  console.log('Current files (logs/product-renaming/current/):');
  console.log();

  for (const [name, desc] of Object.entries(FILES)) {
    const info = checkFile(name);
    const status = info.exists ? 'OK' : 'missing';
    const extra = info.exists ? `(${info.size}, ${info.modified})` : '';
    console.log(`  ${status.padEnd(7)} ${name.padEnd(20)} ${desc} ${extra}`);
  }

  console.log();

  const export_ = readJson('export.json');
  if (export_?.products) {
    console.log('Current export:');
    console.log(`  Total exported: ${export_.products.length}`);
    if (export_.timestamp) console.log(`  Timestamp: ${export_.timestamp}`);
    if (export_.filters?.query) console.log(`  Query: ${export_.filters.query}`);
    if (export_.filters?.vendor) console.log(`  Vendor: ${export_.filters.vendor}`);
    if (export_.filters?.status) console.log(`  Status: ${export_.filters.status}`);
    if (export_.filters?.limit) console.log(`  Limit: ${export_.filters.limit}`);
    console.log();
  } else {
    console.log('Current export: not available');
    console.log();
  }

  const plan = readJson('plan.json');
  if (plan?.plan) {
    console.log('Current plan:');
    console.log(`  Total products: ${plan.plan.length}`);
    if (plan.input) console.log(`  Input: ${plan.input}`);
    if (plan.exportSource?.exportTimestamp) console.log(`  Export timestamp: ${plan.exportSource.exportTimestamp}`);
    if (plan.exportSource?.exportFilters) {
      const ef = plan.exportSource.exportFilters;
      if (ef.query) console.log(`  Export query: ${ef.query}`);
      if (ef.vendor) console.log(`  Export vendor: ${ef.vendor}`);
      if (ef.limit) console.log(`  Export limit: ${ef.limit}`);
    }
    if (plan.exportSource?.totalExported != null) console.log(`  Export totalExported: ${plan.exportSource.totalExported}`);
    if (plan.filters?.category) console.log(`  Category: ${plan.filters.category}`);
    if (plan.filters?.limit) console.log(`  Plan limit: ${plan.filters.limit}`);
    console.log();
  }

  const match = checkPlanMatchesExport(plan, export_);
  const matchLine = match.matches ? 'YES' : 'NO';
  console.log(`Plan matches current export: ${matchLine}`);
  if (!match.matches) {
    console.log(`  Reason: ${match.reason}`);
    console.log('  Run: npm run rename:plan -- --category=garden');
    console.log();
  }

  console.log();

  const validation = readJson('validation.json');
  if (validation?.validation?.riskCounts) {
    const rc = validation.validation.riskCounts;
    console.log('Latest validation:');
    console.log(`  Low: ${rc.low}  Medium: ${rc.medium}  High: ${rc.high}  Skip: ${rc.skip}`);
    console.log(`  Issues: ${validation.validation.issueCount}  Duplicates: ${validation.validation.duplicateCount}`);
    console.log();
  }

  const dryRun = readJson('dry-run.json');
  if (dryRun) {
    console.log('Latest dry-run:');
    console.log(`  Selected: ${dryRun.totalSelected}  Skipped: ${dryRun.totalSkipped}  High blocked: ${dryRun.totalHighRiskBlocked}`);
    const results = dryRun.results || [];
    const dryCount = results.filter((r) => r.mutationStatus === 'dry-selected').length;
    console.log(`  Dry-run logged: ${dryCount}`);
    console.log();
  }

  const apply = readJson('apply.json');
  if (apply) {
    console.log('Latest apply:');
    console.log(`  Selected: ${apply.totalSelected}  Skipped: ${apply.totalSkipped}  High blocked: ${apply.totalHighRiskBlocked}`);
    const results = apply.results || [];
    const success = results.filter((r) => r.mutationStatus === 'success').length;
    const failed = results.filter((r) => r.mutationStatus === 'failed').length;
    console.log(`  Success: ${success}  Failed: ${failed}`);
    console.log();
  }

  console.log('==============================================');
}

main();
