# Product Renaming Workflow

Simple, safe workflow for renaming Shopify products category by category.

## Quick Start

```bash
# 1. Export category products
npm run rename:export -- --query="tag:Градински сетове" --limit=50

# 2. Generate rename plan
npm run rename:plan -- --input=logs/product-renaming/current/export.json --category=garden --limit=50

# 3. Validate plan quality
npm run rename:validate -- --plan=logs/product-renaming/current/plan.json

# 4. Open human-readable preview
open logs/product-renaming/current/preview.csv

# 5. Dry-run (safe, no mutations)
npm run rename:apply -- --plan=logs/product-renaming/current/plan.json --dry-run --risk=low --limit=10

# 6. First real apply (low risk only, 5 products)
npm run rename:apply -- --plan=logs/product-renaming/current/plan.json --apply --risk=low --limit=5

# 7. Dry-run including medium risk
npm run rename:apply -- --plan=logs/product-renaming/current/plan.json --dry-run --risk=low --include-medium --limit=10

# Check current status
npm run rename:status
```

## Safety Rules

- **Default is dry-run** — no Shopify mutations without `--apply`
- **High-risk products are NEVER applied** — script refuses if high-risk selected
- **Real apply requires `--apply` AND `--limit`** — prevents accidental bulk changes
- **Handles/URLs never change** — only title, SEO title, SEO description, and descriptionHtml
- **`--limit` applies to both dry-run and real apply** — always limits selected count

## Current Files

All latest results are in `logs/product-renaming/current/`:

| File | Description |
|------|-------------|
| `export.json` | Latest Shopify product export |
| `plan.json` | Latest rename plan |
| `preview.csv` | Latest human preview (open in spreadsheet) |
| `validation.json` | Latest validation result |
| `dry-run.json` | Latest dry-run apply result |
| `apply.json` | Latest real apply result |
| `rollback.json` | Latest rollback snapshot |

Timestamped archives are kept in `logs/product-renaming/` (parent folder).

## Risk Levels

| Level | Meaning | Apply? |
|-------|---------|--------|
| `low` | Clean rename, no broken fragments, model removed | Yes (default) |
| `medium` | Truncated fragment removed, no model detected, shorter title | With `--include-medium` |
| `high` | Broken fragment remains, old model still present, title too short | **NEVER** |

## Fields Mutated

| Field | Condition |
|-------|-----------|
| `title` | Always (from plan) |
| `seo.title` | If `newSeoTitle` exists |
| `seo.description` | If `newSeoDescription` exists |
| `descriptionHtml` | Only if `descriptionReplacement` exists (case-insensitive model→collection replace) |

**NEVER mutates:** handle, SKU, vendor, productType, tags, variants, price, inventory, images, status, collections.

## Adding a New Category

1. Add dictionary names to `DICTIONARIES` in `name-dictionaries.js`
2. Add category keywords to `CATEGORY_KEYWORDS`
3. Add title prefixes to `CATEGORY_TITLE_PREFIXES`
4. Run export with appropriate `--query` filter
5. Generate plan with `--category=yourcategory`
