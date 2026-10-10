#!/usr/bin/env node
/** Legacy preview command. Live apply now requires a signed V2 report and --confirm.
 * node sync.js megapap --dry-run
 * node scripts/inventory-v2.js help
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
