#!/usr/bin/env python3
"""
QA/cleanup script for Megapap Shopify import CSVs.

Reads a shopify-import CSV from the Megapap translation pipeline, applies text
corrections, sets pricing (wholesale × 1.70), weight conversion, and writes a
cleaned CSV in proper Shopify multi-image format.

Shopify image-row format:
  - First row per Handle: full product + variant + SEO + status + Image 1
  - Rows 2+ per Handle: ONLY Handle, Image Src, Image Position, Image Alt Text

Local-only. Does not touch Shopify, inventory, or dashboard code.

Usage:
    python3 scripts/clean_megapap_import.py
    python3 scripts/clean_megapap_import.py --input=translated-megapap-batch-1-shopify-import.csv
    python3 scripts/clean_megapap_import.py --input=translated-megapap-batch-1-shopify-import.csv --weight-source=translated-megapap-batch-1.json

Input default:  translated-megapap-products-shopify-import.csv
Output default: <input-base>-clean.csv
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, OrderedDict

GREEK_RE = re.compile(r"[\u0370-\u03FF\u1F00-\u1FFF]")
GREEK_RE_STRICT = re.compile(r"[\u0391-\u03C9]")
MEGAPAP_CODE_RE = re.compile(r"(?:^|\s)Megapap(?:\s|$)", re.IGNORECASE)
DIAMETER_RE = re.compile(r"Φ\d+")

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

MEGAPAP_PRICE_MULTIPLIER = 1.70

SUSPICIOUS_PHRASES = [
    "Megapap",
]

MIXED_SCRIPT_RE = re.compile(
    r"(?=[\u0400-\u04FF]*[A-Za-z])"
    r"(?=[A-Za-z]*[\u0400-\u04FF])"
    r"[\u0400-\u04FFA-Za-z]{3,}"
)


def normalize_category_mapping(raw):
    """Convert old or new format mapping to unified structure with 'default' and 'rules'."""
    if not raw:
        return None, "missing"
    if "default" in raw:
        mode = "rule" if "rules" in raw else "default"
        return {
            "default": raw.get("default", {"type": "", "tags": []}),
            "rules": raw.get("rules", []),
        }, mode
    if "type" in raw or "tags" in raw:
        return {
            "default": {"type": raw.get("type", ""), "tags": raw.get("tags", [])},
            "rules": [],
        }, "old"
    return None, "missing"


def match_rule(rules, title, body, seo_title):
    """Find first matching rule. Returns (rule, label) or (None, None)."""
    search_text = " ".join(filter(None, [title, body, seo_title])).lower()
    for rule in rules:
        patterns = rule.get("match", [])
        for pattern in patterns:
            if pattern.lower() in search_text:
                return rule, pattern
    return None, None


def load_product_data(path):
    """Load weight_kg and wholesale_price_without_vat per SKU from the translated JSON."""
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
            wp = p.get("wholesale_price_without_vat", "")
            if wp:
                try:
                    wholesale_prices[sku] = float(wp)
                except (ValueError, TypeError):
                    pass
    except FileNotFoundError:
        pass
    return weights, wholesale_prices


def clean_text(value):
    if not value:
        return value
    result = MEGAPAP_CODE_RE.sub("", value)
    result = re.sub(r"\s{2,}", " ", result).strip()
    return result


def remove_megapap_brand(value):
    if not value:
        return value
    result = MEGAPAP_CODE_RE.sub("", value)
    result = re.sub(r"\s{2,}", " ", result)
    result = re.sub(r"\s*-\s*-", " -", result)
    result = re.sub(r"\s*,\s*,", ",", result)
    return result.strip()


def has_greek(value):
    if not value:
        return False
    stripped = DIAMETER_RE.sub("", value)
    return bool(GREEK_RE_STRICT.search(stripped))


def find_suspicious(value):
    if not value:
        return []
    found = []
    for phrase in SUSPICIOUS_PHRASES:
        if phrase.lower() in value.lower():
            found.append(phrase)
    mixed = MIXED_SCRIPT_RE.findall(value)
    for word in mixed:
        found.append(f"mixed-script:{word}")
    return found


def parse_args():
    parser = argparse.ArgumentParser(description="Clean Megapap Shopify import CSV")
    parser.add_argument("--input", default="translated-megapap-products-shopify-import.csv", help="Input CSV path")
    parser.add_argument("--weight-source", default=None, help="JSON file with weight/price data")
    parser.add_argument("--category", default=None, help="Megapap category name for mapping (e.g. Indoor furniture > Beds)")
    parser.add_argument("--category-map", default=None, help="Path to category mapping JSON file")
    return parser.parse_args()


def derive_output_path(input_path):
    base = input_path
    if base.endswith(".csv"):
        base = base[:-4]
    return f"{base}-clean.csv"


def auto_detect_weight_source(input_path):
    candidates = ["translated-megapap-products.json"]
    base = os.path.basename(input_path)
    if base.endswith(".csv"):
        base = base[:-4]
    if base.endswith("-shopify-import"):
        base = base[:-17]
    if base.startswith("translated-"):
        candidates.insert(0, f"{base}.json")
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def main():
    args = parse_args()
    input_path = args.input
    output_path = derive_output_path(input_path)

    weight_source = args.weight_source
    if not weight_source:
        weight_source = auto_detect_weight_source(input_path)
        if not weight_source:
            print(f"WARNING: No weight/price source found. Prices will use CSV values as-is.")

    try:
        with open(input_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            fieldnames = list(reader.fieldnames)
            rows = list(reader)
    except FileNotFoundError:
        print(f"ERROR: {input_path} not found.")
        sys.exit(1)

    if not fieldnames:
        print("ERROR: CSV has no header row.")
        sys.exit(1)

    if "Variant Grams" not in fieldnames:
        idx = fieldnames.index("Variant Weight Unit") + 1
        fieldnames.insert(idx, "Variant Grams")

    weights = {}
    wholesale_prices = {}
    if weight_source:
        weights, wholesale_prices = load_product_data(weight_source)
        print(f"Loaded weights: {len(weights)} SKUs, wholesale prices: {len(wholesale_prices)} SKUs")

    # Load category mapping
    category_map = {}
    category_mapping = None
    mapping_mode = "missing"
    if args.category_map:
        try:
            with open(args.category_map, "r", encoding="utf-8") as f:
                category_map = json.load(f)
        except FileNotFoundError:
            print(f"WARNING: Category map file not found: {args.category_map}")
        except json.JSONDecodeError as e:
            print(f"WARNING: Invalid JSON in category map: {e}")

    if args.category and category_map:
        if args.category in category_map:
            raw = category_map[args.category]
            category_mapping, mapping_mode = normalize_category_mapping(raw)
            if category_mapping:
                def_label = category_mapping["default"].get("type", "")
                rules_count = len(category_mapping["rules"])
                print(f"Category mapping loaded: {args.category} (mode={mapping_mode}, default_type={def_label}, rules={rules_count})")
            else:
                print(f"WARNING: Category '{args.category}' has no usable mapping in {args.category_map}")
        else:
            print(f"WARNING: Category '{args.category}' not found in mapping file {args.category_map}")
            print(f"  Known categories: {', '.join(category_map.keys())}")
            print(f"  Type/Tags will be left empty. Do NOT guess.")

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
                        val = f"{wholesale_prices[sku] * MEGAPAP_PRICE_MULTIPLIER:.2f}"

                # Clean text fields
                if field in FIELDS_CLEANED:
                    val = clean_text(val)

                # Remove Megapap brand from customer-facing fields
                if field in {"Title", "SEO Title", "SEO Description", "Image Alt Text"}:
                    val = remove_megapap_brand(val)

                # Blank Product Category on ALL rows
                if field == "Product Category":
                    val = ""

                # Ensure Vendor = Mebelcenter
                if field == "Vendor":
                    val = "Mebelcenter"

                # Ensure Status = draft on product rows
                if idx == 0 and field == "Status":
                    val = "draft"

                # Set weight on first product row only
                if idx == 0 and field == "Variant Grams":
                    sku = row.get("Variant SKU", "").strip()
                    if sku in weights:
                        val = str(weights[sku])

                # Blank non-image fields on image-only rows
                if idx > 0 and field in FIELDS_BLANK_ON_IMAGE_ROWS:
                    val = ""

                new_row[field] = val

            # Apply category mapping to Type and Tags on product rows
            if idx == 0 and category_mapping:
                rules = category_mapping.get("rules", [])
                default = category_mapping.get("default", {})
                if rules:
                    title_for_match = new_row.get("Title", "")
                    body_for_match = new_row.get("Body (HTML)", "")
                    seo_for_match = new_row.get("SEO Title", "")
                    matched_rule, matched_pattern = match_rule(rules, title_for_match, body_for_match, seo_for_match)
                    if matched_rule:
                        new_row["Type"] = matched_rule.get("type", default.get("type", ""))
                        tags = matched_rule.get("tags", default.get("tags", []))
                        new_row["Tags"] = ", ".join(tags) if tags else ""
                    else:
                        new_row["Type"] = default.get("type", "")
                        tags = default.get("tags", [])
                        new_row["Tags"] = ", ".join(tags) if tags else ""
                else:
                    if default.get("type"):
                        new_row["Type"] = default["type"]
                    if default.get("tags"):
                        new_row["Tags"] = ", ".join(default["tags"])
                    else:
                        new_row["Tags"] = ""

            output_rows.append(new_row)

    # Write output
    with open(output_path, "w", encoding="utf-8", newline="") as f:
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
    rows_with_price = sum(1 for r in output_rows if r.get("Variant Price", "").strip())
    image_rows_count = sum(1 for r in output_rows if r.get("Image Src", "").strip())

    skus = sorted(set(r.get("Variant SKU", "").strip() for r in output_rows if r.get("Variant SKU", "").strip()))

    status_values = Counter(r.get("Status", "").strip() for r in output_rows if r.get("Status", "").strip())
    vendor_values = Counter(r.get("Vendor", "").strip() for r in output_rows if r.get("Vendor", "").strip())

    # Greek check
    greek_fields = ["Title", "Body (HTML)", "Type", "Image Alt Text", "SEO Title", "SEO Description", "Tags"]
    greek_rows = []
    for i, r in enumerate(output_rows):
        for field in greek_fields:
            if has_greek(r.get(field, "")):
                greek_rows.append((i, field, r.get(field, "")[:80]))
                break

    # Suspicious phrase detection (product rows only)
    suspicious_fields = ["Title", "Body (HTML)", "SEO Title", "SEO Description", "Image Alt Text", "Type"]
    suspicious_rows = []
    for i, r in enumerate(output_rows):
        if not r.get("Variant SKU", "").strip():
            continue
        for field in suspicious_fields:
            found = find_suspicious(r.get(field, ""))
            for phrase in found:
                suspicious_rows.append((i, field, phrase, r.get(field, "")[:100]))

    # Image-only row validation
    image_only_fields_check = {"Title", "Variant SKU", "Variant Price", "Variant Barcode",
                               "Status", "SEO Title", "SEO Description", "Vendor", "Body (HTML)"}
    bad_image_rows = []
    for i, r in enumerate(output_rows):
        if not r.get("Variant SKU", "").strip() and r.get("Image Src", "").strip():
            for field in image_only_fields_check:
                if r.get(field, "").strip():
                    bad_image_rows.append((i, field, r.get(field, "")[:60]))

    # Tags and Type analysis (product rows only)
    product_tags = Counter()
    product_types = Counter()
    rows_with_blank_tags = 0
    for r in output_rows:
        if r.get("Variant SKU", "").strip():
            tag = r.get("Tags", "").strip()
            typ = r.get("Type", "").strip()
            if tag:
                product_tags[tag] += 1
            else:
                rows_with_blank_tags += 1
            if typ:
                product_types[typ] += 1

    print("=" * 60)
    print(f"  QA REPORT: {output_path}")
    print("=" * 60)
    print()

    # Category mapping summary
    if args.category:
        print(f"  Category:                {args.category}")
        print(f"  Mapping mode:            {mapping_mode}")
        if category_mapping:
            def_type = category_mapping["default"].get("type", "(none)")
            def_tags = ", ".join(category_mapping["default"].get("tags", []))
            print(f"  Default Type:            {def_type}")
            print(f"  Default Tags:            {def_tags}")
            if category_mapping["rules"]:
                print(f"  Rules count:             {len(category_mapping['rules'])}")
        else:
            print(f"  ⚠ No mapping found — Type/Tags not overridden")
    else:
        print(f"  Category:                (not specified)")
        print(f"  Mapping mode:            (none)")
        print(f"  ⚠ Category mapping not applied — Type/Tags empty")
    print()
    print(f"  Total rows:              {total_rows}")
    print(f"  Unique handles:          {len(unique_handles)}")
    print(f"  Rows with Variant SKU:   {rows_with_sku}")
    print(f"  Rows with Variant Price: {rows_with_price}")
    print(f"  Rows with Variant Grams: {rows_with_grams}")
    print(f"  Rows with Title:         {rows_with_title}")
    print(f"  Rows with Product Cat:   {rows_with_category}")
    print(f"  Rows with Status:        {rows_with_status}")
    print(f"  Image rows:              {image_rows_count}")
    print(f"  Unique SKUs:             {len(skus)} → {', '.join(skus[:20])}{'...' if len(skus) > 20 else ''}")
    print()
    print(f"  Status values:           {dict(status_values)}")
    print(f"  Vendor values:           {dict(vendor_values)}")
    print()

    if product_tags:
        print(f"  Unique Tags:             {dict(product_tags)}")
    else:
        print(f"  Unique Tags:             (empty)")
    if product_types:
        print(f"  Unique Types:            {dict(product_types)}")
    else:
        print(f"  Unique Types:            (empty)")
    if rows_with_blank_tags > 0:
        print(f"  Rows with blank Tags:    {rows_with_blank_tags}")
    print()

    # Greek check specifically on Type and Tags
    greek_type_tags = []
    for i, r in enumerate(output_rows):
        if r.get("Variant SKU", "").strip():
            for field in ["Type", "Tags"]:
                if has_greek(r.get(field, "")):
                    greek_type_tags.append((i, field, r.get(field, "")[:80]))
    if greek_type_tags:
        print(f"  ⚠ Greek in Type/Tags: {len(greek_type_tags)}")
        for idx, field, snippet in greek_type_tags:
            print(f"    Row {idx}, '{field}': {snippet}...")
    else:
        print(f"  ✓ No Greek in Type/Tags")
    print()

    # Weight and price details
    print("  Product weights and prices:")
    for h, count in handle_counts.items():
        sku = next((r.get("Variant SKU", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Variant SKU", "").strip()), "")
        grams = next((r.get("Variant Grams", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Variant SKU", "").strip()), "")
        price = next((r.get("Variant Price", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Variant SKU", "").strip()), "")
        kg = f"{int(grams)/1000:.1f}" if grams else "—"
        wp_source = wholesale_prices.get(sku)
        if wp_source is not None:
            expected = f"{wp_source * MEGAPAP_PRICE_MULTIPLIER:.2f}"
            wp_note = f"wholesale={wp_source} × 1.70 = {expected}"
        else:
            wp_note = "no wholesale"
        print(f"    {h}  SKU={sku}  price={price} ({wp_note})  grams={grams} ({kg} kg)")
    print()

    if greek_rows:
        print(f"  ⚠ Rows with Greek: {len(greek_rows)}")
        for idx, field, snippet in greek_rows:
            print(f"    Row {idx}, '{field}': {snippet}...")
    else:
        print(f"  ✓ No Greek characters in text fields")
    print()

    if suspicious_rows:
        print(f"  ⚠ Suspicious phrases: {len(suspicious_rows)}")
        for idx, field, phrase, snippet in suspicious_rows:
            print(f"    Row {idx}, '{field}': [{phrase}] {snippet[:80]}...")
    else:
        print(f"  ✓ No suspicious phrases detected")
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
        typ = next((r.get("Type", "").strip() for r in output_rows if r.get("Handle") == h), "—")
        tags = next((r.get("Tags", "").strip() for r in output_rows if r.get("Handle") == h), "—")
        img_count = count - 1
        rule_label = ""
        if category_mapping and category_mapping["rules"]:
            body = next((r.get("Body (HTML)", "") for r in output_rows if r.get("Handle") == h), "")
            seo = next((r.get("SEO Title", "") for r in output_rows if r.get("Handle") == h), "")
            _, matched_pattern = match_rule(category_mapping["rules"], title, body, seo)
            rule_label = f"  rule='{matched_pattern}'" if matched_pattern else "  [default]"
        print(f"    {h}  SKU={sku}  title={title[:50]}  type={typ}  tags={tags}{rule_label}  images={img_count}")
    print()

    has_issues = greek_rows or bad_image_rows
    print("-" * 60)
    if rows_with_sku == len(unique_handles) and rows_with_category == 0 and not has_issues:
        if suspicious_rows:
            print("  RESULT: CLEAN with warnings — review suspicious phrases before import")
        else:
            print("  RESULT: CLEAN — safe for manual Shopify import")
    else:
        print("  RESULT: review before import")
    print("-" * 60)
    print()
    print(f"  Output: {output_path}")


if __name__ == "__main__":
    main()
