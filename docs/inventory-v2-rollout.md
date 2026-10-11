# Mebelcenter Ops — Inventory Synchronization V2

Implementation and validation: 2026-10-10. This extends the existing internal React/Vite + Node/Vercel operations application.

**No production metafield definitions, mappings, ownership records, locks, journals, Shopify inventory quantities, or B2BCenter quantities were written during development. No deployment was performed.** Live validation used supplier downloads and Shopify reads; mutations were tested with mocks and schema validation only. Existing uncommitted Prices, Missing Products, SKU migration, adapter, dependency, and navigation work was preserved.

## 1. Architecture and durable storage

The common engine lives in `lib/inventory/`. Supplier parsing reuses the existing catalog adapters. Canonical identities preserve strings and leading zeros: MegaPap `model`, B2BMarkt/Symetron `ProductCode`. SKU/ItemCode support initial discovery; inventory synchronization subsequently uses only persisted canonical identities.

Shopify variant metafields are the authoritative production registry:

- `$app:mebelcenter_inventory / supplier_identity`: JSON `{version:1,suppliers:{megapap:"0086733"}}`.
- `$app:mebelcenter_inventory / stock_ownership`: JSON `{version:1,locations:{"gid://shopify/Location/104700412237":{supplier:"megapap",supplierProductId:"0086733",reason:"...",decision:"default",decidedAt:"..."}}}`.

Identity and location ownership are separate. A variant can contain verified identities from both Europe suppliers; a location has one authorized supplier. App-owned variant definitions use `PRODUCTVARIANT`, `json`, and `MERCHANT_READ`, preventing merchant/other-app edits. Initialization is an explicit CLI write, because this existing client-credentials application has no Shopify CLI-managed app TOML lifecycle. Backfill writes both fields atomically with `metafieldsSet` and `compareDigest`, then reads them back.

Private app-installation metafields hold a compare-and-set writer lock and `run_<uuid>` journals. The lock serializes this application's mapping and quantity writers across concurrent Vercel instances. It has no automatic expiry: uncertain write outcomes retain it until operator reconciliation. Journals record completed batch indexes, timestamps, cumulative counts, partial/final state, and up to 20 sample problems. Recent history reads the durable journals; local files are only export/report artifacts. No new database, credentials, Prisma, or service was introduced. Existing Supabase remains exclusively the separate B2BCenter destination.

Uniqueness is checked against the complete variant registry before each write batch. Conflicting canonical identities or destination collisions block affected records. This is application-enforced uniqueness rather than a Shopify database unique index.

## 2. Discovery and matching safety

Discovery is read-only. Automatic backfill requires at least two independent exact references to one variant, using current SKU, legacy SKU, suitable barcode, or a legacy handle. A product handle is eligible only when the full catalog scan proves that product has exactly one variant. Vendor corroborates evidence and never establishes identity. Conflicting exact references, insufficient evidence, duplicate supplier identifiers, duplicate destinations, and unverifiable cross-supplier destinations remain unresolved. Reports include candidate GIDs, evidence, reasons, and suggested resolutions; titles are never fuzzy matched.

Mapping persistence is a distinct signed, confirmed operation. Batches contain at most 20 proposals and are idempotent/resumable through durable journals. A changed source fingerprint, location, mapping digest, ownership, or evidence rejects/blocks the relevant work. Explicit ownership overrides require a verified identity and reason; transferring an existing owner also requires `--allow-ownership-change`.

An approved overrides JSON file uses exact variant/location keys, for example `{ "gid://shopify/ProductVariant/53513498657101:gid://shopify/Location/104700412237": { "supplier": "symetron", "reason": "Explicitly reviewed sourcing decision" } }`. Pass it to fresh discovery with `--overrides=approved-overrides.json`, review the new signed proposals, and authorize the ownership change separately. This is an example of the supported format, not a recommendation to change the shared record's B2BMarkt ownership.

Quantity parsing accepts whole, nonnegative decimal units through signed 32-bit range. Zero is valid. Missing, malformed, negative, boolean, repeated, fractional, exponent, and unsupported values are reported/skipped rather than converted to zero. Missing feed records never cause automatic destination zeroing. XML validity and nonempty catalogs are required.

## 3. Read-only live coverage

The current app can read all **11,664 Shopify variants**. The only active location observed was **Sofia**, `gid://shopify/Location/104700412237`; all 11,664 variants had a location inventory level. No V2 identity mappings or protected definitions existed at validation time. Required `write_products` and `write_inventory` scopes were already present; no permissions were changed.

| Supplier | Feed rows | Verified identities | Missing Shopify variant | Insufficient evidence | Conflicts |
|---|---:|---:|---:|---:|---:|
| MegaPap | 3,345 | 2,929 | 414 | 2 | 0 |
| B2BMarkt | 8,533 | 6,897 | 1,447 | 186 | 3 |
| Symetron | 399 | 350 | 49 | 0 | 0 |

Verified identity counts include one shared variant; **10,175 unique variants** are proposed for persistence. These are corroborated mapping proposals, not live inventory update counts. The report is an expiring snapshot; rollout requires fresh discovery.

Read-only evidence is stored locally in ignored `.tmp/inventory-v2-live-discovery.json` and `.tmp/inventory-v2-location-snapshot.json`. Discovery's uncompressed report was approximately 15.1 MB; its compressed HTTP response was approximately 1.16 MB. Authenticated inventory responses use gzip and refuse oversized compressed results, keeping this catalog within Vercel's response limit. Requests accepting signed batches limit their body size.

An offline projection applied the proposals to an in-memory copy only. It found one invalid MegaPap supplier quantity, 2,928 eligible MegaPap matches, 6,897 B2BMarkt matches, and 350 Symetron identity matches (one owned by B2BMarkt). It is not a synchronized live preview: feed and inventory snapshots were observed at different times. Unresolved mappings continue to block MegaPap/B2BMarkt supplier readiness until independently verified; missing destination products are reported/skipped and do not block otherwise complete mappings.

## 4. Overlaps and Symetron

The verified shared record `0612644 / HM6207.01`, with matching supplier `ProductId 73498`, resolves to variant `gid://shopify/ProductVariant/53513498657101`. Its default owner is B2BMarkt. Symetron cannot write that location. A disappearance from B2BMarkt does not silently transfer the recorded owner to Symetron.

Other unverifiable cross-supplier/destination collisions remain blocked. MegaPap cannot be merged into Europe ownership. The 3 B2BMarkt conflicts and 188 insufficient-evidence rows need review against exact historical import/variant references. An ownership override cannot establish a missing identity. No manual guesses were persisted.

Symetron now has first-class Shopify preview/apply/history/UI support through the same engine and its existing configured feed. Once approved mappings are persisted, its exclusively owned variants can synchronize; the shared variant is skipped. Existing `B2BMARKT_SYMETRON_URL` takes precedence over the optional English URL. No missing environment variable or alternate production URL was invented.

## 5. Shopify apply safety

Preview reads **available at the selected location**, never aggregate `inventoryQuantity`. Location auto-selection is allowed only with exactly one active location; otherwise `SHOPIFY_LOCATION_ID` is required.

Each HMAC-signed batch binds supplier, destination, engine version, location, all supplier feed fingerprints, variant/item identity, metafield digests, observed quantity, proposed quantity, issuance, and expiry. Tokens expire after 30 minutes. Signing derives from existing Shopify client secret plus store binding; an optional `INVENTORY_PREVIEW_SECRET` supports a dedicated key. Workers and authorized CLI must share that configuration. Frontend quantities cannot override signed data.

Apply requires explicit confirmation. Changes over 40% of eligible rows require separate large-update approval. Each row rechecks identity, owner, variant, item, tracking, location, and quantity immediately before an `inventorySetQuantities` call. `compareQuantity` catches an intervening external inventory change. Already-correct stock produces no write; stale rows are skipped. Tracking, SKU, prices, titles, tags, images, product status, vendor, and unrelated locations are never changed.

Reads preserve the existing Shopify retry behavior. Mutations retry only explicit throttling/HTTP 429 rejection; unknown transport outcomes are never blindly retried. API rejection is counted as failure. Unknown outcomes stop subsequent writes and retain the lock. A valid report can resume acknowledged batches without duplicate inventory writes. Failed/stale rows require a new preview rather than a blind replay.

Legacy Shopify Apply via `/api/sync` and unsigned old CLI execution are blocked. Authenticated V2 endpoints serve preview, discovery, history, signed apply batches, and separately confirmed mapping batches.

## 6. B2BCenter compatibility

MegaPap/B2BMarkt retain portal-specific tenant + manufacturer + canonical SKU matching. Shopify variant IDs are never used as portal IDs. Shared strict parsing rejects invalid quantities and duplicate source/destination identities. Updates continue to modify `products.quantity` only and retain threshold guards. Conditional writes include tenant, manufacturer, product ID, SKU, observed quantity, and `updated_at` so concurrent content or inventory changes cannot be silently overwritten.

Portal Apply additionally requires a signed read-only portal preview binding its tenant, manufacturer, feed and plan fingerprint, version, and threshold. The UI never automatically approves the threshold. Existing portal log files remain compatible; their execution history can be ephemeral on Vercel and is labelled accordingly.

Live portal preview failed because the currently configured database hostname returned **ENOTFOUND**. Repair/verify the existing `B2BCENTER_SUPABASE_URL` and project reachability before portal rollout. No replacement URL or database was created. Mocked tests verify destination isolation, quantity-only payloads, strict parsing, and conditional-write failure accounting. Symetron's portal product identity/ownership remains unverified and its portal Apply stays unavailable.

## 7. UI changes

The Bulgarian page keeps warm backgrounds, white rounded cards, red actions, and existing components. Three compact Shopify cards and two compact portal cards show observed connection state, mapping readiness, counts, preview time, successful sync when known, and disabled Apply until a valid authorized preview exists.

The preview panel has ten summary metrics, searchable/filterable rows, pagination, explicit skip/conflict reasons, variant/canonical IDs, location quantities, deltas, and problem CSV export with spreadsheet formula escaping. Discovery has a downloadable JSON report. Confirmation has keyboard focus handling and an unchecked large-change approval. Applying reports batch progress and partial outcomes, then refreshes durable history, including after errors. Unknown history is shown as unknown rather than invented success.

Local browser verification covered login, inventory navigation, disabled initial actions, live Symetron read-only preview, canonical-ID search, problem filtering, zero quantities, blocked Apply, and desktop/mobile layouts. No live Apply control was used. Screenshots are in `.tmp/inventory-v2-desktop.png` and `.tmp/inventory-v2-mobile.png`.

## 8. Files delivered

New backend: `lib/inventory/{config,feeds,authorization,identity,shopify,service,setup}.js`; CLI: `scripts/inventory-v2.js`.

Updated integration: `lib/inventorySync.js`, `lib/b2bcenterSync.js`, `lib/dashboardApp.js`, `api/index.js`, `sync.js`, `scripts/b2bcenter/sync.js`, `package.json`, `.env.example`.

Updated UI: `src/pages/InventorySyncPage.tsx`, inventory portions of `src/lib/api.ts`, `src/lib/types.ts`, and scoped additions to `src/styles/global.css`; generated `public/app` output.

Tests: `test/inventory-identity.test.js`, `test/inventory-service.test.js`, `test/inventory-portal-api.test.js`. Documentation: this guide and the existing identity audit. Other working-tree changes predate this task and were preserved.

## 9. Verification

- `npm test`: **148 passed, 0 failed** (84 existing + 64 inventory tests).
- `npm run build`: successful Vite build, backend syntax checks, TypeScript check.
- Shopify schema validation: all new registry, app-data, definition, inventory, targeted read, history, and lock operations validate against Admin API 2026-10. Live read-only operations also worked with the repository's configured API version. Validation did not execute mutations.
- API mocks cover authentication and inability to bypass preview through legacy Apply.
- Store tests cover compare-and-set lock retention, whole-operation Shopify user errors, selected-location writes, negative destination inventory correction, definitions readiness, expiration/tampering, ownership, staleness, partial failure, unknown outcomes, and concurrency.
- Existing Prices, Missing Products, SKU migration, supplier adapter, and portal tests remain green.

## 10. Deployment commands and prerequisites

From this repository, using the existing authenticated Vercel CLI and linked `ops.mebelcenter` project:

```sh
npm ci
npm test
npm run build
vercel deploy
```

Verify the preview deployment with the existing dashboard password and read-only previews. This document does not authorize deployment. Production deployment, when separately approved:

```sh
vercel deploy --prod
```

`api/index.js` exports a 300-second duration configuration to support full catalog reads without changing existing Vercel routing/builders. Confirm the deployed project's plan/runtime accepts that duration, and measure a full preview on the deployment before enabling writes. A timeout must remain a failed operation, never apparent success. Vercel documents Node API exported configuration in [function duration guidance](https://vercel.com/docs/functions/configuring-functions/duration).

Retain working feed URLs and existing client credentials. Pin the approved Sofia GID in existing `SHOPIFY_LOCATION_ID` if desired. Ensure preview/production deployments cannot apply through a different client configuration accidentally; tokens are shop-key bound. The example environment file contains comments only, not new live credentials. Definitions must be initialized separately before mapping or inventory writes.

## 11. Gated production rollout

Each write stage below requires separate explicit authorization. **These commands were not run.**

1. Deploy and verify read-only behavior. Confirm Sofia, required scopes, all three configured feeds, password protection, duration, compressed response size, and portal prerequisites.
2. Generate a fresh read-only discovery report:

```sh
mkdir -p .tmp
node scripts/inventory-v2.js discover --file=.tmp/inventory-discovery.json
```

Review all proposals, conflicts, insufficient evidence, suggested resolutions, and shared ownership. Do not treat discovery as authorization to persist.

3. After approval for the two protected definitions only:

```sh
node scripts/inventory-v2.js init-definitions --confirm
```

4. After separate mapping approval, start with one batch (up to 20 variants):

```sh
node scripts/inventory-v2.js backfill --file=.tmp/inventory-discovery.json --confirm --max-batches=1
node scripts/inventory-v2.js history
```

Read back the canonical identities and owner at Sofia. Definition setup and backfill do not change inventory. After review, rerunning with `--max-batches=1` processes the next uncompleted batch. Removing the limit processes remaining batches while the signed report remains valid:

```sh
node scripts/inventory-v2.js backfill --file=.tmp/inventory-discovery.json --confirm
```

At expiry or changed feed/evidence, create and review a fresh discovery report. Persisted mappings remain authoritative and already-correct entries need no rewrite. Full catalog revalidation before every batch intentionally costs time and API reads; a 10,175-variant backfill will need multiple reviewed discovery windows. Large initial backfill should run from the authorized CLI, not one Vercel request. Unresolved existing candidate rows keep their supplier's Apply disabled until independently verified.

5. Generate and review a supplier preview; Symetron is shown as an example:

```sh
node scripts/inventory-v2.js preview --supplier=symetron --file=.tmp/inventory-symetron-preview.json
```

Confirm readiness, Sofia quantities, shared record's B2BMarkt owner, invalid/skipped records, and change percentage. The dashboard provides the same signed preview flow.

6. After separate approval for real inventory changes, apply one batch:

```sh
node scripts/inventory-v2.js apply --supplier=symetron --file=.tmp/inventory-symetron-preview.json --confirm --max-batches=1
```

If it exceeds the 40% threshold, the command refuses unless the reviewed change size is separately approved and `--allow-large-apply` is explicitly added. There is no automatic approval. Verify Shopify available quantity and history before processing remaining batches. Use fresh previews for stale/failed rows. Repeat independently for MegaPap/B2BMarkt only after their unresolved mapping readiness is resolved.

7. After repairing the portal connection, run its separate read-only preview:

```sh
node scripts/b2bcenter/sync.js megapap --dry-run
```

The output identifies a JSON log under `LOG_DIR`; it contains `previewToken`. Review that exact report. After separate portal quantity approval:

```sh
node scripts/b2bcenter/sync.js megapap --apply --confirm --preview-file=logs/EXACT-DRYRUN-REPORT.json
```

Replace the placeholder with the actual path printed by the preview. Add `--allow-large-apply` only after separately approving an over-threshold plan. Repeat for B2BMarkt independently. Do not activate Symetron portal synchronization.

8. If a worker dies or returns an unknown mutation outcome:

```sh
node scripts/inventory-v2.js inspect-lock
node scripts/inventory-v2.js history
```

Stop other writers, confirm no invocation/CLI remains active, and reconcile actual quantities/metafields against the report. Only after operator review, clear the exact observed holder with an auditable reason:

```sh
node scripts/inventory-v2.js recover-lock --holder=EXACT-OBSERVED-UUID --reason=reviewed-and-reconciled --confirm
```

Never force recovery while an operation may still be running. After recovery, generate a fresh preview. Rolling back the UI deployment cannot undo quantities already applied; corrections require a new reviewed preview rather than restoring stale stock.

## 12. Remaining operational limits

- Definitions and mappings are implemented but deliberately not persisted live. The UI remains gated.
- MegaPap's 2 and B2BMarkt's 189 unresolved existing candidates need independent identity review; absent destination products remain skipped.
- Full-registry scans between signed batches favor collision safety over throughput. Feed changes/30-minute expiry can require repeated discovery or preview windows. No background queue or new service was added.
- The application lock governs this app's writers; other apps/orders can change inventory. Shopify compare-and-set prevents stale quantity overwrite, but does not make the entire supplier run atomic.
- Unknown outcomes require manual lock reconciliation. Journals retain completed batches and capped sample problems; exported reports retain full row details. Journal history currently has no automatic retention purge, so monitor growth rather than deleting audit records automatically.
- A failed/timeout batch can have completed earlier row writes before the journal commits. Target-quantity checks prevent duplicate stock changes after reconciliation; those unjournaled changes need operator accounting and must not be advertised as confirmed history.
- The portal's configured hostname is unreachable, and Symetron portal identity/ownership is unverified. Those live steps remain blocked while independent Shopify implementation and tests are complete.

## Dashboard setup and verified-only synchronization (2026-10-11)

The first-use setup is now available from the authenticated dashboard, locally and in the deployed build:

1. Click **Преглед на съпоставянето** and review verified mappings, conflicts, and ownership.
2. Click **Запиши проверените съпоставяния**, then confirm the separate mapping operation. This initializes missing protected definitions and persists only the signed, corroborated proposals. It does not change quantities, SKU, or product content. Existing ownership transfers remain blocked in this browser flow.
3. Progress is displayed per batch. **Спри след текущата партида** stops between batches; completed mappings remain durable. Reuse a still-valid report to resume acknowledged batches, or generate a fresh discovery after expiry/feed changes. Full-catalog revalidation can take time; there is no automatic refresh or implicit approval of a new report.
4. Click **Преглед на промените** for the desired supplier. If unresolved rows block full readiness, click **Преглед само на проверените**. This explicitly requests a partial preview; the supplier still displays incomplete mapping readiness. Only eligible persisted identities are signed for Apply; unmatched/conflicting/invalid rows remain skipped.
5. Click **Синхронизирай проверените** (or **Синхронизирай** for complete readiness), review the exact change count/location, and confirm. Over-40% changes still require the separate unchecked approval. Staleness, ownership, quantity compare-and-set, and writer locks remain enforced.

The partial choice is signed into the preview and cannot be supplied retroactively to bypass a full-preview rejection. It cannot bypass missing protected definitions, permissions, or identity checks for selected rows. CLI equivalent: add `--verified-only` to the `preview` command, then use the normal separately confirmed `apply` command.

The updated suite has **153 passing tests**, including signed browser setup authorization, authenticated mapping endpoint coverage, partial-preview binding, missing-definition blocking, exclusion of unresolved/duplicate canonical rows, and preservation of discovery titles, SKUs and location quantities. The local browser's live read-only discovery proposed 10,177 mappings; the mapping confirmation dialog opened and was cancelled successfully. No live mapping or quantity write was executed while validating this follow-up.
