#!/usr/bin/env node
/**
 * B2BCenter (Supabase) inventory sync CLI.
 *
 * Dry-run (default, safe — no writes):
 *   node scripts/b2bcenter/sync.js megapap  --dry-run
 *   node scripts/b2bcenter/sync.js b2bmarkt --dry-run
 *   node scripts/b2bcenter/sync.js all      --dry-run
 *
 * Guarded apply (CLI only — updates products.quantity only):
 *   node scripts/b2bcenter/sync.js megapap  --apply --confirm
 *   node scripts/b2bcenter/sync.js megapap  --apply --confirm --allow-large-apply
 *
 * Apply safety gates:
 *   - --apply alone (no --confirm)         → blocked, exit 1, no writes.
 *   - planned change % over threshold      → blocked, exit 1, no writes,
 *     unless --allow-large-apply is passed.
 *   - supplierKey "all" with --apply       → blocked, exit 1. Apply one at a time.
 */

import 'dotenv/config';
import { runB2BCenterSync } from '../../lib/b2bcenterSync.js';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const confirm = args.includes('--confirm');
  const allowLargeApply = args.includes('--allow-large-apply');
  const positional = args.filter((a) => !a.startsWith('-'));
  const supplierKey = (positional[0] || 'all').toLowerCase();

  if (!apply) {
    // Default and --dry-run both mean dry-run. No writes possible.
    const result = await runB2BCenterSync({ supplierKey, dryRun: true });
    process.exit(result.hasErrors ? 1 : 0);
  }

  // Apply mode.
  if (supplierKey === 'all') {
    console.error(
      'Refusing to apply for "all". B2BCenter apply runs one supplier at a time. ' +
        'Use: megapap or b2bmarkt.',
    );
    process.exit(1);
  }
  if (!confirm) {
    console.error(
      'Refusing to apply without confirmation. Re-run with --apply --confirm ' +
        '(add --allow-large-apply if the planned change exceeds the threshold).',
    );
    process.exit(1);
  }

  const result = await runB2BCenterSync({
    supplierKey,
    dryRun: false,
    confirm: true,
    allowLargeApply,
  });

  const blocked = result.results.some((r) => r.blocked);
  if (blocked) {
    console.error(
      'Apply was blocked by the safety threshold. Review the dry-run, then re-run with ' +
        '--apply --confirm --allow-large-apply if the change is expected.',
    );
  }
  process.exit(result.hasErrors ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(e.exitCode || 1);
});
