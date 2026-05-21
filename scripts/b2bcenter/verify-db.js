#!/usr/bin/env node
/**
 * B2BCenter Supabase — Phase 0 read-only DB verification.
 *
 * Verifies live `products` table facts before the B2BCenter inventory sync
 * engine is built. This script is STRICTLY read-only: no inserts, updates,
 * deletes, or mutating RPC calls.
 *
 * Required env vars:
 *   B2BCENTER_SUPABASE_URL
 *   B2BCENTER_SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   B2BCENTER_TENANT_ID
 *
 * Usage:  npm run b2bcenter:verify-db
 *
 * Exit codes:
 *   0  required facts confirmed enough to start Phase 1
 *   1  required env vars missing, or a critical DB fact could not be confirmed
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const TABLE = 'products';
const PAGE_SIZE = 1000;
const PROBE_COLUMNS = [
  'id',
  'sku',
  'quantity',
  'manufacturer',
  'tenant_id',
  'is_visible',
  'updated_at',
];

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function mask(value) {
  if (!value) return '(unset)';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

async function main() {
  console.log('=== B2BCenter Supabase — Phase 0 DB Verification (read-only) ===\n');

  const url = process.env.B2BCENTER_SUPABASE_URL;
  const serviceRoleKey = process.env.B2BCENTER_SUPABASE_SERVICE_ROLE_KEY;
  const tenantIdEnv = process.env.B2BCENTER_TENANT_ID || '';

  const missing = [];
  if (!url) missing.push('B2BCENTER_SUPABASE_URL');
  if (!serviceRoleKey) missing.push('B2BCENTER_SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    fail(`Missing required env var(s): ${missing.join(', ')}`);
  }

  console.log(`Supabase URL:        ${url}`);
  console.log(`Service role key:    ${mask(serviceRoleKey)} (loaded, not printed)`);
  console.log(`B2BCENTER_TENANT_ID: ${tenantIdEnv ? tenantIdEnv : '(not set — will infer)'}\n`);

  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Node 20 has no native WebSocket; provide `ws` so supabase-js loads cleanly.
    realtime: { transport: WebSocket },
  });

  // --- 1. Probe column existence ---------------------------------------
  console.log('--- Probing column existence ---');
  const columns = {};
  for (const col of PROBE_COLUMNS) {
    const { error } = await supabase.from(TABLE).select(col).limit(1);
    const exists = !error;
    columns[col] = exists;
    if (exists) {
      console.log(`  ✓ ${col}`);
    } else {
      console.log(`  ✗ ${col}  (${error.message})`);
    }
  }

  if (!columns.id && !columns.sku) {
    fail(
      'Could not read even `id`/`sku` from products — connection, key, or table name is wrong.',
    );
  }

  // --- 2. Sample rows + id type ----------------------------------------
  const availableCols = PROBE_COLUMNS.filter((c) => columns[c]);
  console.log('\n--- Fetching small sample ---');
  const { data: sample, error: sampleError } = await supabase
    .from(TABLE)
    .select(availableCols.join(','))
    .limit(5);
  if (sampleError) {
    fail(`Sample query failed: ${sampleError.message}`);
  }
  console.log(`  fetched ${sample.length} sample row(s)`);

  let idType = 'unknown';
  if (sample.length && columns.id) {
    const v = sample[0].id;
    if (typeof v === 'number') idType = 'integer (number)';
    else if (typeof v === 'string') {
      idType = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? 'uuid (string)' : 'string';
    } else idType = typeof v;
  }
  console.log(`  products.id type: ${idType}`);

  if (sample.length) {
    const r = sample[0];
    const redacted = {};
    for (const c of availableCols) redacted[c] = r[c];
    console.log(`  sample row keys: ${Object.keys(redacted).join(', ')}`);
  }

  // --- 3. Total count ---------------------------------------------------
  console.log('\n--- Counting rows ---');
  const { count: totalCount, error: countError } = await supabase
    .from(TABLE)
    .select('*', { count: 'exact', head: true });
  if (countError) {
    fail(`Total count query failed: ${countError.message}`);
  }
  console.log(`  total products: ${totalCount}`);

  // --- 4. Visibility counts --------------------------------------------
  let activeCount = null;
  let archivedCount = null;
  if (columns.is_visible) {
    const active = await supabase
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
      .eq('is_visible', true);
    const archived = await supabase
      .from(TABLE)
      .select('*', { count: 'exact', head: true })
      .eq('is_visible', false);
    if (!active.error) activeCount = active.count;
    if (!archived.error) archivedCount = archived.count;
    console.log(`  is_visible=true  (active):   ${activeCount ?? 'n/a'}`);
    console.log(`  is_visible=false (archived): ${archivedCount ?? 'n/a'}`);
  } else {
    console.log('  is_visible column absent — cannot split active/archived');
  }

  // --- 5. Full paginated scan (pagination test + aggregation) ----------
  console.log('\n--- Paginated scan (pagination test, read-only) ---');
  const scanCols = ['id'];
  if (columns.manufacturer) scanCols.push('manufacturer');
  if (columns.tenant_id) scanCols.push('tenant_id');

  const manufacturerCounts = new Map();
  const tenantCounts = new Map();
  let scanned = 0;
  let page = 0;
  let pagesPastCap = 0;

  for (;;) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(TABLE)
      .select(scanCols.join(','))
      .order('id', { ascending: true })
      .range(from, to);
    if (error) {
      fail(`Paginated scan failed on page ${page + 1}: ${error.message}`);
    }
    scanned += data.length;
    for (const row of data) {
      if (columns.manufacturer) {
        const m = row.manufacturer == null ? '(null)' : String(row.manufacturer);
        manufacturerCounts.set(m, (manufacturerCounts.get(m) || 0) + 1);
      }
      if (columns.tenant_id) {
        const t = row.tenant_id == null ? '(null)' : String(row.tenant_id);
        tenantCounts.set(t, (tenantCounts.get(t) || 0) + 1);
      }
    }
    console.log(`  page ${page + 1}: rows ${from}-${from + data.length - 1} (${data.length})`);
    if (data.length < PAGE_SIZE) break;
    page++;
    if (page >= 1) pagesPastCap++;
  }
  console.log(`  scanned ${scanned} rows across ${page + 1} page(s)`);

  const paginationWorks = scanned >= PAGE_SIZE ? pagesPastCap > 0 : true;
  if (scanned >= PAGE_SIZE) {
    console.log(
      `  pagination past 1000-row cap: ${paginationWorks ? 'CONFIRMED' : 'NOT confirmed'}`,
    );
  } else {
    console.log(
      `  dataset is < ${PAGE_SIZE} rows — pagination past the cap could not be exercised`,
    );
  }

  // --- 6. Manufacturer breakdown ---------------------------------------
  if (columns.manufacturer) {
    console.log('\n--- Manufacturers ---');
    const sorted = [...manufacturerCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, n] of sorted) {
      console.log(`  ${String(n).padStart(7)}  ${name}`);
    }
    console.log(`  ${sorted.length} distinct manufacturer value(s)`);
  }

  // --- 7. Tenant resolution --------------------------------------------
  console.log('\n--- Tenant ---');
  let selectedTenant = null;
  const tenantWarnings = [];
  if (!columns.tenant_id) {
    console.log('  products.tenant_id column ABSENT — products are not tenant-scoped.');
    tenantWarnings.push('tenant_id column does not exist; tenant scoping is not possible');
  } else {
    const tenantIds = [...tenantCounts.keys()].filter((t) => t !== '(null)');
    console.log(`  distinct tenant_id value(s): ${tenantIds.length}`);
    for (const [t, n] of tenantCounts.entries()) {
      console.log(`    ${String(n).padStart(7)}  ${t}`);
    }
    if (tenantIdEnv) {
      selectedTenant = tenantIdEnv;
      const scoped = await supabase
        .from(TABLE)
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantIdEnv);
      if (scoped.error) {
        tenantWarnings.push(`scoped count for B2BCENTER_TENANT_ID failed: ${scoped.error.message}`);
      } else {
        console.log(`  B2BCENTER_TENANT_ID scoped product count: ${scoped.count}`);
        if (scoped.count === 0) {
          tenantWarnings.push('B2BCENTER_TENANT_ID matches zero products — verify the UUID');
        }
        if (!tenantIds.includes(tenantIdEnv)) {
          tenantWarnings.push(
            'B2BCENTER_TENANT_ID was not seen in the scanned rows — verify the UUID',
          );
        }
      }
    } else if (tenantIds.length === 1) {
      selectedTenant = tenantIds[0];
      console.log(`  inferred single tenant UUID: ${selectedTenant}`);
    } else if (tenantIds.length === 0) {
      tenantWarnings.push('tenant_id column exists but all values are null');
    } else {
      tenantWarnings.push(
        `multiple tenant_id values found (${tenantIds.length}) — set B2BCENTER_TENANT_ID explicitly, not assuming one`,
      );
    }
  }

  // --- 8. Summary + recommendations ------------------------------------
  console.log('\n=== SUMMARY ===');
  console.log(`Total products:          ${totalCount}`);
  console.log(`products.id type:        ${idType}`);
  console.log(`Stock column 'quantity': ${columns.quantity ? 'CONFIRMED' : 'MISSING'}`);
  console.log(`products.sku:            ${columns.sku ? 'present (SKU match key OK)' : 'MISSING'}`);
  console.log(`products.manufacturer:   ${columns.manufacturer ? 'present' : 'absent'}`);
  console.log(`products.tenant_id:      ${columns.tenant_id ? 'present' : 'absent'}`);
  console.log(`products.is_visible:     ${columns.is_visible ? 'present' : 'absent'}`);
  console.log(`products.updated_at:     ${columns.updated_at ? 'present' : 'absent'}`);
  if (columns.is_visible) {
    console.log(`Active / Archived:       ${activeCount ?? 'n/a'} / ${archivedCount ?? 'n/a'}`);
  }
  console.log(`Selected tenant ID:      ${selectedTenant || '(none)'}`);
  console.log(
    `Pagination past 1000:    ${
      scanned >= PAGE_SIZE ? (paginationWorks ? 'CONFIRMED' : 'FAILED') : 'untested (small dataset)'
    }`,
  );

  const warnings = [...tenantWarnings];
  if (!columns.quantity) warnings.push('stock column `quantity` is missing — sync target unknown');
  if (!columns.sku) warnings.push('`sku` is missing — SKU matching is not possible');
  if (!columns.manufacturer) warnings.push('`manufacturer` absent — manufacturer-scoped runs unavailable');
  if (!columns.is_visible) warnings.push('`is_visible` absent — archived products cannot be skipped');
  if (scanned >= PAGE_SIZE && !paginationWorks) {
    warnings.push('pagination past the 1000-row cap could not be confirmed');
  }

  if (warnings.length) {
    console.log('\n--- WARNINGS ---');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }

  // Critical facts required to start Phase 1.
  const criticalOk =
    columns.quantity &&
    columns.sku &&
    (scanned < PAGE_SIZE || paginationWorks) &&
    (!columns.tenant_id || selectedTenant != null);

  console.log('\n--- NEXT RECOMMENDED ACTION ---');
  if (criticalOk) {
    console.log('  ✓ Core facts confirmed. Update plan §6 with the confirmed values, then');
    console.log('    proceed to Phase 1 (create lib/b2bcenterSync.js engine skeleton).');
    if (columns.tenant_id && !tenantIdEnv && selectedTenant) {
      console.log(`  → Set B2BCENTER_TENANT_ID=${selectedTenant} in .env and Vercel.`);
    }
    process.exit(0);
  } else {
    console.log('  ✗ Critical facts unresolved. Do NOT start Phase 1 yet. Resolve the');
    console.log('    warnings above (esp. the stock column, SKU, tenant, or pagination).');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n✖ Verification failed: ${e.message || e}`);
  process.exit(1);
});
