#!/usr/bin/env python3
"""
Merge multiple Shopify-import CSVs into one, deduping by Handle.

Shopify-import CSVs use a multi-row-per-product layout: the first row for a
Handle carries the full product + variant data, and any extra rows for the same
Handle carry only image columns. This script preserves that structure — a
product is kept or dropped as a whole group of rows.

Dedupe rule: if the same Handle appears in more than one input file, the rows
from the file listed EARLIER in --inputs win (so you can pass a canonical file
first). The collision is logged.

I/O: inputs are read as UTF-8 with BOM tolerance (utf-8-sig handles files with
or without a BOM). Output is written as UTF-8 with a BOM, which Shopify's
product importer accepts.

Usage:
  python3 scripts/merge_shopify_import_csvs.py \
      --inputs filtered_products.csv targeted-25-shopify-import-clean.csv \
      --output final_205_shopify_import.csv
"""

import argparse
import csv
import sys
from collections import OrderedDict


def read_csv(path):
    """Read a Shopify-import CSV. Returns (fieldnames, rows)."""
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames or []
    return fieldnames, rows


def group_by_handle(rows):
    """Group consecutive Shopify rows by Handle, preserving order and multi-row structure."""
    groups = OrderedDict()
    for row in rows:
        handle = (row.get("Handle") or "").strip()
        groups.setdefault(handle, []).append(row)
    return groups


def main():
    parser = argparse.ArgumentParser(description="Merge Shopify-import CSVs, deduping by Handle.")
    parser.add_argument(
        "--inputs",
        nargs="+",
        required=True,
        help="Input CSV files in priority order (earlier files win on Handle collision).",
    )
    parser.add_argument("--output", required=True, help="Output CSV path.")
    args = parser.parse_args()

    # Build the union of columns, preserving first-seen order across all inputs.
    union_fields = []
    seen_fields = set()

    per_file = []  # list of (path, fieldnames, groups)
    for path in args.inputs:
        try:
            fieldnames, rows = read_csv(path)
        except FileNotFoundError:
            print(f"ERROR: input file not found: {path}", file=sys.stderr)
            sys.exit(1)
        for fn in fieldnames:
            if fn not in seen_fields:
                seen_fields.add(fn)
                union_fields.append(fn)
        per_file.append((path, fieldnames, group_by_handle(rows)))

    if "Handle" not in union_fields:
        print("ERROR: no 'Handle' column found in any input; not a Shopify-import CSV.", file=sys.stderr)
        sys.exit(1)

    # Claim each Handle to the earliest file that contains it.
    owner = {}  # handle -> file index
    collisions = OrderedDict()  # handle -> [file paths that also had it]
    for idx, (path, _fields, groups) in enumerate(per_file):
        for handle in groups:
            if not handle:
                continue  # skip blank-handle rows (shouldn't happen in valid exports)
            if handle in owner:
                collisions.setdefault(handle, []).append(path)
            else:
                owner[handle] = idx

    # Emit rows in file order, then row order, keeping only handles owned by that file.
    out_rows = []
    per_file_stats = []
    for idx, (path, _fields, groups) in enumerate(per_file):
        kept_products = 0
        kept_rows = 0
        file_products = 0
        file_rows = 0
        for handle, group in groups.items():
            file_products += 1
            file_rows += len(group)
            if handle and owner.get(handle) == idx:
                out_rows.extend(group)
                kept_products += 1
                kept_rows += len(group)
        per_file_stats.append(
            {
                "path": path,
                "file_products": file_products,
                "file_rows": file_rows,
                "kept_products": kept_products,
                "kept_rows": kept_rows,
            }
        )

    # Write output as UTF-8 with BOM. Fill missing columns with "".
    with open(args.output, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=union_fields, extrasaction="ignore")
        writer.writeheader()
        for row in out_rows:
            writer.writerow({fn: row.get(fn, "") for fn in union_fields})

    out_handles = {(r.get("Handle") or "").strip() for r in out_rows if (r.get("Handle") or "").strip()}

    # Summary
    print("=" * 60)
    print("  Shopify-import CSV merge")
    print("=" * 60)
    for s in per_file_stats:
        print(
            f"  {s['path']}"
            f"\n      products: {s['file_products']:>5}  rows: {s['file_rows']:>5}"
            f"   →  kept products: {s['kept_products']:>5}  kept rows: {s['kept_rows']:>5}"
        )
    print("-" * 60)
    print(f"  Output: {args.output}")
    print(f"  Output products (unique Handle): {len(out_handles)}")
    print(f"  Output rows:                     {len(out_rows)}")
    print(f"  Columns:                         {len(union_fields)}")
    if collisions:
        print(f"  Handle collisions (kept earliest file): {len(collisions)}")
        for handle, paths in collisions.items():
            keeper = args.inputs[owner[handle]]
            print(f"    {handle}: also in [{', '.join(paths)}] → kept from {keeper}")
    else:
        print("  Handle collisions: none")
    print("=" * 60)


if __name__ == "__main__":
    main()
