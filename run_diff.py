#!/usr/bin/env python3
"""Fetch current Shopify inventory for the first 50 supplier SKUs and print a diff."""
import json
import re
import subprocess
import sys

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")

def extract_json(text: str) -> dict:
    text = ANSI_RE.sub("", text)
    # Find the last balanced JSON object in the output.
    depth = 0
    start = -1
    best = None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                best = text[start : i + 1]
    if best is None:
        raise ValueError(f"No JSON found in output. Got: {text[:500]}")
    return json.loads(best)

STORE = "mebel-center.myshopify.com"
QUERY = """
query variantsBySku($query: String!) {
  productVariants(first: 100, query: $query) {
    nodes {
      sku
      inventoryQuantity
      product { title }
    }
  }
}
""".strip()

with open("supplier_first50.json") as f:
    supplier = json.load(f)

# Build SKU filter: sku:A OR sku:B OR ... — batch in groups of 20 to stay within query length limits.
def chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]

shopify_by_sku: dict[str, dict] = {}

for batch in chunks(supplier, 20):
    q = " OR ".join(f"sku:{p['sku']}" for p in batch)
    variables = json.dumps({"query": q})
    cmd = [
        "shopify", "store", "execute",
        "--store", STORE,
        "--query", QUERY,
        "--variables", variables,
        "--json",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print("ERROR:", res.stderr or res.stdout, file=sys.stderr)
        sys.exit(1)
    payload = extract_json(res.stdout)
    data = payload.get("data", payload)
    nodes = data.get("productVariants", {}).get("nodes", [])
    for n in nodes:
        sku = (n.get("sku") or "").strip()
        if not sku:
            continue
        shopify_by_sku[sku] = {
            "title": n.get("product", {}).get("title", ""),
            "inv": n.get("inventoryQuantity"),
        }

# Render diff table.
rows = []
for p in supplier:
    sku = p["sku"]
    new_inv = p["stock"]
    match = shopify_by_sku.get(sku)
    if match is None:
        rows.append((sku, p["name"][:50], "NOT FOUND", new_inv, "-"))
    else:
        cur = match["inv"] if match["inv"] is not None else 0
        change = new_inv - cur
        change_str = ("+" if change > 0 else "") + str(change) if change != 0 else "0"
        rows.append((sku, (match["title"] or p["name"])[:50], cur, new_inv, change_str))

# Print
hdr = ("SKU", "Product Name", "Current", "New", "Change")
widths = [12, 52, 12, 6, 8]
def fmt(row):
    return " | ".join(str(c).ljust(w) for c, w in zip(row, widths))

print(fmt(hdr))
print("-+-".join("-" * w for w in widths))
for r in rows:
    print(fmt(r))

# Summary
matched = sum(1 for r in rows if r[2] != "NOT FOUND")
changed = sum(1 for r in rows if r[4] not in ("0", "-"))
print()
print(f"Matched on Shopify: {matched}/{len(rows)}")
print(f"Rows with inventory change: {changed}")
