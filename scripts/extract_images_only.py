#!/usr/bin/env python3
"""
Extract images-only CSV from a B2BMarkt/Symetron Shopify import CSV.

For Admin API updates: keeps original "/.jpg" URLs as position 1 (Admin API
accepts them even though Shopify CSV import rejects them).

For CSV import: use --for-csv-import to replace "/.jpg" with "-1.jpg".

Output contains ONLY: Handle, Image Src, Image Position, Image Alt Text

Usage:
    python3 scripts/extract_images_only.py --input=symetron-all-missing-shopify-import.csv
    python3 scripts/extract_images_only.py --input=symetron-all-missing-shopify-import.csv --for-csv-import
"""

import argparse
import csv
import re
import sys
from collections import OrderedDict

INVALID_IMAGE_URL_RE = re.compile(r"/\.[a-zA-Z]+(?:\?.*)?$")


def parse_args():
    parser = argparse.ArgumentParser(description="Extract images-only CSV for Shopify overwrite")
    parser.add_argument("--input", required=True, help="Input Shopify CSV (raw or cleaned)")
    parser.add_argument("--output", default=None, help="Output CSV path (default: <input-base>-images-only.csv)")
    parser.add_argument("--for-csv-import", action="store_true", help="Replace /.jpg with -1.jpg (for CSV import mode)")
    return parser.parse_args()


def derive_output_path(input_path, for_csv_import):
    base = input_path
    if base.endswith(".csv"):
        base = base[:-4]
    suffix = "-images-only" if not for_csv_import else "-images-csv-import"
    return f"{base}{suffix}.csv"


def main():
    args = parse_args()
    input_path = args.input
    output_path = args.output or derive_output_path(input_path, args.for_csv_import)

    try:
        with open(input_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
    except FileNotFoundError:
        print(f"ERROR: {input_path} not found.", file=sys.stderr)
        sys.exit(1)

    # Collect images per handle, preserving order
    handle_images = OrderedDict()
    for r in rows:
        h = r.get("Handle", "").strip()
        src = r.get("Image Src", "").strip()
        alt = r.get("Image Alt Text", "").strip()
        if not h or not src:
            continue
        handle_images.setdefault(h, [])
        handle_images[h].append({"src": src, "alt": alt})

    # Process: deduplicate, renumber positions
    # For Admin API: keep /.jpg as-is (position 1)
    # For CSV import: replace /.jpg with -1.jpg
    invalid_remaining = []
    duplicates_removed = 0
    replaced_count = 0
    output_rows = []

    for h, imgs in handle_images.items():
        seen_urls = set()
        position = 0
        for img in imgs:
            src = img["src"]

            if args.for_csv_import and INVALID_IMAGE_URL_RE.search(src):
                # Replace /.jpg with -1.jpg for CSV import
                fixed = INVALID_IMAGE_URL_RE.sub("/-1.jpg", src)
                if fixed in seen_urls:
                    duplicates_removed += 1
                    continue
                src = fixed
                replaced_count += 1

            # Skip duplicates
            if src in seen_urls:
                duplicates_removed += 1
                continue
            seen_urls.add(src)
            position += 1
            output_rows.append({
                "Handle": h,
                "Image Src": src,
                "Image Position": str(position),
                "Image Alt Text": img["alt"],
            })

    # Write output
    fieldnames = ["Handle", "Image Src", "Image Position", "Image Alt Text"]
    with open(output_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    # QA
    unique_handles = set(r["Handle"] for r in output_rows)
    total_image_rows = len(output_rows)
    handle_img_counts = {}
    for r in output_rows:
        handle_img_counts[r["Handle"]] = handle_img_counts.get(r["Handle"], 0) + 1
    zero_image_handles = [h for h in handle_images if h not in handle_img_counts]
    max_images = max(handle_img_counts.values()) if handle_img_counts else 0

    # Check for /.jpg in output
    dotjpg_count = sum(1 for r in output_rows if INVALID_IMAGE_URL_RE.search(r["Image Src"]))

    print("=" * 60)
    print(f"  IMAGES-ONLY CSV: {output_path}")
    print("=" * 60)
    print()
    print(f"  Unique handles:        {len(unique_handles)}")
    print(f"  Total image rows:      {total_image_rows}")
    print(f"  Products with 0 images:{len(zero_image_handles)}")
    if zero_image_handles:
        for h in sorted(zero_image_handles)[:10]:
            print(f"    {h}")
    print(f"  Max images per product:{max_images}")
    print(f"  Duplicates removed:    {duplicates_removed}")
    if args.for_csv_import:
        print(f"  /.jpg replaced:        {replaced_count}")
    else:
        print(f"  /.jpg URLs kept:       {dotjpg_count}")
    print()

    print("-" * 60)
    if len(unique_handles) > 0:
        print("  RESULT: CLEAN — safe for Shopify Admin API image update")
    else:
        print("  RESULT: review before import")
    print("-" * 60)
    print()
    print(f"  Output: {output_path}")


if __name__ == "__main__":
    main()
