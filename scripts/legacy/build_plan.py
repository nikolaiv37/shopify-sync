#!/usr/bin/env python3
"""Match Europe variants to supplier SKUs and build an update plan."""
import json

with open("supplier_all.json", encoding="utf-8") as f:
    supplier = json.load(f)  # {sku: {stock, name}}

with open("europe_variants.json", encoding="utf-8") as f:
    variants = json.load(f)

matched = []
no_match = []
untracked = []
no_change = []

for v in variants:
    sku = v["sku"]
    supp = supplier.get(sku)
    if supp is None:
        no_match.append(v)
        continue
    if not v.get("tracked"):
        untracked.append(v)
        continue
    new_qty = supp["stock"]
    cur_qty = v.get("current_qty") or 0
    if cur_qty == new_qty:
        no_change.append(v)
        continue
    matched.append({
        "sku": sku,
        "variant_id": v["variant_id"],
        "product_title": v["product_title"],
        "inventory_item_id": v["inventory_item_id"],
        "current": cur_qty,
        "new": new_qty,
        "delta": new_qty - cur_qty,
    })

with open("update_plan.json", "w", encoding="utf-8") as f:
    json.dump(matched, f, ensure_ascii=False)

total_variants = len(variants)
unique_skus = {v["sku"] for v in variants}
matched_unique_skus = {m["sku"] for m in matched}

print(f"Europe variants total:        {total_variants} ({len(unique_skus)} unique SKUs)")
print(f"Not in supplier XML:          {len(no_match)} (will be skipped)")
print(f"Supplier match, untracked:    {len(untracked)} (inventory not tracked, skipped)")
print(f"Supplier match, no change:    {len(no_change)}")
print(f"Supplier match, TO UPDATE:    {len(matched)} ({len(matched_unique_skus)} unique SKUs)")
print()

if matched:
    increases = [m for m in matched if m["delta"] > 0]
    decreases = [m for m in matched if m["delta"] < 0]
    print(f"  increases: {len(increases)} (sum +{sum(m['delta'] for m in increases)})")
    print(f"  decreases: {len(decreases)} (sum {sum(m['delta'] for m in decreases)})")
    print()
    print("Top 10 increases:")
    for m in sorted(matched, key=lambda x: -x["delta"])[:10]:
        print(f"  {m['sku']:<10} {m['current']:>6} -> {m['new']:>6} ({m['delta']:+d})  {m['product_title'][:60]}")
    print("Top 10 decreases:")
    for m in sorted(matched, key=lambda x: x["delta"])[:10]:
        print(f"  {m['sku']:<10} {m['current']:>6} -> {m['new']:>6} ({m['delta']:+d})  {m['product_title'][:60]}")
