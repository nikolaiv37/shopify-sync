#!/usr/bin/env bash
#
# Pipeline: Export missing B2BMarkt kids room products → translate → clean Shopify CSV.
#
# Usage:
#   ./scripts/run_kids_room_pipeline.sh              # full export
#   ./scripts/run_kids_room_pipeline.sh --limit 20   # first 20 products
#   ./scripts/run_kids_room_pipeline.sh --skip 20 --limit 20  # next 20
#
# Safe: read-only export, no Shopify writes, no inventory mutations.

set -euo pipefail

XML="${XML_FILE:-b2bmarkt_updated.xml}"
CATEGORY="${CATEGORY:-Παιδικό δωμάτιο}"
OUT_BASE="${OUT_BASE:-missing-products-kids-room}"
SKIP="${SKIP:-0}"
LIMIT="${LIMIT:-}"
MODEL="${MODEL:-openai/gpt-4.1-mini}"
FALLBACK_MODEL="${FALLBACK_MODEL:-openai/gpt-4o-mini}"
CONCURRENCY="${CONCURRENCY:-1}"

# Parse CLI overrides
while [[ $# -gt 0 ]]; do
  case "$1" in
    --xml=*) XML="${1#--xml=}" ;;
    --category=*) CATEGORY="${1#--category=}" ;;
    --out-base=*) OUT_BASE="${1#--out-base=}" ;;
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
echo "  Kids Room Import Pipeline"
echo "=========================================="
echo "  XML:        $XML"
echo "  Category:   $CATEGORY"
echo "  Out base:   $OUT_BASE"
echo "  Skip:       $SKIP"
echo "  Limit:      ${LIMIT:-all}"
echo "  Model:      $MODEL"
echo "  Fallback:   $FALLBACK_MODEL"
echo "=========================================="
echo

# Step A: Export missing products
echo ">>> Step A: Exporting missing products..."
CMD_A="node export-missing-products.js --xml=$XML --category=\"$CATEGORY\" --out-base=$OUT_BASE --skip=$SKIP"
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
CMD_B="python3 translate_b2bmarkt_missing.py --input=$MISSING_CSV --model=$MODEL --fallback-model=$FALLBACK_MODEL --max-concurrency=$CONCURRENCY"
echo "  $CMD_B"
eval "$CMD_B"
echo

# Step C: Clean Shopify CSV
echo ">>> Step C: Cleaning Shopify CSV..."
CMD_C="python3 scripts/clean_kids_room_import.py"
echo "  $CMD_C"
eval "$CMD_C"
echo

echo "=========================================="
echo "  Pipeline complete."
echo "  Final output: shopify-kids-room-import-clean.csv"
echo "=========================================="
