#!/usr/bin/env python3
"""Paginate all vendor:Mebelcenter variants."""
import json
import sys
import time

from shopify_cli import run

QUERY = open("mebelcenter_variants.graphql").read()

variants = []
cursor = None
page = 0
t0 = time.time()
consecutive_errors = 0

while True:
    page += 1
    try:
        data = run(QUERY, {"cursor": cursor})
        consecutive_errors = 0
    except Exception as e:
        err = str(e)
        is_throttle = "THROTTLED" in err or "rate-limit" in err or "Throttled" in err
        consecutive_errors += 1
        if consecutive_errors > 10:
            print(f"[page {page}] Too many errors: {err[:400]}", file=sys.stderr)
            break
        wait = 5 if is_throttle else 3
        print(f"[page {page}] {'THROTTLED' if is_throttle else 'ERROR'}, sleeping {wait}s. {err[:200]}", flush=True)
        time.sleep(wait)
        page -= 1
        continue

    pv = data.get("productVariants", data.get("data", {}).get("productVariants", {}))
    nodes = pv.get("nodes", [])
    for v in nodes:
        sku = (v.get("sku") or "").strip()
        inv_item = v.get("inventoryItem") or {}
        if not sku or not inv_item.get("id"):
            continue
        variants.append({
            "product_id": (v.get("product") or {}).get("id"),
            "product_title": (v.get("product") or {}).get("title"),
            "variant_id": v["id"],
            "sku": sku,
            "inventory_item_id": inv_item["id"],
            "tracked": inv_item.get("tracked"),
            "current_qty": v.get("inventoryQuantity"),
        })

    page_info = pv.get("pageInfo", {})
    elapsed = int(time.time() - t0)
    print(f"[page {page}] got {len(nodes)} variants | total {len(variants)} | {elapsed}s elapsed", flush=True)

    if not page_info.get("hasNextPage"):
        break
    cursor = page_info.get("endCursor")
    time.sleep(0.4)

with open("mebelcenter_variants.json", "w", encoding="utf-8") as f:
    json.dump(variants, f, ensure_ascii=False)

print(f"DONE. {len(variants)} variants saved to mebelcenter_variants.json")
