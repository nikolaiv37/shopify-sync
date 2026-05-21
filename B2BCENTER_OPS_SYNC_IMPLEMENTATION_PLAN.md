# B2BCenter Ops Sync — Implementation Plan

> Created: 2026-05-21 | Repo: `mebelcenter-shopify` (powers `opsmebelcenter.vercel.app`)
> Status: **Planning only.** No application code changed in this pass.

This document plans how to add a **B2BCenter / Supabase inventory sync** target as a
**separate operational module** inside the existing `mebelcenter-shopify` ops project,
without renaming the repo, reorganizing the project, or touching the working Shopify
supplier operations.

Source of intent: `B2BCENTER_INVENTORY_SYNC_PLAN.md` in the B2BCenter repo.

---

## 1. Current Ops Project Architecture Summary

| Aspect | Detail |
|---|---|
| **Package** | `mebelcenter-supplier-sync` v1.0.0, `"type": "module"`, Node 20.x |
| **Dependencies** | `dotenv`, `fast-xml-parser` (only two — intentionally tiny) |
| **Entry (HTTP)** | `dashboardServer.js` → local Node `http` server on `DASHBOARD_PORT` (3000) |
| **Entry (Vercel)** | `api/index.js` → wraps `handleDashboardRequest`; `vercel.json` routes `/(.*)` to it |
| **Core HTTP app** | `lib/dashboardApp.js` — routing, auth, HTML rendering, API handlers |
| **Sync engine** | `lib/inventorySync.js` — XML → Shopify inventory sync |
| **CLI entry** | `sync.js` — thin CLI wrapper over `runInventorySync()` |
| **Scripts** | `scripts/` — price sync, missing products, renaming v1/v2/v3, audits, translation |
| **Config** | `config/*.json` — supplier feed URLs + category maps (Megapap, B2BMarkt) |
| **Logs** | `logs/` locally; `/tmp/mebelcenter-logs` on Vercel (ephemeral) |
| **Reports** | `reports/` — CSV audit outputs |
| **Auth** | Single shared password (`DASHBOARD_PASSWORD`) → SHA-256 cookie `mebelcenter_ops_auth` |

### Routing map (`lib/dashboardApp.js`)

| Method | Path | Handler |
|---|---|---|
| GET | `/api/health` | `handleHealth` (unauthenticated) |
| GET | `/` | login page / redirect to `/dashboard` |
| GET | `/dashboard` | `renderDashboardPage` (auth required) |
| POST | `/api/login` | `handleLogin` |
| POST | `/api/logout` | `handleLogout` |
| GET | `/api/status` | `handleStatus` (in-memory current/last run) |
| GET | `/api/runs` | `handleRuns` (reads `logs/*.json`) |
| POST | `/api/sync` | `handleSync` (runs `runInventorySync`) |

The dashboard is **server-rendered HTML** built by string templates (`renderDashboardPage`,
`renderSupplierCard`, `renderStyles`, `renderClientScript`). There is no React/build step;
`build` is just `node --check` syntax validation of the core files.

### Concurrency model

`currentRun` / `lastCompletedRun` are **module-level globals**. Only one sync runs at a
time; a second `POST /api/sync` returns HTTP 409. On Vercel this state is per–serverless
instance and not durable.

---

## 2. Existing Shopify Sync Flow Summary

`runInventorySync({ supplierKey, dryRun, onLog })` in `lib/inventorySync.js`:

1. **Config** — `getConfig()` reads env, defines two suppliers (`megapap`, `b2bmarkt`)
   with `vendor`, `feedUrl`, and XML tag names (`productTag`, `skuTag`, `stockTag`).
2. **Auth** — `fetchAccessToken()` does Shopify OAuth client-credentials exchange.
3. **Per supplier** (`runSupplier`), 5 steps:
   - Fetch supplier XML feed (`fetchXml`).
   - Parse XML into a `Map<sku, qty>` (`parseSupplierFeed`); duplicate SKUs collapse.
   - Fetch Shopify vendor product IDs + all variants + location ID (in parallel).
   - **Build update plan** — for each vendor variant: skip if SKU not in feed
     (`notInXml`), skip if untracked, skip if quantity unchanged; otherwise push
     `{ ...variant, newQty, delta }`.
   - **Dry-run** prints a 10-row preview and writes nothing.
     **Apply** calls `applyInventoryUpdates()` in batches via
     `inventorySetQuantities`, using `compareQuantity: currentQty` for optimistic
     concurrency safety.
4. **Logging** — every run writes `logs/<runId>.json` + `logs/<runId>.log` with a
   structured `summary` (counts, errors, feed URL, timing).

### Key safety properties already present (worth copying)

- **Dry-run is a true no-op** — the plan is built identically, only the write is skipped.
- **`compareQuantity` guard** — Shopify rejects the write if the live quantity drifted
  from what the plan saw. This is the Shopify equivalent of snapshot safety.
- **Batching + retry/backoff** — `gqlWithRetry` handles throttling; apply is batched.
- **`unchanged` skip** — no-op writes are filtered out before apply.
- **Structured run summary** — consistent JSON shape consumed by the dashboard.

---

## 3. Reusable Modules

These can be reused **as-is** or with light, additive generalization:

| Module / function | Reuse for B2BCenter sync | Notes |
|---|---|---|
| `lib/dashboardApp.js` HTTP shell | ✅ Yes | Auth, cookie, routing, HTML rendering all reusable. Add new routes + a new nav target. |
| Auth (`requireAuth`, cookie logic) | ✅ Yes | Same `DASHBOARD_PASSWORD` gate protects the new module too. |
| `createLogger(onLog)` pattern | ✅ Yes | Streaming log lines into `currentRun.logs` works for any engine. |
| Run-summary JSON + `.log` writer | ✅ Yes (generalize) | Reuse the dual-file pattern; widen `listRecentRuns` filename filter. |
| `listRecentRuns` / `/api/runs` | ✅ Yes (generalize) | Currently filters `megapap-`/`b2bmarkt-` prefixes — needs a `b2bcenter-` prefix. |
| Dashboard UI shell (sidebar, panels, styles) | ✅ Yes | Add a new nav item + a new supplier-style card; reuse `renderStyles`. |
| `getRuntimeLogDir()` | ✅ Yes | Same ephemeral-on-Vercel behavior applies. |
| `currentRun` single-run guard | ✅ Yes | Keep one global run lock across both engines (don't run Shopify + B2BCenter at once). |
| Dry-run → preview → apply UX | ✅ Yes | Same two-button card pattern. |

**Conclusion:** the dashboard shell, auth, logging, and run-history machinery are
engine-agnostic. The B2BCenter module mainly needs a **new engine file** and a
**new config block**.

---

## 4. Shopify-Specific Modules That Must NOT Be Touched

Leave these functionally unchanged. The B2BCenter module must not modify their behavior.

| Module / area | Why it is Shopify-specific |
|---|---|
| `lib/inventorySync.js` — `fetchAccessToken`, `gql`, `gqlWithRetry` | Shopify Admin OAuth + GraphQL. |
| `lib/inventorySync.js` — `discoverLocationId`, `fetchVendorProductIds`, `fetchAllVariants`, `applyInventoryUpdates` | Shopify product/variant/inventory model. |
| `getConfig()` supplier block (`megapap`, `b2bmarkt`) | Shopify vendor + XML feed assumptions. |
| `sync.js` CLI | Wraps the Shopify engine specifically. |
| `config/*.json` | Megapap / B2BMarkt feed + category maps. |
| `scripts/**` (price sync, missing products, renaming v1–v3, audits, translation) | All Shopify catalog operations. |
| `.graphql` files in repo root | Shopify GraphQL documents. |
| `update-prices.js`, `update-*-images*.js`, `export-missing-products.js` | Shopify catalog tools. |

**Rule:** the B2BCenter sync is a **new sibling engine**, not an edit to
`inventorySync.js`. The only edits to shared files are *additive* (new routes, new nav
item, new config block, widened log-file filter).

---

## 5. Proposed B2BCenter Sync Architecture

A new engine file mirrors `inventorySync.js` but targets Supabase instead of Shopify.

```
Supabase B2BCenter feed (manufacturer XML/CSV)
        │  fetch + parse → Map<sku, qty>
        ▼
lib/b2bcenterSync.js   ── runB2BCenterSync({ manufacturerKey, dryRun, onLog })
        │  read products from Supabase (tenant-scoped, SKU + quantity + visibility)
        │  build plan: feed qty vs product quantity, SKU-matched
        ▼
   dry-run → preview + report only
   apply   → update products.quantity in batches (Supabase update by id)
        │
        ▼
logs/b2bcenter-<runId>.json + .log   (same dual-file format)
```

- **Client:** use Supabase **REST (PostgREST)** via plain `fetch` with the
  **service-role key**, OR add `@supabase/supabase-js` as a dependency. Recommendation:
  add `@supabase/supabase-js` — it is small, handles pagination/filters cleanly, and
  keeps the engine readable. (Plain `fetch` avoids a dependency but reimplements paging.)
- **Tenant scoping:** every read and write filtered by `tenant_id = <B2BCenter tenant>`.
- **Manufacturer scoping (optional):** when set, also filter `manufacturer = <name>`.
- **Match key:** `products.sku` only.
- **Write field:** `products.quantity` only (see §6 — confirm column name).
- **No creation, no archive** — products missing from the feed are counted and listed
  in the report, never modified.

The engine exposes `runB2BCenterSync(...)` with the **same `{ supplierKey-like, dryRun,
onLog }` shape** so `handleSync` can dispatch to it with minimal branching.

---

## 6. B2BCenter Product Columns — CONFIRMED (Phase 0 complete)

Confirmed against the **live** B2BCenter Supabase DB via `scripts/b2bcenter/verify-db.js`
on 2026-05-21:

| Column | Status | Notes |
|---|---|---|
| `products.id` | ✅ Confirmed | **uuid / string** (not the original `SERIAL`). Update key when apply mode is built. |
| `products.sku` | ✅ Confirmed | The SKU match key. |
| **stock column** | ✅ Confirmed | The DB column is **`quantity`**. `stock` is only a TS runtime alias. Write target is `quantity`. |
| `products.manufacturer` | ✅ Confirmed | Used for manufacturer-scoped runs. |
| `products.tenant_id` | ✅ Confirmed | Exists. Single B2BCenter tenant. |
| `products.is_visible` | ✅ Confirmed | Used to skip + report archived products. |
| `products.updated_at` | ✅ Confirmed | Trigger-updated. Included in the report. |

### Confirmed live DB facts (Phase 0)

- `products.id` type: **uuid / string**
- Stock column: **`products.quantity`**
- `tenant_id` exists; selected tenant UUID: **`f8489344-cd6c-4fd6-a04f-474e2b72e459`**
- Total products: **10345**
- Manufacturers: **Europe 7333**, **Mebelcenter 3012**
- Active / archived (`is_visible`): **10342 / 3**
- Pagination past the PostgREST ~1000-row cap: **confirmed**

---

## 7. Dry-Run / Apply Snapshot Safety

The Shopify engine relies on Shopify's `compareQuantity`. Supabase has no built-in
optimistic-concurrency primitive for a plain update, so snapshot safety must be explicit:

1. **Single snapshot per run.** Fetch the feed once and the product rows once; dry-run
   and the report are computed from that snapshot. Cache the feed payload so a
   subsequent apply in the same run uses the identical feed.
2. **Plan carries `currentQuantity`.** Each plan row records the quantity observed at
   snapshot time (`{ id, sku, currentQuantity, newQuantity, delta }`).
3. **Apply re-reads then guards.** Before each apply batch, re-fetch the current
   `quantity` for the rows in that batch and **skip any row whose live quantity no
   longer equals `currentQuantity`** — log it as `drifted`. This emulates
   `compareQuantity` and prevents clobbering a concurrent change.
   - Alternative (preferred if feasible): a Supabase RPC / SQL function that does
     `UPDATE products SET quantity = :new WHERE id = :id AND quantity = :expected`
     and returns affected-row count. This makes the guard atomic.
4. **Apply only after dry-run.** Enforce in the UI and the handler: an apply request
   must reference a dry-run done in the same session/run. At minimum the UI keeps the
   Shopify pattern (confirm dialog: "Did you run a dry run first?"); ideally the server
   tracks the last dry-run summary per manufacturer and rejects apply without one.
5. **Large-change threshold.** If the plan would change more than a configurable
   percentage of scoped products (e.g. `B2BCENTER_MAX_CHANGE_PCT`, default 40%), or
   would set many products to 0, the apply requires an explicit override flag.
6. **Batched, fault-tolerant apply.** Update in batches (reuse `BATCH_SIZE`); continue
   past per-row errors and record them.

---

## 8. Persist Logs / Reports

Reuse the existing dual-file pattern, with a distinct prefix so the two engines never
collide:

- `logs/b2bcenter-<runId>.json` — structured summary (see §10).
- `logs/b2bcenter-<runId>.log` — human-readable text summary.
- `runId` format: `b2bcenter[-<manufacturer>][-DRYRUN]-<ISO timestamp>`.

Changes needed to the shared history code in `lib/dashboardApp.js`:

- `listRecentRuns()` currently only accepts `megapap-` / `b2bmarkt-` prefixes. Widen it
  to also include `b2bcenter-`, OR make it accept a prefix list. Keep Shopify rows and
  B2BCenter rows distinguishable (add a `target: 'shopify' | 'b2bcenter'` field to the
  normalized run object).
- `normalizeSummary()` and `SUPPLIERS` lookup must tolerate B2BCenter run keys.

**Vercel caveat:** `logs/` resolves to `/tmp/mebelcenter-logs` on Vercel and is
**ephemeral** — run history does not survive cold starts. This is an existing limitation
of the Shopify side too. For B2BCenter, if durable history is wanted, a Phase-2 option
is to write the run summary into a Supabase table (`ops_sync_runs`) — but v1 keeps
parity with the current Shopify behavior (file-based, best-effort).

---

## 9. Required Environment Variables

New variables (add to `.env` locally and Vercel project settings):

| Variable | Purpose | Required |
|---|---|---|
| `B2BCENTER_SUPABASE_URL` | B2BCenter Supabase project URL | Yes |
| `B2BCENTER_SUPABASE_SERVICE_ROLE_KEY` | Service-role key — server-side writes, bypasses RLS | Yes |
| `B2BCENTER_TENANT_ID` | The single B2BCenter tenant UUID, for tenant-scoped queries | Yes |
| `B2BCENTER_FEED_URL` (or per-manufacturer, e.g. `B2BCENTER_GREEK_FEED_URL`) | Manufacturer inventory feed source | Yes |
| `B2BCENTER_MAX_CHANGE_PCT` | Safety threshold for apply (default 40) | Optional |

Existing variables are unchanged. The Shopify (`SHOPIFY_*`, `MEGAPAP_FEED_URL`,
`B2BMARKT_MAIN_URL`) and `DASHBOARD_PASSWORD` variables stay exactly as-is.

**Secret handling:** `B2BCENTER_SUPABASE_SERVICE_ROLE_KEY` is highly sensitive (full DB
access). It must only ever live in `.env` (gitignored) and Vercel env settings — never
committed, never sent to the browser. The dashboard already runs server-side only, so
the engine reads it from `process.env` and never includes it in any API response.

---

## 10. Required Supabase Queries / Mutations

All against the B2BCenter Supabase project, service-role, tenant-scoped.

### Read — scoped product snapshot
```
GET products?select=id,sku,quantity,manufacturer,is_visible,updated_at
    &tenant_id=eq.<B2BCENTER_TENANT_ID>
    [&manufacturer=eq.<name>]
```
- Page through results (PostgREST caps responses ~1000 rows — same truncation issue the
  B2BCenter portal hit with manufacturers; page with `Range` headers or `.range()`).
- Build `Map<sku, { id, quantity, is_visible }>`.

### Write — apply (per row, guarded)
```
PATCH products?id=eq.<id>&quantity=eq.<expectedQuantity>&tenant_id=eq.<tenant>
Body: { "quantity": <newQuantity> }
```
- The `quantity=eq.<expectedQuantity>` filter makes the update a no-op if the row
  drifted — the response row count reveals whether it applied. This is the
  PostgREST-level snapshot guard.
- Batch with `Prefer: return=minimal`. Continue past per-row failures.

### Decisions to confirm
- Whether to also bump `updated_at` (likely automatic via trigger).
- Whether to write `availability` text alongside `quantity` — **v1 says no**, stock
  column only. Leave `availability` untouched.

No inserts, no deletes, no updates to price/category/name/description/image columns.

---

## 11. UI Changes (opsmebelcenter dashboard)

All additive, in `lib/dashboardApp.js`:

1. **Sidebar nav** — the nav already lists disabled items (`Price Sync`, `Missing
   Products`, …). Add an enabled **"B2BCenter Sync"** nav item (or convert one disabled
   slot). For v1, the dashboard can stay single-page and the B2BCenter card can sit on
   the same page in its own section.
2. **B2BCenter target card** — add a card like `renderSupplierCard`, but for the
   B2BCenter portal sync. Distinct accent tone (e.g. purple) so it is visually separate
   from the Shopify supplier cards. Buttons: **Dry Run** / **Apply Sync**. Card meta:
   "Supabase · Stock only · SKU match".
3. **Manufacturer scope selector** (optional in v1) — a dropdown on the card to limit a
   run to one manufacturer (e.g. the Greek manufacturer) vs. all.
4. **Run output / logs panels** — reuse as-is; they are already engine-agnostic.
5. **Recent Runs table** — add a column or badge indicating target
   (`Shopify` vs `B2BCenter`) once `listRecentRuns` returns mixed rows.
6. **Apply confirm dialog** — reuse the existing `window.confirm` "did you run a dry
   run?" guard, worded for B2BCenter.

No change to the login page, styling system, or the Shopify supplier cards.

---

## 12. Safety Rules

1. **Do not edit `lib/inventorySync.js` behavior.** New engine = new file
   (`lib/b2bcenterSync.js`).
2. **Stock/quantity only.** Never write price, category, name, description, image,
   `is_visible`, or any other column.
3. **No product creation.** Feed SKUs not found in B2BCenter are skipped + reported.
4. **No auto-archive.** B2BCenter products missing from the feed are reported only and
   left untouched.
5. **SKU-only matching.** No name/fuzzy matching; unmatched rows are skipped + logged.
6. **Tenant isolation.** Every read and write filtered by `B2BCENTER_TENANT_ID`. Never
   write a row outside the configured tenant.
7. **Dry-run first.** Apply is gated behind a dry-run; default action is dry-run.
8. **Snapshot guard on apply.** Per-row `quantity=eq.<expected>` filter (or RPC) so a
   concurrent change is never clobbered; drifted rows are skipped + logged.
9. **Change threshold.** Abnormally large plans require an explicit override.
10. **Service-role key stays server-side.** Never in responses, never committed.
11. **One run at a time.** Keep the single-run global lock shared across both engines.
12. **Don't break Shopify.** `npm run build` (`node --check`) must still pass; add the
    new files to the `build` check list.

---

## 13. Step-by-Step Implementation Phases

**Phase 0 — Confirm DB facts (no code).**
- Read-only queries against B2BCenter Supabase: confirm `products.id` type, stock column
  name (`quantity`), `tenant_id` presence, and the single tenant UUID. Update §6.

**Phase 1 — Engine skeleton (`lib/b2bcenterSync.js`).**
- New file. `runB2BCenterSync({ manufacturerKey, dryRun, onLog })`.
- Config loader for `B2BCENTER_*` env vars; reuse the `createLogger` pattern.
- Feed fetch + parse → `Map<sku, qty>` (reuse `parseSupplierFeed`-style logic; copy, do
  not import from the Shopify file if it would couple them — or extract a shared
  `lib/feedParser.js` only if trivially clean).

**Phase 2 — Supabase read + plan + dry-run.**
- Paginated tenant-scoped product read.
- Build plan (`id, sku, currentQuantity, newQuantity, delta`); compute
  `notInFeed` / `notInPortal` / `unchanged` / `archivedSkipped` counts.
- Dry-run: preview + write `logs/b2bcenter-<runId>.json` + `.log`. No DB writes.

**Phase 3 — Apply path.**
- Guarded per-row updates (`quantity=eq.<expected>`), batched, fault-tolerant.
- Change-threshold check. Drift detection + logging.

**Phase 4 — Dashboard wiring (`lib/dashboardApp.js`, additive).**
- New nav item + B2BCenter card + (optional) manufacturer selector.
- `handleSync` dispatches to `runB2BCenterSync` when the target is B2BCenter.
- Widen `listRecentRuns` prefix filter; add `target` field; update `normalizeSummary`.
- Add new files to the `build` (`node --check`) script.

**Phase 5 — Test + document.**
- Run the manual checklist (§14). Update this doc with confirmed DB facts and any
  deviations.

Each phase is independently committable and leaves Shopify ops untouched.

---

## 14. Manual Testing Checklist

Shopify regression (must still pass after every phase):
- [ ] `npm run build` passes (`node --check` on all core files incl. new ones).
- [ ] `npm run dry-run:megapap` and `:b2bmarkt` still produce a plan + logs.
- [ ] Dashboard loads, login works, Megapap/B2BMarkt cards run dry-run + apply.
- [ ] Recent Runs table still shows Shopify runs.

B2BCenter dry-run:
- [ ] Engine connects to B2BCenter Supabase with the service-role key.
- [ ] Product read is tenant-scoped and fully paginated (no ~1000-row truncation).
- [ ] Feed parses to a `Map<sku, qty>`; duplicate SKUs collapse, blank SKUs skipped.
- [ ] Plan counts are correct: changed / unchanged / notInFeed / notInPortal / archived.
- [ ] Dry-run writes `logs/b2bcenter-*-DRYRUN-*.json` + `.log` and **zero DB writes**
      (verify a couple of `quantity` values are unchanged in the DB).
- [ ] Manufacturer-scoped dry-run only considers that manufacturer's products.

B2BCenter apply:
- [ ] Apply only after a dry-run; confirm dialog appears.
- [ ] Updated `quantity` values match the feed for a sample of SKUs.
- [ ] Price, category, name, description, image, `is_visible` are all **unchanged**.
- [ ] Products missing from the feed are reported and **unchanged**.
- [ ] Feed SKUs missing from the portal are reported, no rows created.
- [ ] Drift guard: manually change one `quantity` after dry-run → that row is skipped
      and logged as drifted, not clobbered.
- [ ] Change-threshold blocks an abnormally large plan without an override.
- [ ] Re-running apply with the same feed is idempotent (0 further changes).
- [ ] Run appears in Recent Runs tagged as B2BCenter.

Security:
- [ ] Service-role key never appears in any HTTP response or browser-visible HTML.
- [ ] `.env` with the new keys is gitignored and not committed.

---

## 15. Phase 1/2 — Dry-Run Engine Implemented (2026-05-21)

Phases 1 and 2 are complete. A **dry-run-only** B2BCenter sync engine now exists.
Apply/write mode is intentionally **not** implemented yet.

**New files:**
- `lib/b2bcenterSync.js` — engine, exports `runB2BCenterSync({ supplierKey, dryRun, onLog })`.
  Self-contained XML helpers; does not import from `lib/inventorySync.js`.
- `scripts/b2bcenter/sync.js` — CLI entry (dry-run only).

**New npm commands:**
- `npm run b2bcenter:dry-run` — all suppliers
- `npm run b2bcenter:dry-run:megapap` — Mebelcenter manufacturer scope
- `npm run b2bcenter:dry-run:b2bmarkt` — Europe manufacturer scope

**Status / safety:**
- Dry-run only. `runB2BCenterSync` throws if `dryRun !== true`; the CLI errors
  without `--dry-run`. **No Supabase writes** are performed (`updated` is always 0).
- Reads are tenant-scoped (`tenant_id = f8489344-…`) and manufacturer-scoped
  (`megapap → Mebelcenter`, `b2bmarkt → Europe`), paginated with `.range()`.
- Feed sources reuse the existing `MEGAPAP_FEED_URL` / `B2BMARKT_MAIN_URL` env vars.
- Each run writes `logs/b2bcenter-<supplier>-DRYRUN-<timestamp>.json` + `.log`.

## 16. Phase 4 (partial) — Dashboard Dry-Run Wiring Implemented (2026-05-21)

The B2BCenter dry-run engine is now wired into the ops dashboard as a **separate,
dry-run-only module**. All changes to `lib/dashboardApp.js` are additive.

- **New UI section** — "B2BCenter Portal Sync", below the Shopify supplier grid,
  with two violet cards (Megapap → Mebelcenter, B2BMarkt → Europe). Card meta:
  `Supabase · Stock only · SKU match · Dry-run only`. Each card has a working
  **Dry Run** button and a **disabled "Apply later"** button. Copy makes clear it
  is Supabase (not Shopify) and dry-run only.
- **API** — `POST /api/sync` now accepts an optional `target` field
  (`"shopify"` | `"b2bcenter"`, default `"shopify"`). `target: "b2bcenter"` calls
  `runB2BCenterSync` and **rejects `dryRun !== true` with HTTP 400**. The Shopify
  path (`runInventorySync`, apply included) is unchanged and backward compatible —
  payloads without `target` still behave exactly as before.
- **Status / Recent Runs** — `normalizeSummary` and `listRecentRuns` are
  target-aware; `listRecentRuns` now also reads `b2bcenter-*` log files. Runs are
  labelled `Shopify · …` / `B2BCenter · …` so both engines coexist in the history.
- **Safety** — B2BCenter dashboard buttons only ever send `dryRun: true`; the
  server enforces it; no Supabase writes; service-role key never reaches HTML/JSON.

## 17. Phase 3 — Guarded CLI Apply Implemented (2026-05-21)

Guarded apply/write mode is implemented **for the CLI only**. The dashboard
remains dry-run-only (its Apply button is still disabled, and `/api/sync`
still rejects `dryRun !== true` for `target: "b2bcenter"`).

**Apply scope:** updates `products.quantity` **only**. Never price, category,
name/title, description, image, manufacturer, sku, tenant_id, is_visible, or any
other column. No product creation. No auto-archive. Archived products and feed
SKUs missing from the portal are skipped + reported, never written.

**Apply commands (CLI only):**
- `npm run b2bcenter:apply:megapap -- --confirm`
- `npm run b2bcenter:apply:b2bmarkt -- --confirm`
- Add `--allow-large-apply` when the planned change exceeds the threshold:
  `npm run b2bcenter:apply:megapap -- --confirm --allow-large-apply`

**Safety gates:**
- `--apply` without `--confirm` → blocked, exit 1, no writes.
- `supplierKey "all"` with `--apply` → blocked, exit 1. Apply one supplier at a time.
- **Change threshold** — `plannedChangePct = planned / activeProducts * 100`.
  Env var `B2BCENTER_MAX_CHANGE_PCT` (default **40**). If exceeded, apply is
  blocked (exit 1, no writes, a blocked report is still written) unless
  `--allow-large-apply` is passed. Current dry-runs are ~57% (megapap) /
  ~48% (b2bmarkt), so apply currently requires `--allow-large-apply`.
- **Snapshot guard** — each row is updated with
  `update({ quantity }).eq('id').eq('tenant_id').eq('manufacturer').eq('quantity', currentQuantity).eq('is_visible', true).select()`.
  1 row back → `updated`; 0 rows → `conflictSkipped` (drift, not fatal);
  error → `errors`. No unguarded updates. Updates are sequential in v1.
- Service-role key is never logged.

**Reports:** `logs/b2bcenter-<supplier>-APPLY-<timestamp>.json` + `.log`, with a
`safety` block (`confirm`, `allowLargeApply`, `maxChangePct`, `plannedChangePct`,
`thresholdBlocked`), full counts incl. `conflictSkipped`, `appliedPreview`,
`conflictPreview`, and `errorDetail`.

## 18. Phase 4 — Dashboard Apply Enabled (2026-05-21)

The first real CLI apply completed successfully for both suppliers
(Megapap updated 1727, B2BMarkt updated 3554; 0 conflicts, 0 errors). With apply
proven safe, the guarded apply is now available from the password-protected
dashboard. All changes to `lib/dashboardApp.js` are additive; the engine's
threshold and snapshot-guard logic is unchanged.

**UI:** the B2BCenter cards now show a real **Apply Sync** button (amber/warning
style) alongside Dry Run. The disabled "Apply later" placeholder is gone. Card
meta: `Supabase · Stock only · SKU match · Quantity only`.

**Confirmation flow:** clicking Apply Sync shows a `window.confirm` dialog naming
the supplier/manufacturer and stating that only `quantity` is updated (not price,
category, name, image, or visibility) and to dry-run first. Cancel → no request.

**Dashboard apply payload:**
```json
{ "target": "b2bcenter", "supplierKey": "megapap" | "b2bmarkt",
  "dryRun": false, "confirm": true, "allowLargeApply": true }
```
Dry-run payload is unchanged (`dryRun: true`, no confirm). `allowLargeApply: true`
is sent only after the operator confirms the dialog — the engine still records
`plannedChangePct` / `maxChangePct` / `thresholdBlocked` in the report.

**Server-side safety gates (`/api/sync`, `target: "b2bcenter"`):**
- `dryRun: false` without `confirm: true` → HTTP 400, no run.
- `supplierKey: "all"` with apply → HTTP 400 (only `megapap` / `b2bmarkt` valid).
- Shopify path and B2BCenter dry-run path are unchanged and backward compatible.
- Single-run lock, logs/reports, quantity-only writes, snapshot guard, and
  tenant/manufacturer scoping all preserved.

Recent Runs shows B2BCenter dry-runs, B2BCenter applies, and Shopify runs
together, labelled `B2BCenter · …` / `Shopify · …`.

---

## Appendix — Relationship to Other Docs

- `B2BCENTER_INVENTORY_SYNC_PLAN.md` (B2BCenter repo) — product-level plan and scope.
- `B2BCENTER_TODO_ROADMAP.md` (B2BCenter repo) — item 13 references this work.
- This document lives in the `mebelcenter-shopify` repo because the sync is built here.
