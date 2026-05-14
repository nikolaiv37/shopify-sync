# Product renaming V2 — job-based pipeline

Scalable, resumable rename pipeline. V1 (`scripts/product-renaming/`) still works
and is unchanged; V2 lives next to it.

Every run lives inside a **job folder** at
`logs/product-renaming/jobs/<jobId>/` and contains every artifact required to
audit, resume, or roll back that run.

## Mutation policy

Allowed mutations (same as V1):
- `title`
- `seo.title`
- `seo.description`
- `descriptionHtml` — only the controlled model-name replacement

**Never mutated**:
`handle, sku, vendor, productType, tags, variants, price, inventory, images, status, collections`

## Pipeline

```
create-job  →  export-job-products  →  plan-job  →  validate-job  →  apply-job
                                                                        │
                                                                        └─→ rollback-job
```

Each step writes one or more files into the job folder and refuses to run if
its required inputs are missing or stale.

## Job folder layout

```
logs/product-renaming/jobs/<jobId>/
  job.json                # meta, filters, mutation policy, status
  export.json             # exported products + pagination cursor
  allocation-state.json   # persistent {category-model -> new name}
  plan.json               # per-item rename plan + status
  validation.json         # categorized validation result
  review-queue.csv        # human review queue (same as needs-review.csv)
  ready.csv               # items eligible for apply
  needs-review.csv        # items routed to manual review
  blocked.csv             # items never eligible for apply
  duplicates.csv          # duplicate new-title rows
  apply-progress.json     # checkpoint: nextIndex + counts
  apply-log.ndjson        # append-only per-product audit log
  rollback.json           # previous values of successfully-applied items
  failed.json             # apply failures
```

## Per-item statuses

`plan-job` and `validate-job` mark each item with one of:

| Status         | Meaning                                                                 | Eligible for apply? |
| -------------- | ----------------------------------------------------------------------- | ------------------- |
| `skipped`      | Already renamed, or no title change needed                              | no                  |
| `ready`        | Low-risk, no hard failures, no warnings                                 | yes                 |
| `needs_review` | Has soft warnings or medium risk — requires explicit approval to apply  | only with `--approve-medium` + `--include-medium` |
| `blocked`      | Hard quality failure, high risk, or duplicate new title                 | **never**           |

## Safety guarantees preserved from V1

- Default mode is **dry-run**. Real mutations require `--apply`.
- **High-risk items are never applied.** Blocked items are never applied.
- **`--apply` requires `--limit`.** Resuming or applying the entire eligible
  set without a limit requires the explicit `--confirm-full-job` flag, which
  prints a loud warning before proceeding.
- **Stale-plan protection (SHA256-based)**: apply refuses to run unless:
  - the current SHA256 hash of `export.json` matches the `exportHash` recorded
    in `plan.json` and in `validation.json`, and
  - the current SHA256 hash of `plan.json` matches the `planHash` recorded in
    `validation.json`, and
  - `job.filters` matches `export.filters` matches `plan.exportFilters`, and
  - `validation.canApply` is true.
- **Shopify-state check before each mutation**:
  - if current title equals new title → recorded as `already_applied`, no mutation
  - if current title differs from both old and new title → recorded as
    `manual_change_detected`, no mutation
- Mutation scope is enforced in code: `shopify-client.updateProductRename` has
  no parameters for vendor, handle, SKU, tags, variants, price, inventory,
  images, status, or collections.
- AI fallback is **a stub only**. It will never call any external model unless
  both `AI_FALLBACK_ENABLED=true` and `AI_FALLBACK_API_KEY` are present. Any
  future AI output must re-enter `quality-gates.decide()` before applying.
- All Shopify mutations route through the same retry/throttle-aware client.

## Safe first-run procedure

The recommended way to use V2 for the very first time on a real Shopify
store. Each step is small, audited, and stops immediately on inconsistency.

```bash
# 1. Create a job, capture the jobId. Pick the narrowest scope you can.
JOB=$(npm run --silent rename:v2:create -- --category=garden --vendor=Europe --status=ACTIVE | tail -n 1)
echo "$JOB"

# 2. Export products into the job folder. READ-ONLY.
npm run rename:v2:export -- --job="$JOB"

# 3. Generate the rename plan. READ-ONLY.
npm run rename:v2:plan -- --job="$JOB"

# 4. Validate and emit CSVs. READ-ONLY.
npm run rename:v2:validate -- --job="$JOB"

# 5. Inspect status and hash integrity. READ-ONLY.
npm run rename:v2:status -- --job="$JOB"

# 6. Open the CSVs and inspect:
#    logs/product-renaming/jobs/$JOB/ready.csv
#    logs/product-renaming/jobs/$JOB/needs-review.csv
#    logs/product-renaming/jobs/$JOB/blocked.csv
#    logs/product-renaming/jobs/$JOB/duplicates.csv

# 7. Dry-run apply (low-risk only). NO Shopify mutations.
npm run rename:v2:apply -- --job="$JOB" --dry-run

# 8. Apply the first 10 LOW-RISK items only. Real mutations.
npm run rename:v2:apply -- --job="$JOB" --apply --limit=10 --risk=low

# 9. Check what just happened.
npm run rename:v2:status -- --job="$JOB"

# 10. Spot-check those 10 products in the Shopify admin UI.
#     If anything looks wrong, roll back immediately:
#        npm run rename:v2:rollback -- --job="$JOB" --apply --limit=10

# 11. ONLY AFTER manual review of step 10, resume the next 50:
npm run rename:v2:apply -- --job="$JOB" --apply --resume --limit=50
```

Never use `--confirm-full-job` until at least two batches above have been
manually verified end-to-end (Shopify admin UI + status output).

## Commands

```bash
# 1. Create a job (writes job.json, prints the jobId on the last line)
npm run rename:v2:create -- --category=garden --vendor=Europe --status=ACTIVE
npm run rename:v2:create -- --category=sofas --query="tag:градински" --limit=500

# 2. Export products from Shopify into the job
npm run rename:v2:export -- --job=<jobId>
npm run rename:v2:export -- --job=<jobId> --resume   # continue if interrupted

# 3. Generate the rename plan (deterministic; persists name allocation)
npm run rename:v2:plan -- --job=<jobId>

# 4. Validate the plan and emit CSVs
npm run rename:v2:validate -- --job=<jobId>
npm run rename:v2:validate -- --job=<jobId> --approve-medium

# 5. Dry-run apply (always do this first)
npm run rename:v2:apply -- --job=<jobId> --dry-run

# 6. Real apply, in small batches. --limit is required.
npm run rename:v2:apply -- --job=<jobId> --apply --limit=10
npm run rename:v2:apply -- --job=<jobId> --apply --resume --limit=50    # continue, capped at 50
npm run rename:v2:apply -- --job=<jobId> --apply --include-medium --limit=10   # requires --approve-medium
npm run rename:v2:apply -- --job=<jobId> --apply --concurrency=2 --limit=20    # default concurrency is 2

# Apply ENTIRE eligible set without a limit (loud warning is printed).
# Use only after multiple smaller batches have been verified.
npm run rename:v2:apply -- --job=<jobId> --apply --confirm-full-job

# 7. Status and audit
npm run rename:v2:status -- --job=<jobId>
npm run rename:v2:status -- --list

# 8. Rollback (dry-run by default)
npm run rename:v2:rollback -- --job=<jobId>
npm run rename:v2:rollback -- --job=<jobId> --apply --limit=10
```

## Status-job output

`status-job` prints the following counts:

`exported, planned, ready, needs_review, blocked, applied, failed, skipped,
already_applied, manual_change_detected`.

## AI fallback (stub)

`lib/ai-fallback.js` is a stub. It will only activate when both env vars are
set, and currently always returns `{ used: false }`. The future contract is:

- triggered by reasons: `no_model_detected`, `unresolved_truncated_fragment`,
  `duplicate_unresolved`, `title_rebuilt_from_scratch`, `too_many_words_removed`
- must return strict JSON `{ newTitle, newSeoTitle, newSeoDescription }`
- output **must** round-trip through `quality-gates.decide()` before apply
- output never bypasses validation

## V1 compatibility

V1 scripts under `scripts/product-renaming/` are untouched. V2 imports the V1
`name-dictionaries.js` so the title-building, normalization, and truncated-
fragment repair behavior is identical.
