#!/usr/bin/env bash
#
# Pipeline: Export missing Megapap products → translate → clean Shopify CSV.
#
# Usage:
#   ./scripts/run_megapap_pipeline.sh                           # full export
#   ./scripts/run_megapap_pipeline.sh --limit 20                # first 20 products
#   ./scripts/run_megapap_pipeline.sh --skip 20 --limit 20      # next 20
#   ./scripts/run_megapap_pipeline.sh --category="Office"       # filter by category
#
# Safe: read-only export, no Shopify writes, no inventory mutations.

set -euo pipefail

XML="${XML_FILE:-megapap_en.xml}"
OUT_BASE="${OUT_BASE:-missing-megapap-products}"
CATEGORY="${CATEGORY:-}"
CATEGORY_MAP="${CATEGORY_MAP:-config/megapap-category-map.json}"
SKIP="${SKIP:-0}"
LIMIT="${LIMIT:-}"
MODEL="${MODEL:-openai/gpt-4.1-mini}"
FALLBACK_MODEL="${FALLBACK_MODEL:-openai/gpt-4o-mini}"
CONCURRENCY="${CONCURRENCY:-1}"

# Parse CLI overrides
while [[ $# -gt 0 ]]; do
  case "$1" in
    --xml=*) XML="${1#--xml=}" ;;
    --out-base=*) OUT_BASE="${1#--out-base=}" ;;
    --category=*) CATEGORY="${1#--category=}" ;;
    --category-map=*) CATEGORY_MAP="${1#--category-map=}" ;;
    --skip=*) SKIP="${1#--skip=}" ;;
    --limit=*) LIMIT="${1#--limit=}" ;;
    --model=*) MODEL="${1#--model=}" ;;
    --fallback-model=*) FALLBACK_MODEL="${1#--fallback-model=}" ;;
    --concurrency=*) CONCURRENCY="${1#--concurrency=}" ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

echo "=========================================="
echo "  Megapap Import Pipeline"
echo "=========================================="
echo "  XML:        $XML"
echo "  Out base:   $OUT_BASE"
if [[ -n "$CATEGORY" ]]; then
  echo "  Category:   $CATEGORY"
fi
echo "  Skip:       $SKIP"
echo "  Limit:      ${LIMIT:-all}"
echo "  Model:      $MODEL"
echo "  Fallback:   $FALLBACK_MODEL"
echo "=========================================="
echo

# Step A: Export missing products
echo ">>> Step A: Exporting missing Megapap products..."
CMD_A="node scripts/export_missing_megapap_products.js --xml=$XML --out-base=$OUT_BASE --skip=$SKIP"
if [[ -n "$CATEGORY" ]]; then
  CMD_A="$CMD_A --category=\"$CATEGORY\""
fi
if [[ -n "$LIMIT" ]]; then
  CMD_A="$CMD_A --limit=$LIMIT"
fi
echo "  $CMD_A"
eval "$CMD_A"

MISSING_CSV="${OUT_BASE}.csv"
if [[ ! -f "$MISSING_CSV" ]]; then
  echo "ERROR: $MISSING_CSV not found after export."
  exit 1
fi
echo

# Step B: Translate
echo ">>> Step B: Translating..."
CMD_B="python3 translate_megapap_missing.py --input=$MISSING_CSV --model=$MODEL --fallback-model=$FALLBACK_MODEL --max-concurrency=$CONCURRENCY --out-base=$OUT_BASE-translated"
if [[ -n "$LIMIT" ]]; then
  CMD_B="$CMD_B --limit-products=$LIMIT"
fi
echo "  $CMD_B"
eval "$CMD_B"
echo

# Step C: Clean Shopify CSV
echo ">>> Step C: Cleaning Shopify CSV..."
SHOPIFY_CSV="${OUT_BASE}-translated-shopify-import.csv"
if [[ ! -f "$SHOPIFY_CSV" ]]; then
  echo "ERROR: $SHOPIFY_CSV not found after translation."
  exit 1
fi
CMD_C="python3 scripts/clean_megapap_import.py --input=$SHOPIFY_CSV --weight-source=${OUT_BASE}-translated.json"
if [[ -n "$CATEGORY" ]]; then
  CMD_C="$CMD_C --category=\"$CATEGORY\" --category-map=$CATEGORY_MAP"
fi
echo "  $CMD_C"
eval "$CMD_C"
echo

echo "=========================================="
echo "  Pipeline complete."
echo "  Final output: ${OUT_BASE}-translated-shopify-import-clean.csv"
echo "=========================================="
