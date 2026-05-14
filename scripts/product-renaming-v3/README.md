# Product renaming V3 — fast, safe model-name replacement

V1 (`scripts/product-renaming/`) and V2 (`scripts/product-renaming-v2/`) are
unchanged. V3 lives next to them in `scripts/product-renaming-v3/`.

## Why V3 exists

V2 is safe and resumable but it tries to **rebuild** every product title
from scratch (prefix + new name + cleaned body), which means every category
needs many bespoke quality fixes before titles look right. With 10k+
products to rename across many categories before campaigns, that rebuild
loop is too slow.

V3 deliberately does **less**:

- It does **not** rebuild titles.
- It does **not** add prefixes.
- It does **not** normalize body text.
- It only replaces the detected **old supplier model name** with a controlled
  Bulgarian furniture-safe name — in `title`, `seo.title`, `seo.description`,
  and `descriptionHtml`.

If V3 cannot find a safe old model in a product, that product goes into
`skipped-no-model.csv` and is left untouched. That's intentional: V3 prefers
to skip rather than guess.

### Example

```
old: Сет за външен кът 4 части ENASTRON бежов алуминий и Olefin п
new: Сет за външен кът 4 части Ривиера бежов алуминий и Olefin п
```

V3 changed exactly one word.

## Mutation policy

Allowed mutations:

- `title`
- `seo.title`
- `seo.description`
- `descriptionHtml` — only the controlled model-name replacement

**Never mutated**:
`handle, sku, vendor, productType, tags, variants, price, inventory, images,
status, collections`. The Shopify client (`lib/shopify-client.js`) physically
does not expose setters for these fields.

## Pipeline

```
create  →  export  →  plan  →  validate  →  apply
                                              │
                                              └─→ rollback
```

Each step writes into the job folder and refuses to run if its inputs are
missing or stale.

## Job folder layout

```
logs/product-renaming-v3/jobs/<jobId>/
  job.json                         meta, filters, mutation policy, status
  export.json                      exported products + pagination cursor
  allocation-state.json            persistent {category-model -> name}
  plan.json                        per-item replacement plan + status
  validation.json                  categorized validation outcome
  ready.csv                        items eligible for apply
  skipped-already-renamed.csv      products already in controlled-name format
  skipped-no-model.csv             no safe old model detected
  needs-review.csv                 ambiguous/duplicate/too-many-occurrences
  blocked.csv                      hard failures
  apply-progress.json              checkpoint: nextIndex + counts
  apply-log.ndjson                 append-only per-product audit log
  rollback.json                    successfully-applied previous values
  failed.json                      apply failures
```

## Per-item statuses

| Status                     | Meaning                                                          | Eligible for apply |
| -------------------------- | ---------------------------------------------------------------- | ------------------ |
| `ready`                    | Old model detected, single-occurrence title replacement, no dup  | yes                |
| `skipped_already_renamed`  | Title prefix matches **or** title body contains a controlled name | no                 |
| `skipped_no_model`         | No safe old model detected                                       | no                 |
| `needs_review`             | Ambiguous detection, duplicate new title, too many occurrences   | no                 |
| `blocked`                  | Missing id/handle/title, no replacement happened, or model still in new title | no  |

## Already-renamed protection

V3 must never re-rename a product that someone already renamed (in V2,
manually, or in a previous V3 run). Two complementary checks:

**Protection A — title prefix.** If the title starts with a known furniture
prefix followed by any V3 controlled name, it's already renamed.
Examples: `Градински лаундж сет Аурора ...`, `Тапициран стол Милано ...`,
`Спалня Астра ...`.

**Protection B — controlled name in body.** Many products that don't start
with the canonical prefix still contain one of our controlled names.
Example: `Комплект градински мебели Аурора 4 части ...` — Аурора is one of
ours, so V3 skips it.

## Detection rules (conservative on purpose)

1. Tokens immediately following `серия` / `Series` are taken as the model.
2. Otherwise, prefer **Latin** words (length 3..30, not in
   BANNED/MATERIAL sets). A word in V1's `KNOWN_MODEL_NAMES` set is
   strongly preferred.
3. If 2+ Latin candidates disagree and none is a known model → ambiguous →
   `needs_review`.
4. Cyrillic ALL-CAPS like `АНДРОМЕДА` is accepted as a fallback.
5. A V3 controlled name is **never** returned as a detected old model.

If detection finds nothing → `skipped_no_model`. By design.

## Replacement rules

- `title` — must replace **exactly 1** occurrence. 0 → blocked. >1 →
  needs_review.
- `seo.title` / `seo.description` — replace if old model appears, leave
  unchanged otherwise.
- `descriptionHtml` — replace if old model appears 1..20 times. >20 →
  needs_review (description not modified).
- New name uses normal title case (`Ривиера`, never `РИВИЕРА`).
- HTML structure is preserved (only the model token is touched).
- No re-formatting, no prefix insertion, no disambiguation suffixes.
- If two ready items would produce the **same** new title, both are demoted
  to `needs_review` with reason `duplicate_new_title`. V3 does not
  auto-suffix.

## Allocation rule

Same `(category, oldModel)` pair always maps to the same new V3 controlled
name within a job. State lives in `allocation-state.json` so re-running
plan-job is deterministic. Across categories the allocation is independent.

## Hash-chain safety

Same SHA256 hash chain as V2:

- `plan.json` records `exportHash`.
- `validation.json` records `exportHash` and `planHash`.
- `apply-job` refuses to run unless current hashes still match what plan
  and validation recorded, AND `job.filters` equals `export.filters` equals
  `plan.exportFilters`, AND `validation.canApply === true`.

Editing any artifact by hand will break the chain — you'll need to re-run
plan and validate.

## Apply safety

- Default mode is **dry-run**. Real mutations only with `--apply`.
- `--apply` requires `--limit`, unless `--confirm-full-job` is explicitly
  passed (a loud warning is printed).
- `--resume` without `--limit` also requires `--confirm-full-job`.
- Only `status === 'ready'` items are ever applied.
- Before mutating each product, `apply-job` fetches the current Shopify
  product:
  - if current title equals the new title → `already_applied`, no mutation.
  - if current title differs from both old and new → `manual_change_detected`,
    no mutation.
- The descriptionHtml replacement is recomputed against the **live** Shopify
  description (not the export snapshot). If the live description no longer
  contains the old model 1..20 times, the descriptionHtml is left alone.
- Each successful real mutation is appended to `rollback.json`.
- Rollback is dry-run by default and requires `--apply` for real mutation.

## Commands

```bash
# 1. Create a job
npm run rename:v3:create -- --category=garden --query="tag:Градински сетове" --status=ACTIVE

# 2. Export Shopify products into the job folder (READ-ONLY)
npm run rename:v3:export -- --job=<jobId>

# 3. Generate the replacement plan (READ-ONLY)
npm run rename:v3:plan -- --job=<jobId>

# 4. Validate and emit CSVs (READ-ONLY)
npm run rename:v3:validate -- --job=<jobId>

# 5. Inspect status
npm run rename:v3:status -- --job=<jobId>

# 6. Open the CSVs:
#    logs/product-renaming-v3/jobs/<jobId>/ready.csv
#    logs/product-renaming-v3/jobs/<jobId>/skipped-already-renamed.csv
#    logs/product-renaming-v3/jobs/<jobId>/skipped-no-model.csv
#    logs/product-renaming-v3/jobs/<jobId>/needs-review.csv
#    logs/product-renaming-v3/jobs/<jobId>/blocked.csv

# 7. Dry-run apply (no Shopify mutations)
npm run rename:v3:apply -- --job=<jobId> --dry-run --limit=20
tail -n 20 logs/product-renaming-v3/jobs/<jobId>/apply-log.ndjson

# 8. Apply for real, in small batches
npm run rename:v3:apply -- --job=<jobId> --apply --limit=10
npm run rename:v3:apply -- --job=<jobId> --apply --resume --limit=50
# ENTIRE eligible set, no --limit (loud warning):
npm run rename:v3:apply -- --job=<jobId> --apply --confirm-full-job

# 9. Rollback (dry-run by default)
npm run rename:v3:rollback -- --job=<jobId>
npm run rename:v3:rollback -- --job=<jobId> --apply --limit=10
```

## Manual mapping (TODO)

The spec mentions `--manual-map=manual-map.csv` for products that V3 marks
as `skipped_no_model` but a human knows the right model for. Not implemented
in this iteration — the recommended workflow is to triage `skipped-no-model.csv`
and either spawn a category-specific job with a tighter `--query`, or feed
the handles into V2 / V1 for those edge cases.

## Relationship to V1 / V2

- V1 and V2 are untouched. V3 imports `KNOWN_MODEL_NAMES`,
  `BANNED_MODEL_WORDS`, `MATERIAL_FABRIC_WORDS`, and
  `detectCategoryFromProduct` from V1's `name-dictionaries.js` for
  consistency, but it does **not** use V1's title-rebuilding helpers.
- V3 dictionaries are deliberately a curated subset of V1's, dropping
  Bulgarian personal names (Стефани, Моника, Теди, Дани, ...) that the
  team flagged as cringe.
- V3 jobs live under `logs/product-renaming-v3/jobs/` so a V3 run can
  never collide with an in-progress V2 run.
