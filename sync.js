#!/usr/bin/env node
/**
 * Supplier XML → Shopify inventory sync.
 *
 * Usage:
 *   node sync.js                       # runs all suppliers, applies updates
 *   node sync.js all
 *   node sync.js megapap
 *   node sync.js b2bmarkt
 *
 *   node sync.js --dry-run             # runs all suppliers, no writes
 *   node sync.js megapap --dry-run     # per-supplier dry-run
 */

import 'dotenv/config';
import { runInventorySync } from './lib/inventorySync.js';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const positional = args.filter((a) => !a.startsWith('-'));
  const supplierKey = (positional[0] || 'all').toLowerCase();

  const result = await runInventorySync({ supplierKey, dryRun });
  process.exit(result.hasErrors ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(e.exitCode || 1);
});
