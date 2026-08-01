#!/usr/bin/env python3
"""
Rewrite the Vendor column in a Shopify-import CSV.

Only rows whose current Vendor equals --from are changed; blank-Vendor rows
(the image-only rows in Shopify's multi-row-per-product layout) are left
untouched. Writes UTF-8 with BOM so Shopify's importer accepts the file.

Usage:
  python3 scripts/set_vendor.py --input=final_205_shopify_import.csv \
                                --output=final_205_shopify_import.vendor-lina.csv
  python3 scripts/set_vendor.py -i in.csv -o out.csv --from="Europe" --to="Lina Trade Garden"
  python3 scripts/set_vendor.py -i in.csv --in-place    # overwrite input
"""

import argparse
import csv
import os
import sys
import tempfile


def main():
    parser = argparse.ArgumentParser(description="Rewrite the Vendor column of a Shopify-import CSV.")
    parser.add_argument("-i", "--input", required=True, help="Input Shopify-import CSV.")
    parser.add_argument("-o", "--output", default=None, help="Output CSV (default: alongside input with .vendor-<slug>.csv).")
    parser.add_argument("--from", dest="from_vendor", default="Europe", help='Vendor value to match (default: "Europe").')
    parser.add_argument("--to", dest="to_vendor", default="Lina Trade Garden", help='New vendor value (default: "Lina Trade Garden").')
    parser.add_argument("--in-place", action="store_true", help="Overwrite input file atomically.")
    args = parser.parse_args()

    if args.in_place and args.output:
        print("ERROR: pick either --output or --in-place, not both.", file=sys.stderr)
        sys.exit(1)

    with open(args.input, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        rows = list(reader)

    if "Vendor" not in fieldnames:
        print("ERROR: input CSV has no 'Vendor' column — is this a Shopify-import CSV?", file=sys.stderr)
        sys.exit(1)

    changed = 0
    skipped_blank = 0
    other_vendor = {}
    for row in rows:
        v = (row.get("Vendor") or "").strip()
        if not v:
            skipped_blank += 1
            continue
        if v == args.from_vendor:
            row["Vendor"] = args.to_vendor
            changed += 1
        else:
            other_vendor[v] = other_vendor.get(v, 0) + 1

    if args.in_place:
        out_path = args.input
    elif args.output:
        out_path = args.output
    else:
        base, ext = os.path.splitext(args.input)
        slug = args.to_vendor.lower().replace(" ", "-")
        out_path = f"{base}.vendor-{slug}{ext or '.csv'}"

    # Write atomically so an interrupted run can't corrupt the file.
    dir_ = os.path.dirname(os.path.abspath(out_path)) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".set_vendor.", suffix=".csv", dir=dir_)
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        os.replace(tmp_path, out_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    print("=" * 60)
    print(f"  Input:            {args.input}")
    print(f"  Output:           {out_path}")
    print(f"  From → To:        {args.from_vendor!r} → {args.to_vendor!r}")
    print(f"  Rows changed:     {changed}")
    print(f"  Blank-Vendor rows (image rows) left alone: {skipped_blank}")
    if other_vendor:
        print("  Rows with a different Vendor (left as-is):")
        for v, n in sorted(other_vendor.items(), key=lambda kv: -kv[1]):
            print(f"    {n:>5}  {v!r}")
    print("=" * 60)


if __name__ == "__main__":
    main()
