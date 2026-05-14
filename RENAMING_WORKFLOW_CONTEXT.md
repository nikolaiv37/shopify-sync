# Shopify Product Renaming Workflow — Context Package

## Overview
Standardized workflow for renaming Shopify product titles, SEO titles, SEO descriptions, and description HTML. Conservative replacement strategy: detect old model/series name, replace with controlled Bulgarian collection name, preserve rest of title.

**Repo:** `mebelcenter-shopify`
**Scripts:** `scripts/product-renaming/`
**Logs:** `logs/product-renaming/current/`

---

## Workflow

```
1. Export  →  npm run rename:export -- --query="tag:Градински сетове" --limit=50
2. Plan    →  npm run rename:plan -- --category=garden --limit=50
3. Validate→  npm run rename:validate -- --plan=logs/product-renaming/current/plan.json
4. Dry-run →  npm run rename:apply -- --plan=logs/product-renaming/current/plan.json --dry-run --risk=low --limit=20
5. Apply   →  npm run rename:apply -- --plan=logs/product-renaming/current/plan.json --apply --risk=low --limit=10
```

### Guard Rails (prevents stale/wrong plan application)
- `generate-rename-plan.js` defaults to `current/export.json`. Archived exports require `--allow-archive-input`.
- `apply-rename-plan.js` verifies before ANY processing (both dry-run and apply):
  1. `current/export.json` must exist
  2. Plan's `input` must equal `logs/product-renaming/current/export.json`
  3. Plan's `exportSource.exportTimestamp`, `exportFilters`, `totalExported` must match current export
- Mismatch → hard exit with clear error. No interactive prompts.

---

## What Gets Mutated
- `title` — product title
- `seo.title` — SEO title
- `seo.description` — SEO description
- `descriptionHtml` — case-insensitive model name replacement (only if `descriptionReplacement` exists, max 20 occurrences)

## What MUST NEVER Be Mutated
- `handle`, `SKU`, `vendor`, `productType`, `tags`, `variants`, `price`, `inventory`, `images`, `status`, `collections`

---

## Risk Logic
Assessed in `generate-rename-plan.js` → `assessRisk()`:

| Risk | Criteria |
|------|----------|
| **high** | No new title, title < 30 chars, old model still in new title, truncated fragment remains, no model detected + no title |
| **medium** | Title > 120 chars, old model in SEO title/description, truncated fragment removed (not repaired), title significantly shorter, piece count lost, no model detected |
| **low** | None of the above |
| **skip** | No model detected AND no new title generated |

**Apply rules:** High-risk items are NEVER applied. `--apply` requires `--limit`. `--dry-run` never mutates.

---

## Current Known Issues

### 1. Already-Renamed Products
Products previously renamed (e.g., mc-0612615 "Аурора") still appear in export and get re-processed. The `buildRenamedTitle()` function strips the collection name prefix but sometimes produces garbage output like `"Градински лаундж сет Аурора – Градински лаундж сет–4 части..."` → **high risk**.

**Fix needed:** Skip products whose title already matches a dictionary name pattern, or detect already-renamed titles and mark them as `skip` in plan generation.

### 2. No-Model Products
Products without detectable model names get rebuilt from scratch, producing titles like `"Градински комплект Аурора – бебешки стол от полипропилен..."` — these are medium risk because the entire title is reconstructed.

### 3. Truncated Titles
Some Shopify export titles are truncated (e.g., "алуминий-ус", "крем/б"). The `repairTruncatedFragments()` function attempts fixes using description HTML, but some remain broken.

### 4. SEO Title Duplication
`\b` doesn't work for Cyrillic word boundaries. Fixed with `(?![\wА-Яа-яЁё])` lookahead in `deduplicateRepeatedWords()`.

### 5. Dining Title Redundancy
Fixed: Added regex to strip `"Сет трапезария за външно пространство"` from title body.

---

## Current Plan Status

```
Plan timestamp:     2026-05-13T10:59:14.123Z
Export timestamp:   2026-05-13T10:50:59.270Z
Export query:       tag:Градински сетове
Export limit:       50
Total products:     50
Risk distribution:  Low: 28, Medium: 19, High: 3, Skip: 0
Plan matches export: YES
```

### Sample Plan Entries
| Handle | Old Title (truncated) | New Title (truncated) | Risk |
|--------|----------------------|----------------------|------|
| mc-0612615 | Градински лаундж сет Аурора – 4 части, тъмносив... | Градински лаундж сет Аурора – Градински лаундж сет–4 части... | **high** |
| mc-0612616 | Сет за външен кът 4 части ENASTRON бежов алуминий... | Градински лаундж сет Ривиера – 4 части, бежов алуминий... | medium |
| mc-0612590 | Сет за външен кът 4 части серия ELYSIA тъмно сиво... | Градински лаундж сет Коста – 4 части, тъмносив алуминий... | medium |

---

## Previously Applied Products
10 products were already renamed in a prior apply batch (mc-0612720, mc-0612721, mc-9996834, mc-0612890, mc-0612891, mc-9996930, mc-9996931, mc-9996932, mc-9996933, mc-9996934). The apply script fetches current Shopify state and skips already-applied (`current === new`) and manually-changed (`current !== old && current !== new`) products.

---

## File Structure

```
scripts/product-renaming/
├── export-products-for-rename.js   # Fetches products from Shopify GraphQL
├── generate-rename-plan.js         # Generates rename plan with risk assessment
├── validate-rename-plan.js         # Validates plan quality, checks duplicates/issues
├── apply-rename-plan.js            # Dry-run or apply mutations with guard verification
├── show-current-status.js          # Shows workflow status and plan/export match
└── name-dictionaries.js            # Dictionaries, title builders, text normalization

logs/product-renaming/current/
├── export.json                     # Latest Shopify export
├── plan.json                       # Latest rename plan
├── preview.csv                     # Human-readable preview
├── validation.json                 # Latest validation result
├── dry-run.json                    # Latest dry-run log
├── apply.json                      # Latest apply log
└── rollback.json                   # Rollback snapshot for last apply
```

---

## Package.json Scripts

```json
"rename:export":  "node scripts/product-renaming/export-products-for-rename.js",
"rename:plan":    "node scripts/product-renaming/generate-rename-plan.js",
"rename:validate":"node scripts/product-renaming/validate-rename-plan.js",
"rename:apply":   "node scripts/product-renaming/apply-rename-plan.js",
"rename:status":  "node scripts/product-renaming/show-current-status.js"
```

---

## Next Steps for Development
1. **Fix already-renamed detection** in `generate-rename-plan.js` — skip products whose title already starts with a dictionary prefix pattern
2. **Investigate high-risk items** — 3 products are high risk due to already-renamed titles producing garbage output
3. **Consider medium-risk apply** — 19 medium-risk items may be safe after review
4. **Expand export scope** — current export is limited to 50 products with `tag:Градински сетове`
