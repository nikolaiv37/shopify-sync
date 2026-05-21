# Shopify Product Renaming V3 — Progress Context

## Current Purpose

We are running `scripts/product-renaming-v3` to rename Shopify product model/series names to controlled Bulgarian collection names.

- **V3 workflow:** job-based export → plan → validate → dry-run → apply.
- **Mutated fields:** `title`, `seo.title`, `seo.description`, `descriptionHtml` (case-insensitive model replacement, max 20 occurrences).
- **NEVER mutated:** `handle`, `SKU`, `vendor`, `variants`, `images`, `tags`, `price`, `inventory`, `collections`, `status`, `productType`.
- **Job state:** `logs/product-renaming-v3/jobs/<jobId>/`

---

## Safety Rules

1. Always create a job with explicit `--category` and `--query` tag.
2. Always follow the full sequence: **export → plan → validate → status → dry-run → apply**.
3. Apply first **10–20 products**, check status, then continue with resume batches.
4. Use `--resume` after the first apply batch.
5. Check `fallback names used = 0` before any apply.
6. After apply, check `failed = 0` and `manual_change_detected = 0`.
7. `needs_review`, `skipped_no_model`, and `blocked` items are **never applied** automatically.
8. `rollback.json` exists in the job folder for successfully applied real mutations.
9. If dictionary order is changed after planning, delete `allocation-state.json`, re-plan, re-validate, then dry-run again.

---

## Exact Commands Template

```bash
# 1. Create job (captures jobId from output)
JOB=$(npm run --silent rename:v3:create -- --category=<category_key> --query="tag:<Bulgarian tag>" --status=ACTIVE | tail -n 1)

# 2. Export
npm run rename:v3:export -- --job="$JOB"

# 3. Plan
npm run rename:v3:plan -- --job="$JOB"

# 4. Validate
npm run rename:v3:validate -- --job="$JOB"

# 5. Status (check counts, dictionary capacity, hash integrity)
npm run rename:v3:status -- --job="$JOB"

# 6. Dry-run first 30
npm run rename:v3:apply -- --job="$JOB" --dry-run --limit=30

# 7. Inspect last 30 dry-run entries
tail -n 30 logs/product-renaming-v3/jobs/$JOB/apply-log.ndjson

# 8. Apply first 20 real mutations
npm run rename:v3:apply -- --job="$JOB" --apply --limit=20

# 9. Resume in batches of 100
npm run rename:v3:apply -- --job="$JOB" --apply --resume --limit=100

# 10. Final status
npm run rename:v3:status -- --job="$JOB"
```

---

## Completed Category Summary

| Tag | Category key | Job ID | Exported | Applied clean | Failed | Manual conflicts | Notes |
|---|---|---:|---:|---:|---:|---:|---|
| Градински сетове | garden | 2026-05-14T09-32-23-869Z-garden | 87 | 42 | 0 | 0 | 12 needs_review, 13 skipped_no_model, 20 skipped_already_renamed |
| Трапезни столове | chairs | 2026-05-14T10-13-36-226Z-chairs | 454 | 350 | 0 | 0 | 81 needs_review, 23 skipped_no_model |
| Легла | bedrooms | 2026-05-14T11-44-12-531Z-bedrooms | 309 | 243 | 0 | 0 | 42 needs_review, 23 skipped_no_model, 1 skipped_already_renamed |
| Холни маси | tables | 2026-05-14T12-33-24-441Z-tables | 471 | 403 | 0 | 0 | 44 needs_review, 24 skipped_no_model |
| Мебели за телевизор | tv_units | 2026-05-14T13-15-44-402Z-tvunits | 177 | 165 | 0 | 0 | 10 needs_review, 2 skipped_no_model |
| Гардероби за дрехи | wardrobes | 2026-05-14T13-46-16-963Z-wardrobes | 344 | 186 | 0 | 0 | 136 needs_review, 22 skipped_no_model |

**Total applied clean:** 1389 products
**Overall failed:** 0
**Overall manual_change_detected:** 0

---

## Dictionary Notes

| Category | Dictionary size | Notes |
|---|---:|---|
| `garden` | 18 | Done with smaller dictionary; OK. |
| `chairs` | 210 | Expanded to 210 Italian/Mediterranean names; applied with fallback names = 0. |
| `bedrooms` | 122 | Expanded to 122 celestial/gemstone/botanical names; applied with fallback names = 0. |
| `dining_sets` | 165 | Dictionary exists but was not applied in the final totals yet. |
| `tables` | 328 | Expanded and reordered; allocation-state deleted and re-planned before apply; applied cleanly with fallback names = 0. Weak names (Нова, Сити, material-only) moved to end. |
| `tv_units` | 216 | Added with tech/interior/premium names; applied cleanly. |
| `wardrobes` | 228 | Added with calm bedroom/interior names; many duplicates demoted by validation; applied cleanly (186 eligible). |
| `generic` | 16 | Fallback for uncategorized products. |

Next categories are not known yet. User chooses them ongoing by Shopify tag.

---

## Important Behavior Observed

- **Plan counts ≠ Validation counts:** Validation demotes duplicate new titles, so `ready` in validation can be lower than `ready` in plan.
- **"Plan counts ready" is not the final apply count.** The real number is "Validation Ready" / apply Eligible.
- **`skipped_already_renamed`** protects products already renamed in previous overlapping tag jobs. This is expected when tags overlap.
- **For overlapping categories,** use a new category key when needed, but the tag is the real Shopify selector.
- **If dictionary order is changed after planning,** delete `allocation-state.json`, re-plan, re-validate, then dry-run again. The allocation-state caches which dictionary index each old model maps to.

---

## How to Continue

1. Ask user for the next Shopify tag (e.g., `tag:Дивани`, `tag:Бюра`, etc.).
2. Decide or create a category key (e.g., `sofas`, `desks`) and check if `V3_DICTIONARIES[category]` exists.
3. If the dictionary is too small, expand it in `scripts/product-renaming-v3/lib/dictionaries.js` with 150–300 unique names. Match the furniture style (no cringe/personal names, material-only names at end).
4. Add any generic/everyday words to `V3_COMMON_NAME_EXCLUSIONS` if they could trigger Protection B false positives.
5. Run `create → export → plan → validate → status`.
6. Review:
   - Dictionary capacity: `unique old models` vs `dictionary size` — should have enough good names.
   - `needs_review` count — high means many products with ambiguous model detection.
   - `duplicate new titles` — if > 0, check what's colliding.
   - `fallback names used` — must be 0 before apply.
7. Dry-run 20–30 products and inspect the last lines of `apply-log.ndjson` for title quality.
8. Apply small batch (10–20), check status, then resume in batches of 100 if clean.

---

## Do Not

- **Do not run apply before dry-run.** Always inspect the first 20–30 allocations first.
- **Do not use `--confirm-full-job`** unless explicitly decided by the user.
- **Do not re-plan an already partially applied job** unless you know exactly why (e.g., dictionary reorder). Re-planning resets allocation state and can re-assign different names to already-applied products.
- **Do not delete `rollback.json`.** It is the only way to revert real mutations.
- **Do not treat `needs_review` as lost products.** They remain untouched in Shopify and can be reviewed/renamed manually later.
- **Do not change V1/V2 scripts.** All work is in `scripts/product-renaming-v3/`.
- **Do not change `apply-job.js` or other V3 logic** unless explicitly requested. Only `lib/dictionaries.js` is meant to be edited for new categories.
