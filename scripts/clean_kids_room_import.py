#!/usr/bin/env python3
"""
QA/cleanup script for shopify-kids-room-import.csv.

Reads shopify-kids-room-import.csv, applies text corrections,
writes shopify-kids-room-import-clean.csv in proper Shopify multi-image format,
and prints a QA report.

Shopify image-row format:
  - First row per Handle: full product + variant + SEO + status + Image 1
  - Rows 2+ per Handle: ONLY Handle, Image Src, Image Position, Image Alt Text

Local-only. Does not touch Shopify, inventory, or dashboard code.

Usage:
    python3 scripts/clean_kids_room_import.py
"""

import csv
import json
import re
import sys
from collections import Counter, OrderedDict

INPUT = "shopify-kids-room-import.csv"
OUTPUT = "shopify-kids-room-import-clean.csv"
WEIGHT_SOURCE = "translated-kids-room-products.json"

GREEK_RE = re.compile(r"[\u0370-\u03FF\u1F00-\u1FFF]")
HM_CODE_RE = re.compile(r"HM\d+(?:\.\d+)?")
HM_HEADING_RE = re.compile(r"\s*<p><strong>HM\d+(?:\.\d+)?</strong></p>")

REPLACEMENTS = [
    ("легно", "легло"),
    ("ЛЕГНО", "ЛЕГЛО"),
    ("Легно", "Легло"),
    ("белизаători", "белизачи"),
    ("белизаАтори", "белизачи"),
    ("natur-бяло", "натурално-бяло"),
    ("natur-Бяло", "натурално-бяло"),
    ("НАТУРАЛен", "естествен"),
    ("НАТУРАЛЕН", "ЕСТЕСТВЕН"),
    ("Натурално-Бяло", "Естествено-бяло"),
    ("НАТУРАЛ-БЯЛО", "ЕСТЕСТВЕНО-БЯЛО"),
    ("НАТУРАЛНО-БЯЛО", "ЕСТЕСТВЕНО-БЯЛО"),
    ("бор natur", "бор естествен"),
    ("145,5Y", "145,5H"),
    ("[L] Εσωτερικός χώρος", "Мебели"),
    ("[L] Κρεβάτια", "Детски легла"),
    ("[L] Παιδικά πακέτα", "Детски комплекти"),
    ("[L] Κουκέτες", "Детски двуетажни легла"),
    ("[L] Καρεκλάκια", "Детски столчета"),
    ("[L] Τραπέζια", "Детски маси"),
    ("Εσωτερικός χώρος", "Мебели"),
    ("Κρεβάτια", "Детски легла"),
    ("Παιδικά πακέτα", "Детски комплекти"),
    ("Κουκέτες", "Детски двуетажни легла"),
    ("Καρεκλάκια", "Детски столчета"),
    ("Τραπέζια", "Детски маси"),
]

TYPE_OVERRIDES = {
    "Детски легла": "Детски легла",
    "Детски комплекти": "Детски комплекти",
    "Детски двуетажни легла": "Детски двуетажни легла",
    "Детски столчета": "Детски столчета",
    "Детски маси": "Детски маси",
    "Мебели": "Мебели",
}

FIELDS_BLANK_ON_IMAGE_ROWS = {
    "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags",
    "Published", "Option1 Name", "Option1 Value",
    "Variant SKU", "Variant Inventory Tracker", "Variant Inventory Qty",
    "Variant Inventory Policy", "Variant Fulfillment Service",
    "Variant Price", "Variant Compare At Price",
    "Variant Requires Shipping", "Variant Taxable", "Variant Barcode",
    "Gift Card", "SEO Title", "SEO Description",
    "Variant Weight Unit", "Variant Weight", "Status",
}

FIELDS_CLEANED = {
    "Title", "Body (HTML)", "Type", "Tags",
    "Image Alt Text", "SEO Title", "SEO Description",
}


B2BMARKT_PRICE_MULTIPLIER = 3.10


def load_product_data(path):
    """Load weight_kg and raw wholesale_price per SKU from the translated JSON."""
    weights = {}
    wholesale_prices = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for p in data.get("products", []):
            sku = p.get("sku", "")
            if not sku:
                continue
            wg = p.get("weight_kg", "")
            if wg:
                try:
                    weights[sku] = int(float(wg) * 1000)
                except (ValueError, TypeError):
                    pass
            wp = p.get("price_wholesale", "")
            if wp:
                try:
                    wholesale_prices[sku] = float(wp)
                except (ValueError, TypeError):
                    pass
    except FileNotFoundError:
        pass
    return weights, wholesale_prices


def clean_type(value):
    """Clean Type field: apply replacements, strip [L] prefix, map to known Bulgarian types."""
    if not value:
        return value
    result = value
    for old, new in REPLACEMENTS:
        result = result.replace(old, new)
    # Strip any remaining [L] prefix
    result = re.sub(r"\[L\]\s*", "", result).strip()
    # Map to known types if it matches
    if result in TYPE_OVERRIDES:
        return TYPE_OVERRIDES[result]
    return result


def clean_text(value):
    if not value:
        return value
    result = value
    for old, new in REPLACEMENTS:
        result = result.replace(old, new)
    return result


def remove_hm_codes(value):
    """Remove HM model codes from customer-facing text."""
    if not value:
        return value
    result = HM_CODE_RE.sub("", value)
    result = re.sub(r"\s{2,}", " ", result)
    result = re.sub(r"\s*-\s*-", " -", result)
    result = re.sub(r"\s*,\s*,", ",", result)
    return result.strip()


def clean_body_html(value):
    """Remove HM heading blocks and HM codes from HTML body."""
    if not value:
        return value
    result = HM_HEADING_RE.sub("", value)
    result = remove_hm_codes(result)
    result = re.sub(r"<p>\s*</p>", "", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def has_greek(value):
    return bool(value and GREEK_RE.search(value))


def main():
    try:
        with open(INPUT, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            fieldnames = list(reader.fieldnames)
            rows = list(reader)
    except FileNotFoundError:
        print(f"ERROR: {INPUT} not found. Run translate_b2bmarkt_missing.py first.")
        sys.exit(1)

    if not fieldnames:
        print("ERROR: CSV has no header row.")
        sys.exit(1)

    # Add Variant Grams column if missing, placed after Variant Weight Unit
    if "Variant Grams" not in fieldnames:
        idx = fieldnames.index("Variant Weight Unit") + 1
        fieldnames.insert(idx, "Variant Grams")

    # Load weights and wholesale prices
    weights, wholesale_prices = load_product_data(WEIGHT_SOURCE)

    # Group rows by Handle, preserving order
    groups = OrderedDict()
    for row in rows:
        h = row.get("Handle", "")
        groups.setdefault(h, []).append(row)

    # Build cleaned output
    output_rows = []
    for handle, group in groups.items():
        for idx, row in enumerate(group):
            new_row = {}
            for field in fieldnames:
                val = row.get(field, "")

                if field == "Variant Grams":
                    val = ""

                # Override Variant Price with wholesale × multiplier on product rows
                if idx == 0 and field == "Variant Price":
                    sku = row.get("Variant SKU", "").strip()
                    if sku in wholesale_prices:
                        val = f"{wholesale_prices[sku] * B2BMARKT_PRICE_MULTIPLIER:.2f}"

                # Step 1: clean text fields
                if field in FIELDS_CLEANED:
                    if field == "Type":
                        val = clean_type(val)
                    else:
                        val = clean_text(val)

                # Step 2: remove HM codes from customer-facing fields
                if field == "Body (HTML)":
                    val = clean_body_html(val)
                elif field in {"Title", "SEO Title", "SEO Description", "Image Alt Text"}:
                    val = remove_hm_codes(val)

                # Step 3: blank Product Category on ALL rows
                if field == "Product Category":
                    val = ""

                # Step 4: set weight on first product row only
                if idx == 0 and field == "Variant Grams":
                    sku = row.get("Variant SKU", "").strip()
                    if sku in weights:
                        val = str(weights[sku])

                # Step 5: blank non-image fields on image-only rows
                if idx > 0 and field in FIELDS_BLANK_ON_IMAGE_ROWS:
                    val = ""

                new_row[field] = val

            output_rows.append(new_row)

    # Write output
    with open(OUTPUT, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    # QA Report
    total_rows = len(output_rows)
    handles = [r.get("Handle", "") for r in output_rows]
    unique_handles = set(handles)
    handle_counts = Counter(handles)

    rows_with_sku = sum(1 for r in output_rows if r.get("Variant SKU", "").strip())
    rows_with_title = sum(1 for r in output_rows if r.get("Title", "").strip())
    rows_with_category = sum(1 for r in output_rows if r.get("Product Category", "").strip())
    rows_with_status = sum(1 for r in output_rows if r.get("Status", "").strip())
    rows_with_grams = sum(1 for r in output_rows if r.get("Variant Grams", "").strip())
    image_rows_count = sum(1 for r in output_rows if r.get("Image Src", "").strip())

    skus = sorted(set(r.get("Variant SKU", "").strip() for r in output_rows if r.get("Variant SKU", "").strip()))
    leading_zero_skus = [s for s in skus if s.startswith("0")]

    status_values = Counter(r.get("Status", "").strip() for r in output_rows if r.get("Status", "").strip())

    # HM code check in customer-facing fields
    hm_fields = ["Title", "Body (HTML)", "SEO Title", "SEO Description", "Image Alt Text"]
    hm_rows = []
    for i, r in enumerate(output_rows):
        for field in hm_fields:
            if HM_CODE_RE.search(r.get(field, "")):
                hm_rows.append((i, field, r.get(field, "")[:80]))
                break

    # Greek check
    greek_fields = ["Title", "Body (HTML)", "Type", "Image Alt Text", "SEO Title", "SEO Description", "Tags"]
    greek_rows = []
    for i, r in enumerate(output_rows):
        for field in greek_fields:
            if has_greek(r.get(field, "")):
                greek_rows.append((i, field, r.get(field, "")[:80]))
                break

    # Image-only row validation
    image_only_fields_check = {"Title", "Variant SKU", "Variant Price", "Variant Barcode",
                               "Status", "SEO Title", "SEO Description", "Vendor", "Body (HTML)"}
    bad_image_rows = []
    for i, r in enumerate(output_rows):
        if not r.get("Variant SKU", "").strip() and r.get("Image Src", "").strip():
            for field in image_only_fields_check:
                if r.get(field, "").strip():
                    bad_image_rows.append((i, field, r.get(field, "")[:60]))

    print("=" * 60)
    print("  QA REPORT: shopify-kids-room-import-clean.csv")
    print("=" * 60)
    print()
    print(f"  Total rows:              {total_rows}")
    print(f"  Unique handles:          {len(unique_handles)}")
    print(f"  Rows with Variant SKU:   {rows_with_sku}")
    print(f"  Rows with Variant Grams: {rows_with_grams}")
    print(f"  Rows with Title:         {rows_with_title}")
    print(f"  Rows with Product Cat:   {rows_with_category}")
    print(f"  Rows with Status:        {rows_with_status}")
    print(f"  Image rows:              {image_rows_count}")
    print(f"  Unique SKUs:             {len(skus)} → {', '.join(skus)}")
    print(f"  SKUs with leading zero:  {len(leading_zero_skus)} → {', '.join(leading_zero_skus)}")
    print()
    print(f"  Status values:           {dict(status_values)}")
    print()

    # Weight and price details
    print("  Product weights and prices:")
    for h, count in handle_counts.items():
        sku = next((r.get("Variant SKU", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Variant SKU", "").strip()), "")
        grams = next((r.get("Variant Grams", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Variant SKU", "").strip()), "")
        price = next((r.get("Variant Price", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Variant SKU", "").strip()), "")
        kg = f"{int(grams)/1000:.1f}" if grams else "—"
        wp_source = wholesale_prices.get(sku)
        wp_note = f"wholesale={wp_source}" if wp_source is not None else "no wholesale"
        print(f"    {h}  SKU={sku}  price={price} ({wp_note})  grams={grams} ({kg} kg)")
    print()

    if hm_rows:
        print(f"  ⚠ Remaining HM codes: {len(hm_rows)}")
        for idx, field, snippet in hm_rows:
            print(f"    Row {idx}, '{field}': {snippet}...")
    else:
        print(f"  ✓ No HM model codes in customer-facing fields")
    print()

    if greek_rows:
        print(f"  ⚠ Rows with Greek: {len(greek_rows)}")
        for idx, field, snippet in greek_rows:
            print(f"    Row {idx}, '{field}': {snippet}...")
    else:
        print(f"  ✓ No Greek characters in text fields")
    print()

    if bad_image_rows:
        print(f"  ⚠ Image-only rows with non-blank fields: {len(bad_image_rows)}")
        for idx, field, snippet in bad_image_rows:
            print(f"    Row {idx}, '{field}': {snippet!r}")
    else:
        print(f"  ✓ All image-only rows have blank variant fields")
    print()

    print("  Per-handle breakdown:")
    for h, count in handle_counts.items():
        sku = next((r.get("Variant SKU", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Variant SKU", "").strip()), "—")
        title = next((r.get("Title", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Title", "").strip()), "—")
        img_count = count - 1
        print(f"    {h}  SKU={sku}  title={title[:50]}  images={img_count}")
    print()

    print("-" * 60)
    if rows_with_sku == len(unique_handles) and rows_with_category == 0 and not greek_rows and not hm_rows and not bad_image_rows:
        print("  RESULT: CLEAN — safe for manual Shopify import")
    else:
        print("  RESULT: review before import")
    print("-" * 60)
    print()
    print(f"  Output: {OUTPUT}")


if __name__ == "__main__":
    main()
