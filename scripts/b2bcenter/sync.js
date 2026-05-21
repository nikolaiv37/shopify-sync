#!/usr/bin/env node
/**
 * B2BCenter (Supabase) inventory sync CLI — DRY-RUN ONLY (Phase 1 + 2).
 *
 * Usage:
 *   node scripts/b2bcenter/sync.js megapap  --dry-run
 *   node scripts/b2bcenter/sync.js b2bmarkt --dry-run
 *   node scripts/b2bcenter/sync.js all      --dry-run
 *
 * Apply/write mode is not implemented. Running without --dry-run exits with
 * an error rather than touching the database.
 */

import 'dotenv/config';
import { runB2BCenterSync } from '../../lib/b2bcenterSync.js';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const positional = args.filter((a) => !a.startsWith('-'));
  const supplierKey = (positional[0] || 'all').toLowerCase();

  if (!dryRun) {
    console.error(
      'B2BCenter apply mode is not implemented yet. Re-run with --dry-run (dry-run is the only supported mode).',
    );
    process.exit(1);
  }

  const result = await runB2BCenterSync({ supplierKey, dryRun: true });
  process.exit(result.hasErrors ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(e.exitCode || 1);
});
