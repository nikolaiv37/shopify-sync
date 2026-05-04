#!/usr/bin/env python3
"""Paginate products(query:'vendor:Mebelcenter') selecting only IDs."""
import json
import sys
import time

from shopify_cli import run

QUERY = """
query vendorProducts($cursor: String) {
  products(first: 250, after: $cursor, query: "vendor:Mebelcenter") {
    pageInfo { hasNextPage endCursor }
    nodes { id vendor }
  }
}
""".strip()

ids = []
mismatched = 0
cursor = None
page = 0
t0 = time.time()
errors = 0

while True:
    page += 1
    try:
        data = run(QUERY, {"cursor": cursor})
    except Exception as e:
        errors += 1
        if errors > 10:
            print(f"Too many errors: {e}", file=sys.stderr); break
        print(f"[page {page}] ERROR: {str(e)[:200]}; retrying", flush=True)
        time.sleep(3)
        page -= 1
        continue

    pr = data.get("products", data.get("data", {}).get("products", {}))
    for p in pr.get("nodes", []):
        if p.get("vendor") != "Mebelcenter":
            mismatched += 1
            continue
        ids.append(p["id"])
    pi = pr.get("pageInfo", {})
    elapsed = int(time.time() - t0)
    print(f"[page {page}] total ids={len(ids)} mismatched={mismatched} elapsed={elapsed}s", flush=True)
    if not pi.get("hasNextPage"): break
    cursor = pi.get("endCursor")
    time.sleep(0.3)

with open("mebelcenter_product_ids.json", "w") as f:
    json.dump(ids, f)

print(f"DONE. {len(ids)} Mebelcenter product IDs saved")
