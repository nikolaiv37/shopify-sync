#!/usr/bin/env bash
#
# Pipeline: Filter vendor feeds to a hand-picked code list → translate → clean Shopify CSV.
#
# Unlike run_b2bmarkt_pipeline.sh this does NOT diff against Shopify. It pulls
# exactly the ProductCodes in --codes-file from the vendor feeds (main + symetron
# by default), then runs the same translate + clean stages.
#
# Usage:
#   ./scripts/run_targeted_codes_pipeline.sh                                  # data/targeted-codes.txt, both feeds
#   ./scripts/run_targeted_codes_pipeline.sh --codes-file=data/my-codes.txt
#   ./scripts/run_targeted_codes_pipeline.sh --out-base=targeted-batch-2
#   ./scripts/run_targeted_codes_pipeline.sh --feeds=main                     # main feed only
#   ./scripts/run_targeted_codes_pipeline.sh --limit 3                        # first 3 matched (smoke test)
#
# URL-only: fails loudly if a requested feed's URL env var is unset (no local fallback).
# Safe: read-only feed fetch, no Shopify writes, no inventory mutations.

set -euo pipefail

CODES_FILE="${CODES_FILE:-data/targeted-codes.txt}"
OUT_BASE="${OUT_BASE:-targeted-25}"
FEEDS="${FEEDS:-main,symetron}"
CATEGORY_MAP="${CATEGORY_MAP:-config/b2bmarkt-category-map.json}"
LIMIT="${LIMIT:-}"
MODEL="${MODEL:-openai/gpt-4.1-mini}"
FALLBACK_MODEL="${FALLBACK_MODEL:-openai/gpt-4o-mini}"
CONCURRENCY="${CONCURRENCY:-1}"

# Parse CLI overrides
while [[ $# -gt 0 ]]; do
  case "$1" in
    --codes-file=*) CODES_FILE="${1#--codes-file=}" ;;
    --out-base=*) OUT_BASE="${1#--out-base=}" ;;
    --feeds=*) FEEDS="${1#--feeds=}" ;;
    --category-map=*) CATEGORY_MAP="${1#--category-map=}" ;;
    --limit=*) LIMIT="${1#--limit=}" ;;
    --limit) shift; LIMIT="${1:-}" ;;
    --model=*) MODEL="${1#--model=}" ;;
    --fallback-model=*) FALLBACK_MODEL="${1#--fallback-model=}" ;;
    --concurrency=*) CONCURRENCY="${1#--concurrency=}" ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

# Log directory (mirror how the sub-scripts log)
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG_DIR="logs/targeted-codes/${STAMP}"
mkdir -p "$LOG_DIR"
PIPELINE_LOG="${LOG_DIR}/pipeline.log"

# Tee all output to the pipeline log
exec > >(tee -a "$PIPELINE_LOG") 2>&1

echo "=========================================="
echo "  Targeted Codes Import Pipeline"
echo "=========================================="
echo "  Codes file: $CODES_FILE"
echo "  Feeds:      $FEEDS"
echo "  Out base:   $OUT_BASE"
echo "  Limit:      ${LIMIT:-all}"
echo "  Model:      $MODEL"
echo "  Fallback:   $FALLBACK_MODEL"
echo "  Log:        $PIPELINE_LOG"
echo "=========================================="
echo

# Step A: Filter feeds by codes (URL-only, no Shopify diff)
echo ">>> Step A: Filtering feeds by codes..."
CMD_A="node scripts/filter_feeds_by_codes.js --codes-file=$CODES_FILE --out-base=$OUT_BASE --feeds=$FEEDS"
if [[ -n "$LIMIT" ]]; then
  CMD_A="$CMD_A --limit=$LIMIT"
fi
echo "  $CMD_A"
eval "$CMD_A"

MISSING_CSV="${OUT_BASE}.csv"
if [[ ! -f "$MISSING_CSV" ]]; then
  echo "ERROR: $MISSING_CSV not found after filter step."
  exit 1
fi
echo

# Step B: Translate (targeted codes span many categories → all-categories mode)
echo ">>> Step B: Translating..."
CMD_B="python3 translate_b2bmarkt_missing.py --input=$MISSING_CSV --model=$MODEL --fallback-model=$FALLBACK_MODEL --max-concurrency=$CONCURRENCY --out-base=$OUT_BASE --all-categories"
if [[ -n "$LIMIT" ]]; then
  CMD_B="$CMD_B --limit-products=$LIMIT"
fi
echo "  $CMD_B"
eval "$CMD_B"
echo

# Step C: Clean Shopify CSV (all-categories → cleaner maps per-product category)
echo ">>> Step C: Cleaning Shopify CSV..."
SHOPIFY_CSV="${OUT_BASE}-shopify-import.csv"
if [[ ! -f "$SHOPIFY_CSV" ]]; then
  echo "ERROR: $SHOPIFY_CSV not found after translation."
  exit 1
fi
CMD_C="python3 scripts/clean_b2bmarkt_import.py --input=$SHOPIFY_CSV --weight-source=${OUT_BASE}.json --category-map=$CATEGORY_MAP --all-categories"
echo "  $CMD_C"
eval "$CMD_C"
echo

echo "=========================================="
echo "  Pipeline complete."
echo "  Final output: ${OUT_BASE}-shopify-import-clean.csv"
echo "  Log:          $PIPELINE_LOG"
echo "=========================================="
