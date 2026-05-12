#!/usr/bin/env python3
"""
QA/cleanup script for B2BMarkt Shopify import CSVs.

Reads a shopify-import CSV (any category), applies text corrections including
Bulgarian grammar fixes, writes a cleaned CSV in proper Shopify multi-image
format, and prints a QA report.

Shopify image-row format:
  - First row per Handle: full product + variant + SEO + status + Image 1
  - Rows 2+ per Handle: ONLY Handle, Image Src, Image Position, Image Alt Text

Local-only. Does not touch Shopify, inventory, or dashboard code.

Usage:
    python3 scripts/clean_b2bmarkt_import.py
    python3 scripts/clean_b2bmarkt_import.py --input=shopify-saloni-batch-1.csv
    python3 scripts/clean_b2bmarkt_import.py --input=shopify-import.csv --weight-source=translated-products.json

Input default:  shopify-import.csv
Output default: <input-base>-clean.csv  (e.g. shopify-saloni-batch-1-clean.csv)
"""

import argparse
import csv
import json
import re
import sys
from collections import Counter, OrderedDict

GREEK_RE = re.compile(r"[\u0370-\u03FF\u1F00-\u1FFF]")
HM_CODE_RE = re.compile(r"HM\d+(?:\.\d+)?")
HM_HEADING_RE = re.compile(r"\s*<p><strong>HM\d+(?:\.\d+)?</strong></p>")

# Basic text replacements (typos, Greek→Bulgarian, etc.)
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
    ("[L] Σαλόνια - γωνίες", "Ъглови дивани"),
    ("Εσωτερικός χώρος", "Мебели"),
    ("Κρεβάτια", "Детски легла"),
    ("Παιδικά πακέτα", "Детски комплекти"),
    ("Κουκέτες", "Детски двуетажни легла"),
    ("Καρεκλάκια", "Детски столчета"),
    ("Τραπέζια", "Детски маси"),
    ("Σαλόνια - γωνίες", "Ъглови дивани"),
]

# Bulgarian grammar fixes: (pattern, replacement)
GRAMMAR_FIXES = [
    ("Детско трапезарно масичка", "Детска масичка"),
    ("Детски етажерка", "Детска етажерка"),
    ("Детско масичка", "Детска масичка"),
    ("Метален двуетажен легло", "Метално двуетажно легло"),
    ("двуетажен легло", "двуетажно легло"),
    ("Детски учебен пирамид", "Детска учебна кула"),
    ("тролей/количка", "количка"),
]

TYPE_OVERRIDES = {
    "Детски легла": "Детски легла",
    "Детски комплекти": "Детски комплекти",
    "Детски двуетажни легла": "Детски двуетажни легла",
    "Детски столчета": "Детски столчета",
    "Детски маси": "Детски маси",
    "Мебели": "Мебели",
    "Ъглови дивани": "Ъглови дивани",
}

# Map Type values to appropriate Tags
TYPE_TO_TAG = {
    "Детски легла": "Детски легла",
    "Детски комплекти": "Детски комплекти",
    "Детски двуетажни легла": "Детски двуетажни легла",
    "Детски столчета": "Детски столчета",
    "Детски маси": "Детски маси",
    "Мебели": "Мебели",
    "Ъглови дивани": "Ъглови дивани",
    "Легла": "Легла",
    "Маси": "Маси",
    "Столове и фотьойли": "Столове и фотьойли",
    "Осветление": "Осветление",
    "Офис мебели": "Офис мебели",
    "Декорация": "Декорация",
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

SUSPICIOUS_PHRASES = [
    "Детски етажерка",
    "Детско масичка",
    "двуетажен легло",
    "трапезарно масичка",
    "Сумида",
    "Симида",
]

MIXED_SCRIPT_RE = re.compile(
    r"(?=[\u0400-\u04FF]*[A-Za-z])"
    r"(?=[A-Za-z]*[\u0400-\u04FF])"
    r"[\u0400-\u04FFA-Za-z]{3,}"
)

# Matches image URLs with empty filename before extension: /prd/o/73889/.jpg
INVALID_IMAGE_URL_RE = re.compile(r"/\.[a-zA-Z]+(?:\?.*)?$")

# Symetron brand name variants
SYMETRON_RE = re.compile(r"\bSYMETRON\b", re.IGNORECASE)

# Symetron model codes: SM followed by digits, dot, digits (e.g. SM6467.01, SM6451.02)
SM_CODE_RE = re.compile(r"\bSM\d{4,}\.\d+\b")

# Mixed-script unit artifacts: Cyrillic letter + Latin "cm" or similar
BROKEN_CM_RE = re.compile(r"[\u0400-\u04FF][cC][mM]\b")

# Known mixed-script word fixes: (pattern, replacement)
MIXED_SCRIPT_FIXES = [
    # МОНO (Cyrillic М+О+Н + Latin O) -> Моно
    ("МОНO", "Моно"),
    ("МонO", "Моно"),
    ("мОНО", "Моно"),
    ("MONO", "Моно"),
    # Broken cm endings: Cyrillic letter + cm -> см
]


def normalize_mixed_script(value):
    """Fix known mixed-script artifacts in customer-facing text."""
    if not value:
        return value
    result = value
    for old, new in MIXED_SCRIPT_FIXES:
        result = result.replace(old, new)
    # Fix broken cm endings: any Cyrillic char followed by Latin "cm" -> см
    result = BROKEN_CM_RE.sub("см", result)
    return result


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
    result = re.sub(r"\[L\]\s*", "", result).strip()
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


def apply_grammar_fixes(value):
    """Apply Bulgarian grammar fixes. Returns (fixed_value, count_of_fixes)."""
    if not value:
        return value, 0
    result = value
    count = 0
    for old, new in GRAMMAR_FIXES:
        if old in result:
            result = result.replace(old, new)
            count += 1
    return result, count


def remove_hm_codes(value):
    """Remove HM model codes from customer-facing text."""
    if not value:
        return value
    result = HM_CODE_RE.sub("", value)
    result = re.sub(r"\s{2,}", " ", result)
    result = re.sub(r"\s*-\s*-", " -", result)
    result = re.sub(r"\s*,\s*,", ",", result)
    return result.strip()


def remove_symetron_artifacts(value):
    """Remove SYMETRON brand name and SM model codes from customer-facing text."""
    if not value:
        return value
    result = SYMETRON_RE.sub("", value)
    result = SM_CODE_RE.sub("", result)
    result = re.sub(r"\s{2,}", " ", result)
    result = re.sub(r"\s*-\s*-", " -", result)
    result = re.sub(r"\s*–\s*–", " –", result)
    result = re.sub(r"\s*,\s*,", ",", result)
    result = re.sub(r"\s*&\s*&", " &", result)
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


def find_suspicious(value):
    """Return list of suspicious phrases found in value."""
    if not value:
        return []
    found = []
    for phrase in SUSPICIOUS_PHRASES:
        if phrase in value:
            found.append(phrase)
    mixed = MIXED_SCRIPT_RE.findall(value)
    for word in mixed:
        found.append(f"mixed-script:{word}")
    return found


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


def parse_args():
    parser = argparse.ArgumentParser(description="Clean B2BMarkt Shopify import CSV")
    parser.add_argument("--input", default="shopify-import.csv", help="Input CSV path (default: shopify-import.csv)")
    parser.add_argument("--weight-source", default=None, help="JSON file with weight/price data (default: auto-detect)")
    parser.add_argument("--category", default=None, help="B2BMarkt category name for mapping (e.g. Σαλόνια - γωνίες)")
    parser.add_argument("--all-categories", action="store_true", help="Use per-product category mapping from JSON source")
    parser.add_argument("--category-map", default=None, help="Path to category mapping JSON file")
    return parser.parse_args()


def derive_output_path(input_path):
    """Derive output path: <base>-clean.csv"""
    base = input_path
    if base.endswith(".csv"):
        base = base[:-4]
    return f"{base}-clean.csv"


def auto_detect_weight_source(input_path):
    """Try to find a matching translated JSON file."""
    import os
    candidates = [
        "translated-kids-room-products.json",
        "translated-products.json",
    ]
    # Try to derive from input name
    base = os.path.basename(input_path)
    if base.endswith(".csv"):
        base = base[:-4]
    # e.g. shopify-saloni-batch-1 → translated-saloni-batch-1.json
    if base.startswith("shopify-"):
        candidates.insert(0, f"translated-{base[8:]}.json")
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


LEVEL_PREFIX_RE = re.compile(r"^\[[Ll](?:[Ee][Vv][Ee][Ll])?\d*\]\s*")


def normalize_category(cat):
    """Remove leading level markers like [L], [L1], [L2], [level] and trim."""
    if not cat:
        return ""
    return LEVEL_PREFIX_RE.sub("", cat).strip()


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
    sku_categories = {}
    if weight_source:
        weights, wholesale_prices = load_product_data(weight_source)
        # Also load per-product source categories from JSON for all-categories mode
        if args.all_categories:
            try:
                with open(weight_source, "r", encoding="utf-8") as f:
                    json_data = json.load(f)
                for p in json_data.get("products", []):
                    sku = p.get("sku", "")
                    if not sku:
                        continue
                    # Prefer source_category (from translation JSON)
                    source_cat = p.get("source_category", "")
                    if not source_cat:
                        # Fallback: extract from categories array (from export JSON)
                        cats = p.get("categories", [])
                        if cats:
                            last_cat = cats[-1]
                            if isinstance(last_cat, dict):
                                source_cat = last_cat.get("text", "")
                            else:
                                source_cat = str(last_cat)
                    if source_cat:
                        # Normalize: remove [L], [L1], [L2], [level] prefixes
                        normalized = normalize_category(source_cat)
                        sku_categories[sku] = normalized if normalized else source_cat
            except (FileNotFoundError, json.JSONDecodeError, KeyError):
                pass

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
            print(f"  Tags will be left empty. Type will use existing CSV value.")

    if args.all_categories:
        print(f"Mode: ALL CATEGORIES (per-product category mapping)")
        print(f"  Products with source category: {len(sku_categories)}")
        print(f"  Categories in map: {len(category_map)}")

    # Group rows by Handle, preserving order
    groups = OrderedDict()
    for row in rows:
        h = row.get("Handle", "")
        groups.setdefault(h, []).append(row)

    # Build cleaned output
    output_rows = []
    total_grammar_fixes = 0
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

                # Step 1b: Bulgarian grammar fixes on product rows only
                if idx == 0 and field in {"Title", "SEO Title", "SEO Description", "Image Alt Text"}:
                    val, fixes = apply_grammar_fixes(val)
                    total_grammar_fixes += fixes

                # Step 2: remove HM codes from customer-facing fields
                if field == "Body (HTML)":
                    val = clean_body_html(val)
                elif field in {"Title", "SEO Title", "SEO Description", "Image Alt Text"}:
                    val = remove_hm_codes(val)

                # Step 2b: remove SYMETRON brand/SM codes and normalize mixed-script artifacts
                if field in {"Title", "Body (HTML)", "SEO Title", "SEO Description", "Image Alt Text"}:
                    val = remove_symetron_artifacts(val)
                    val = normalize_mixed_script(val)

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

            # Step 6: Apply category mapping to Type and Tags on product rows
            if idx == 0 and category_map:
                if args.all_categories:
                    # Per-product category mapping
                    sku = new_row.get("Variant SKU", "").strip()
                    source_cat = sku_categories.get(sku, "")
                    if source_cat and source_cat in category_map:
                        raw = category_map[source_cat]
                        prod_mapping, _ = normalize_category_mapping(raw)
                        if prod_mapping:
                            rules = prod_mapping.get("rules", [])
                            default = prod_mapping.get("default", {})
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
                    # else: no mapping for this category — leave Type/Tags as-is
                elif category_mapping:
                    # Single category mode (CLI --category)
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

    # Fix invalid image URLs (empty filename before extension, e.g. /.jpg)
    # Strategy: replace /.jpg with -1.jpg (which returns proper image/jpeg).
    # CRITICAL: Never drop the product data row (first row per handle).
    # If fixing creates a duplicate URL, remove the duplicate image-only row instead.
    invalid_removed = []
    invalid_replaced = []
    filtered_rows = []

    # First pass: identify product rows (first per handle) and collect valid URLs per handle
    handle_product_row_idx = {}
    handle_valid_urls = {}
    for i, r in enumerate(output_rows):
        h = r.get("Handle", "")
        if h not in handle_product_row_idx:
            handle_product_row_idx[h] = i
        img_src = r.get("Image Src", "").strip()
        if img_src and not INVALID_IMAGE_URL_RE.search(img_src):
            handle_valid_urls.setdefault(h, set()).add(img_src)

    # Second pass: process rows
    # Track which rows to drop (by index)
    drop_indices = set()
    for i, r in enumerate(output_rows):
        h = r.get("Handle", "")
        img_src = r.get("Image Src", "").strip()
        is_product_row = (i == handle_product_row_idx.get(h, -1))

        if img_src and INVALID_IMAGE_URL_RE.search(img_src):
            sku = r.get("Variant SKU", "").strip()
            fixed_url = INVALID_IMAGE_URL_RE.sub("/-1.jpg", img_src)
            invalid_removed.append({
                "row": i,
                "handle": h,
                "sku": sku,
                "url": img_src,
                "fixed_url": fixed_url,
                "is_product_row": is_product_row,
            })

            if fixed_url in handle_valid_urls.get(h, set()):
                # Duplicate: -1.jpg already exists for this handle
                if is_product_row:
                    # Product row has /.jpg but -1.jpg exists as image-only row.
                    # Fix product row URL and drop the duplicate image-only row.
                    r["Image Src"] = fixed_url
                    invalid_replaced.append({
                        "handle": h,
                        "sku": sku,
                        "old_url": img_src,
                        "new_url": fixed_url,
                    })
                    # Find and mark the duplicate image-only row for removal
                    for j, other in enumerate(output_rows):
                        if j != i and other.get("Handle") == h and other.get("Image Src", "").strip() == fixed_url:
                            drop_indices.add(j)
                            break
                else:
                    # Image-only row with /.jpg and -1.jpg already exists → drop it
                    drop_indices.add(i)
            else:
                # No duplicate: fix the URL
                r["Image Src"] = fixed_url
                invalid_replaced.append({
                    "handle": h,
                    "sku": sku,
                    "old_url": img_src,
                    "new_url": fixed_url,
                })

    # Build filtered output, excluding dropped rows
    for i, r in enumerate(output_rows):
        if i not in drop_indices:
            filtered_rows.append(r)

    # Renumber Image Position per handle and detect zero-image products
    handle_img_positions = {}
    for r in filtered_rows:
        h = r.get("Handle", "")
        img_src = r.get("Image Src", "").strip()
        if img_src:
            handle_img_positions.setdefault(h, 0)
            handle_img_positions[h] += 1
            r["Image Position"] = str(handle_img_positions[h])

    zero_image_handles = []
    for h in set(r.get("Handle", "") for r in filtered_rows):
        if h not in handle_img_positions:
            zero_image_handles.append(h)

    output_rows = filtered_rows

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
    rows_with_price = sum(1 for r in output_rows if r.get("Variant Price", "").strip())
    rows_with_category = sum(1 for r in output_rows if r.get("Product Category", "").strip())
    rows_with_status = sum(1 for r in output_rows if r.get("Status", "").strip())
    rows_with_grams = sum(1 for r in output_rows if r.get("Variant Grams", "").strip())
    image_rows_count = sum(1 for r in output_rows if r.get("Image Src", "").strip())

    # Hard QA: product data row integrity
    # Product data row = first row per handle (has Variant SKU)
    handle_product_rows = {}
    for r in output_rows:
        h = r.get("Handle", "")
        sku = r.get("Variant SKU", "").strip()
        if sku:
            handle_product_rows.setdefault(h, []).append(r)

    missing_product_data = []
    duplicate_product_data = []
    incomplete_product_data = []
    required_fields = ["Title", "Variant SKU", "Variant Price", "Type", "Tags", "Status"]
    for h in unique_handles:
        prod_rows = handle_product_rows.get(h, [])
        if len(prod_rows) == 0:
            missing_product_data.append(h)
        elif len(prod_rows) > 1:
            duplicate_product_data.append(h)
        else:
            row = prod_rows[0]
            missing_fields = [f for f in required_fields if not row.get(f, "").strip()]
            if missing_fields:
                incomplete_product_data.append((h, missing_fields))

    product_data_row_count = len(handle_product_rows)

    skus = sorted(set(r.get("Variant SKU", "").strip() for r in output_rows if r.get("Variant SKU", "").strip()))
    leading_zero_skus = [s for s in skus if s.startswith("0")]

    status_values = Counter(r.get("Status", "").strip() for r in output_rows if r.get("Status", "").strip())

    # HM code check
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

    # SYMETRON brand name check
    symetron_fields = ["Title", "Body (HTML)", "SEO Title", "SEO Description", "Image Alt Text", "Tags"]
    symetron_rows = []
    for i, r in enumerate(output_rows):
        for field in symetron_fields:
            if SYMETRON_RE.search(r.get(field, "")):
                symetron_rows.append((i, field, r.get(field, "")[:80]))
                break

    # SM model code check
    sm_code_rows = []
    for i, r in enumerate(output_rows):
        for field in symetron_fields:
            if SM_CODE_RE.search(r.get(field, "")):
                sm_code_rows.append((i, field, r.get(field, "")[:80]))
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

    # Unmapped categories in all-categories mode
    unmapped_categories = Counter()
    unmapped_handles = []
    if args.all_categories and category_map:
        for r in output_rows:
            sku = r.get("Variant SKU", "").strip()
            if not sku:
                continue
            source_cat = sku_categories.get(sku, "")
            if source_cat and source_cat not in category_map:
                unmapped_categories[source_cat] += 1
                h = r.get("Handle", "")
                if h not in [x[0] for x in unmapped_handles]:
                    unmapped_handles.append((h, sku, source_cat))

    print("=" * 60)
    print(f"  QA REPORT: {output_path}")
    print("=" * 60)
    print()

    # Category mapping summary
    if args.all_categories:
        print(f"  Mode:                    ALL CATEGORIES")
        print(f"  Products with category:  {len(sku_categories)}")
        print(f"  Categories in map:       {len(category_map)}")
        if unmapped_categories:
            print(f"  ⚠ Unmapped categories:   {len(unmapped_categories)}")
            for cat, count in unmapped_categories.most_common():
                print(f"    {cat}: {count} products")
        else:
            print(f"  ✓ All product categories mapped")
    elif args.category:
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

    # Hard QA: product data row integrity
    print(f"  Product data rows:       {product_data_row_count}")
    print(f"  Image-only rows:         {total_rows - product_data_row_count}")
    print()
    if missing_product_data:
        print(f"  ✗ FAIL: {len(missing_product_data)} handles missing product data row:")
        for h in sorted(missing_product_data)[:10]:
            print(f"    {h}")
        if len(missing_product_data) > 10:
            print(f"    ... and {len(missing_product_data) - 10} more")
        print()
    else:
        print(f"  ✓ All handles have product data row")
        print()

    if duplicate_product_data:
        print(f"  ✗ FAIL: {len(duplicate_product_data)} handles with duplicate product data rows:")
        for h in sorted(duplicate_product_data)[:10]:
            print(f"    {h}")
        print()
    else:
        print(f"  ✓ No duplicate product data rows")
        print()

    if incomplete_product_data:
        print(f"  ✗ FAIL: {len(incomplete_product_data)} product rows with missing required fields:")
        for h, fields in incomplete_product_data[:10]:
            print(f"    {h}: missing {', '.join(fields)}")
        print()
    else:
        print(f"  ✓ All product rows have required fields (Title, SKU, Price, Type, Tags, Status)")
        print()

    # Tags and Type analysis (product rows only)
    product_tags = Counter()
    product_types = Counter()
    rows_with_detska_staya = 0
    for r in output_rows:
        if r.get("Variant SKU", "").strip():
            tag = r.get("Tags", "").strip()
            typ = r.get("Type", "").strip()
            if tag:
                product_tags[tag] += 1
            if typ:
                product_types[typ] += 1
            if tag == "Детска стая" or typ == "Детска стая":
                rows_with_detska_staya += 1

    print(f"  Product rows:            {len(product_tags)}")
    print(f"  Unique Tags:             {dict(product_tags)}")
    print(f"  Unique Types:            {dict(product_types)}")
    if rows_with_detska_staya > 0:
        print(f"  ⚠ Rows with 'Детска стая': {rows_with_detska_staya}")
    else:
        print(f"  ✓ No 'Детска стая' in Tags or Type")
    print()

    # Grammar fixes summary
    print(f"  Auto grammar fixes applied: {total_grammar_fixes}")
    if total_grammar_fixes > 0:
        print(f"    (Детски→Детска, двуетажен→двуетажно, пирамид→кула, etc.)")
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

    if suspicious_rows:
        print(f"  ⚠ Suspicious phrases: {len(suspicious_rows)}")
        for idx, field, phrase, snippet in suspicious_rows:
            print(f"    Row {idx}, '{field}': [{phrase}] {snippet[:80]}...")
    else:
        print(f"  ✓ No suspicious phrases detected")
    print()

    if symetron_rows:
        print(f"  ⚠ SYMETRON brand name found: {len(symetron_rows)}")
        for idx, field, snippet in symetron_rows:
            print(f"    Row {idx}, '{field}': {snippet}...")
    else:
        print(f"  ✓ No SYMETRON in customer-facing fields")
    print()

    if sm_code_rows:
        print(f"  ⚠ SM model codes found: {len(sm_code_rows)}")
        for idx, field, snippet in sm_code_rows:
            print(f"    Row {idx}, '{field}': {snippet}...")
    else:
        print(f"  ✓ No SM model codes in customer-facing fields")
    print()

    if bad_image_rows:
        print(f"  ⚠ Image-only rows with non-blank fields: {len(bad_image_rows)}")
        for idx, field, snippet in bad_image_rows:
            print(f"    Row {idx}, '{field}': {snippet!r}")
    else:
        print(f"  ✓ All image-only rows have blank variant fields")
    print()

    # Invalid image URL report
    if invalid_replaced:
        print(f"  ✓ Invalid image URLs fixed (/.jpg → -1.jpg): {len(invalid_replaced)}")
        for entry in invalid_replaced[:10]:
            print(f"    {entry['handle']}  SKU={entry['sku'] or '—'}  {entry['old_url']} → {entry['new_url']}")
        if len(invalid_replaced) > 10:
            print(f"    ... and {len(invalid_replaced) - 10} more")
    else:
        print(f"  ✓ No invalid image URLs (empty filename before extension)")

    invalid_dropped = [e for e in invalid_removed if e.get("fixed_url") and e["handle"] in [r.get("Handle") for r in filtered_rows if r.get("Image Src") == e["fixed_url"]]]
    if len(invalid_removed) > len(invalid_replaced):
        dropped_count = len(invalid_removed) - len(invalid_replaced)
        print(f"  ⚠ Invalid URLs dropped (duplicate -1.jpg): {dropped_count}")
    print()

    if zero_image_handles:
        print(f"  ⚠ Products with 0 images after cleanup: {len(zero_image_handles)}")
        for h in sorted(zero_image_handles):
            title = next((r.get("Title", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Title", "").strip()), "—")
            print(f"    {h}  title={title[:60]}")
    else:
        print(f"  ✓ All products have at least 1 image")
    print()

    print("  Per-handle breakdown:")
    for h, count in handle_counts.items():
        sku = next((r.get("Variant SKU", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Variant SKU", "").strip()), "—")
        title = next((r.get("Title", "").strip() for r in output_rows if r.get("Handle") == h and r.get("Title", "").strip()), "—")
        typ = next((r.get("Type", "").strip() for r in output_rows if r.get("Handle") == h), "—")
        tags = next((r.get("Tags", "").strip() for r in output_rows if r.get("Handle") == h), "—")
        img_count = sum(1 for r in output_rows if r.get("Handle") == h and r.get("Image Src", "").strip())
        rule_label = ""
        if category_mapping and category_mapping["rules"]:
            body = next((r.get("Body (HTML)", "") for r in output_rows if r.get("Handle") == h), "")
            seo = next((r.get("SEO Title", "") for r in output_rows if r.get("Handle") == h), "")
            _, matched_pattern = match_rule(category_mapping["rules"], title, body, seo)
            rule_label = f"  rule='{matched_pattern}'" if matched_pattern else "  [default]"
        print(f"    {h}  SKU={sku}  title={title[:50]}  type={typ}  tags={tags}{rule_label}  images={img_count}")
    print()

    has_hard_failure = missing_product_data or duplicate_product_data or incomplete_product_data
    has_issues = greek_rows or hm_rows or bad_image_rows or invalid_removed or symetron_rows or sm_code_rows or unmapped_categories
    print("-" * 60)
    if has_hard_failure:
        print("  ✗ FAIL: Product data integrity errors — DO NOT IMPORT")
    elif rows_with_sku == len(unique_handles) and rows_with_category == 0 and not has_issues:
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
