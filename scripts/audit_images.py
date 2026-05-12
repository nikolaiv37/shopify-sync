#!/usr/bin/env python3
"""
Image audit script for B2BMarkt/Symetron pipeline.

Compares image counts across all pipeline stages and validates
invalid "/.jpg" URLs via HEAD requests and JPEG magic byte detection.

Usage:
    python3 scripts/audit_images.py --feed=symetron --out-base=symetron-all-test
    python3 scripts/audit_images.py --xml=b2bmarkt_updated.xml --out-base=symetron-all-test
    python3 scripts/audit_images.py --out-base=symetron-all-test --xml-path=symetron.xml

Output:
    reports/<out-base>-image-audit.csv
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import OrderedDict

try:
    import requests
except ImportError:
    print("ERROR: requests library required. pip install requests", file=sys.stderr)
    sys.exit(1)

try:
    from fast_xml_parser import XMLParser
    HAS_FXP = True
except ImportError:
    try:
        from xml.parsers.expat import ParserCreate
        HAS_FXP = False
    except ImportError:
        HAS_FXP = False

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

INVALID_IMAGE_URL_RE = re.compile(r"/\.[a-zA-Z]+(?:\?.*)?$")
JPEG_MAGIC = b"\xff\xd8\xff"


def parse_args():
    parser = argparse.ArgumentParser(description="Audit images across B2BMarkt pipeline stages")
    parser.add_argument("--feed", default=None, help="Feed name (symetron, main)")
    parser.add_argument("--xml", default=None, help="Path to XML file")
    parser.add_argument("--out-base", default="missing-products", help="Output base name")
    parser.add_argument("--category", default=None, help="Category name (for XML parsing)")
    parser.add_argument("--max-head", type=int, default=50, help="Max HEAD requests (default: 50)")
    return parser.parse_args()


def resolve_xml_path(feed, xml_arg):
    if xml_arg:
        return os.path.abspath(xml_arg)
    if feed:
        try:
            from subprocess import run, PIPE
            result = run(
                ["node", "scripts/resolve_b2bmarkt_feed.js", f"--feed={feed}"],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                return result.stdout.strip()
        except Exception:
            pass
    for candidate in ["symetron.xml", "b2bmarkt_updated.xml"]:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def extract_text(val):
    if val is None:
        return ""
    if isinstance(val, str):
        return val.strip()
    if isinstance(val, (int, float, bool)):
        return str(val)
    if isinstance(val, list):
        return extract_text(val[0]) if val else ""
    if isinstance(val, dict):
        return extract_text(val.get("#text") or val.get("__cdata") or "")
    return str(val).strip()


def find_product_array(node, product_tag):
    if not node or not isinstance(node, dict):
        return None
    for key, val in node.items():
        if key == product_tag:
            return val if isinstance(val, list) else [val]
        found = find_product_array(val, product_tag)
        if found:
            return found
    return None


def parse_xml_images(xml_path):
    """Parse XML and return {sku: [image_urls]}."""
    try:
        from xml.parsers.expat import ParserCreate
        return parse_xml_expat(xml_path)
    except Exception as e:
        print(f"WARNING: expat parser failed: {e}", file=sys.stderr)
        return {}


def parse_xml_expat(xml_path):
    """Use expat to parse XML and extract product images."""
    sku_images = OrderedDict()
    current_product = None
    current_images = None
    current_images_loc = False
    current_sku = None
    depth = 0
    image_tag_path = []

    def start_element(name, attrs):
        nonlocal current_product, current_images, current_images_loc, current_sku, depth
        depth += 1
        if name == "Product":
            current_product = {}
            current_images = []
            current_sku = None
            current_images_loc = False
        elif current_product is not None:
            if name == "ProductCode":
                pass  # will capture chars
            elif name == "ImagesLocation":
                current_images_loc = True
            elif name == "image" and current_images_loc:
                image_tag_path.append(depth)

    def end_element(name):
        nonlocal current_product, current_images, current_images_loc, current_sku, depth
        if name == "Product" and current_product is not None:
            if current_sku:
                sku_images[current_sku] = current_images[:]
            current_product = None
            current_images = None
            current_sku = None
            current_images_loc = False
        elif name == "ImagesLocation":
            current_images_loc = False
        elif name == "image" and image_tag_path and image_tag_path[-1] == depth:
            image_tag_path.pop()
        depth -= 1

    def char_data(data):
        nonlocal current_sku
        if current_product is not None:
            stripped = data.strip()
            if stripped:
                # Check if we're in ProductCode
                # We need to track which element we're in
                pass

    # Simpler approach: use regex on raw XML
    return parse_xml_regex(xml_path)


def parse_xml_regex(xml_path):
    """Use regex to extract SKU and image URLs from XML."""
    sku_images = OrderedDict()
    with open(xml_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Find all Product blocks
    product_pattern = re.compile(
        r"<Product>(.*?)</Product>",
        re.DOTALL
    )
    sku_pattern = re.compile(r"<ProductCode>(.*?)</ProductCode>")
    image_pattern = re.compile(r"<image>(.*?)</image>")

    for product_match in product_pattern.finditer(content):
        block = product_match.group(1)
        sku_match = sku_pattern.search(block)
        if not sku_match:
            continue
        sku = extract_text(sku_match.group(1))
        if not sku:
            continue
        images = []
        for img_match in image_pattern.finditer(block):
            url = extract_text(img_match.group(1))
            if url:
                images.append(url)
        sku_images[sku] = images

    return sku_images


def load_json_images(json_path):
    """Load images from exported/translated JSON."""
    sku_images = OrderedDict()
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for p in data.get("products", []):
            sku = p.get("sku", "")
            if not sku:
                continue
            images = p.get("images", [])
            if isinstance(images, str):
                images = [img.strip() for img in images.split(";") if img.strip()]
            sku_images[sku] = images
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"WARNING: Could not load {json_path}: {e}", file=sys.stderr)
    return sku_images


def load_csv_images(csv_path):
    """Load image rows from Shopify CSV. Returns {handle: [image_urls]}."""
    handle_images = OrderedDict()
    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                handle = row.get("Handle", "").strip()
                src = row.get("Image Src", "").strip()
                sku = row.get("Variant SKU", "").strip()
                if not handle:
                    continue
                if src:
                    handle_images.setdefault(handle, []).append(src)
                else:
                    handle_images.setdefault(handle, [])
                # Track SKU for handle
                if sku and handle not in getattr(load_csv_images, "_skus", {}):
                    if not hasattr(load_csv_images, "_skus"):
                        load_csv_images._skus = {}
                    load_csv_images._skus[handle] = sku
    except FileNotFoundError:
        pass
    return handle_images


def get_sku_for_handle(handle, json_path):
    """Get SKU from handle using JSON data."""
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for p in data.get("products", []):
            sku = p.get("sku", "")
            if sku and f"mc-{sku}" == handle.lower():
                return sku
    except Exception:
        pass
    return ""


def check_url(url, session):
    """HEAD request + optional GET for JPEG magic bytes."""
    result = {
        "url": url,
        "status": None,
        "content_type": None,
        "is_jpeg_magic": False,
        "error": None,
    }
    try:
        head = session.head(url, timeout=10, allow_redirects=True)
        result["status"] = head.status_code
        result["content_type"] = head.headers.get("Content-Type", "")
        # If content-type is not image/jpeg, check magic bytes
        if "image/jpeg" not in result["content_type"].lower():
            get_resp = session.get(url, timeout=10, stream=True)
            if get_resp.status_code == 200:
                chunk = get_resp.raw.read(3)
                if chunk == JPEG_MAGIC:
                    result["is_jpeg_magic"] = True
    except requests.RequestException as e:
        result["error"] = str(e)[:100]
    return result


def main():
    args = parse_args()
    out_base = args.out_base

    # Resolve XML
    xml_path = resolve_xml_path(args.feed, args.xml)
    if not xml_path or not os.path.isfile(xml_path):
        print(f"ERROR: XML file not found. Use --xml=path or --feed=name", file=sys.stderr)
        sys.exit(1)
    print(f"XML: {xml_path}")

    # File paths
    export_json = f"{out_base}.json"
    raw_csv = f"{out_base}-shopify-import.csv"
    clean_csv = f"{out_base}-shopify-import-clean.csv"

    # Parse all stages
    print("Parsing XML images...")
    xml_images = parse_xml_images(xml_path)
    print(f"  SKUs in XML: {len(xml_images)}")

    print(f"Loading JSON images ({export_json})...")
    json_images = load_json_images(export_json)
    print(f"  SKUs in JSON: {len(json_images)}")

    print(f"Loading raw Shopify CSV ({raw_csv})...")
    raw_csv_images = load_csv_images(raw_csv)
    print(f"  Handles in raw CSV: {len(raw_csv_images)}")

    print(f"Loading cleaned Shopify CSV ({clean_csv})...")
    clean_csv_images = load_csv_images(clean_csv)
    print(f"  Handles in clean CSV: {len(clean_csv_images)}")

    # Load source categories from JSON
    sku_categories = {}
    try:
        with open(export_json, "r", encoding="utf-8") as f:
            data = json.load(f)
        for p in data.get("products", []):
            sku = p.get("sku", "")
            if not sku:
                continue
            source_cat = p.get("source_category", "")
            if not source_cat:
                cats = p.get("categories", [])
                if cats:
                    last_cat = cats[-1]
                    if isinstance(last_cat, dict):
                        source_cat = last_cat.get("text", "")
                    else:
                        source_cat = str(last_cat)
            if source_cat:
                # Normalize [L] prefix
                source_cat = re.sub(r"^\[[Ll](?:[Ee][Vv][Ee][Ll])?\d*\]\s*", "", source_cat).strip()
            sku_categories[sku] = source_cat
    except Exception:
        pass

    # Build audit rows
    all_skus = set(xml_images.keys()) | set(json_images.keys())
    # Also get SKUs from CSV handles
    for handle in set(list(raw_csv_images.keys()) + list(clean_csv_images.keys())):
        sku = handle.replace("mc-", "") if handle.startswith("mc-") else ""
        if sku:
            all_skus.add(sku)

    # Collect invalid URLs for HEAD checks
    invalid_urls = set()
    for sku in all_skus:
        for url in json_images.get(sku, []):
            if INVALID_IMAGE_URL_RE.search(url):
                invalid_urls.add(url)

    # Limit HEAD requests
    invalid_urls = list(invalid_urls)[:args.max_head]
    url_checks = {}
    if invalid_urls:
        print(f"\nChecking {len(invalid_urls)} invalid URLs (HEAD + magic bytes)...")
        session = requests.Session()
        session.headers.update({"User-Agent": "Mozilla/5.0"})
        for i, url in enumerate(invalid_urls):
            result = check_url(url, session)
            url_checks[url] = result
            if (i + 1) % 10 == 0:
                print(f"  Checked {i + 1}/{len(invalid_urls)}")
        print(f"  Done.")

    # Build report
    os.makedirs("reports", exist_ok=True)
    report_path = f"reports/{out_base}-image-audit.csv"

    fields = [
        "SKU",
        "Handle",
        "Source Category",
        "XML Image Count",
        "JSON Image Count",
        "Raw CSV Image Rows",
        "Clean CSV Image Rows",
        "Invalid URLs Removed",
        "Valid URLs Remaining",
        "Ends With 0 Images",
        "Image Loss Stage",
        "Invalid URL Details",
    ]

    rows = []
    for sku in sorted(all_skus):
        handle = f"mc-{sku}"
        category = sku_categories.get(sku, "")

        xml_count = len(xml_images.get(sku, []))
        json_count = len(json_images.get(sku, []))
        raw_count = len(raw_csv_images.get(handle, []))
        clean_count = len(clean_csv_images.get(handle, []))

        # Count invalid URLs in JSON
        json_urls = json_images.get(sku, [])
        invalid_in_json = [u for u in json_urls if INVALID_IMAGE_URL_RE.search(u)]
        valid_in_json = [u for u in json_urls if not INVALID_IMAGE_URL_RE.search(u)]

        # Count invalid removed (those in raw but not in clean)
        raw_urls = set(raw_csv_images.get(handle, []))
        clean_urls = set(clean_csv_images.get(handle, []))
        removed_urls = raw_urls - clean_urls
        invalid_removed = [u for u in removed_urls if INVALID_IMAGE_URL_RE.search(u)]

        ends_zero = clean_count == 0

        # Determine loss stage
        loss_stages = []
        if xml_count > 0 and json_count < xml_count:
            loss_stages.append("export->JSON")
        if json_count > 0 and raw_count < min(json_count, 5):
            loss_stages.append("translation(limit=5)")
        if raw_count > 0 and clean_count < raw_count:
            loss_stages.append("cleaner")
        if xml_count > 0 and clean_count == 0:
            loss_stages.append("total-loss")
        loss_stage = "; ".join(loss_stages) if loss_stages else "none"

        # Invalid URL details
        url_details = []
        for url in invalid_in_json:
            check = url_checks.get(url, {})
            ct = check.get("content_type", "")
            is_jpeg = check.get("is_jpeg_magic", False)
            status = check.get("status", "")
            flag = "REAL-JPEG" if is_jpeg else ""
            url_details.append(f"{url} | CT={ct} | HTTP={status} | {flag}")

        rows.append({
            "SKU": sku,
            "Handle": handle,
            "Source Category": category,
            "XML Image Count": xml_count,
            "JSON Image Count": json_count,
            "Raw CSV Image Rows": raw_count,
            "Clean CSV Image Rows": clean_count,
            "Invalid URLs Removed": len(invalid_removed),
            "Valid URLs Remaining": clean_count,
            "Ends With 0 Images": "YES" if ends_zero else "NO",
            "Image Loss Stage": loss_stage,
            "Invalid URL Details": "; ".join(url_details),
        })

    with open(report_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    # Summary
    print(f"\n{'=' * 60}")
    print(f"  IMAGE AUDIT REPORT: {report_path}")
    print(f"{'=' * 60}")
    print()

    total_skus = len(rows)
    total_xml_imgs = sum(r["XML Image Count"] for r in rows)
    total_json_imgs = sum(r["JSON Image Count"] for r in rows)
    total_raw_imgs = sum(r["Raw CSV Image Rows"] for r in rows)
    total_clean_imgs = sum(r["Clean CSV Image Rows"] for r in rows)
    zero_img_products = [r for r in rows if r["Ends With 0 Images"] == "YES"]
    loss_products = [r for r in rows if r["Image Loss Stage"] != "none"]

    print(f"  Total products:          {total_skus}")
    print(f"  Total XML images:        {total_xml_imgs}")
    print(f"  Total JSON images:       {total_json_imgs}")
    print(f"  Total raw CSV rows:      {total_raw_imgs}")
    print(f"  Total clean CSV rows:    {total_clean_imgs}")
    print()
    print(f"  Products with 0 images:  {len(zero_img_products)}")
    for r in zero_img_products[:10]:
        print(f"    {r['SKU']} ({r['Handle']})  XML={r['XML Image Count']}  JSON={r['JSON Image Count']}  raw={r['Raw CSV Image Rows']}")
    print()
    print(f"  Products with image loss: {len(loss_products)}")
    # Group by loss stage
    from collections import Counter
    stage_counts = Counter()
    for r in loss_products:
        for stage in r["Image Loss Stage"].split("; "):
            if stage:
                stage_counts[stage] += 1
    for stage, count in stage_counts.most_common():
        print(f"    {stage}: {count} products")
    print()

    # Invalid URL analysis
    real_jpeg_count = sum(1 for c in url_checks.values() if c.get("is_jpeg_magic"))
    wrong_ct_count = sum(1 for c in url_checks.values() if c.get("content_type") and "image/jpeg" not in c.get("content_type", "").lower())

    print(f"  Invalid URLs checked:    {len(url_checks)}")
    print(f"    Real JPEG (wrong CT):  {real_jpeg_count}")
    print(f"    Wrong content-type:    {wrong_ct_count}")
    print()

    # Sample invalid URL details
    sample_invalids = [c for c in url_checks.values() if c.get("content_type")]
    if sample_invalids:
        print("  Sample invalid URL checks:")
        for c in sample_invalids[:5]:
            jpeg_flag = " [REAL JPEG]" if c.get("is_jpeg_magic") else ""
            print(f"    {c['url']}")
            print(f"      Content-Type: {c.get('content_type', 'N/A')}{jpeg_flag}")
            print(f"      HTTP Status:  {c.get('status', 'N/A')}")
        print()

    # Recommendation
    print("-" * 60)
    if total_xml_imgs > total_json_imgs:
        print("  FINDING: Export loses images (XML -> JSON)")
    if total_json_imgs > total_raw_imgs * 2:
        print("  FINDING: Translation limits images to 5 per product")
    if total_raw_imgs > total_clean_imgs:
        print(f"  FINDING: Cleaner removes {total_raw_imgs - total_clean_imgs} image rows (invalid URLs)")
    if real_jpeg_count > 0:
        print(f"  FINDING: {real_jpeg_count} invalid URLs are REAL JPEG files with wrong content-type")
        print("  RECOMMENDATION: B) Rehost images with correct image/jpeg content-type")
        print("    OR strip '/.jpg' from URL and try '-1.jpg' as fallback")
    print("-" * 60)
    print()
    print(f"  Full report: {report_path}")


if __name__ == "__main__":
    main()
