#!/usr/bin/env python3
"""Build megapap → Mebelcenter inventory plan."""
import json

with open("megapap_all.json", encoding="utf-8") as f:
    supplier = json.load(f)

with open("mebelcenter_variants.json", encoding="utf-8") as f:
    all_variants = json.load(f)

with open("mebelcenter_product_ids.json") as f:
    mebel_ids = set(json.load(f))

# Filter to only variants belonging to Mebelcenter vendor products.
variants = [v for v in all_variants if v["product_id"] in mebel_ids]

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

with open("megapap_update_plan.json", "w", encoding="utf-8") as f:
    json.dump(matched, f, ensure_ascii=False)

total_shop = len(all_variants)
mebel_variants = len(variants)
unique_skus = {v["sku"] for v in variants}
matched_unique_skus = {m["sku"] for m in matched}

print(f"All variants on store:           {total_shop}")
print(f"Filtered to Mebelcenter vendor:  {mebel_variants} ({len(unique_skus)} unique SKUs)")
print(f"Supplier SKUs in megapap.xml:    {len(supplier)}")
print()
print(f"Not in megapap XML:              {len(no_match)} (skipped)")
print(f"Match but untracked inventory:   {len(untracked)} (skipped)")
print(f"Match but no change:             {len(no_change)}")
print(f"Match + TO UPDATE:               {len(matched)} ({len(matched_unique_skus)} unique SKUs)")
print()

if matched:
    incr = [m for m in matched if m["delta"] > 0]
    decr = [m for m in matched if m["delta"] < 0]
    print(f"  increases: {len(incr)} (sum +{sum(m['delta'] for m in incr)})")
    print(f"  decreases: {len(decr)} (sum {sum(m['delta'] for m in decr)})")
    print()
    print("Top 10 increases:")
    for m in sorted(matched, key=lambda x: -x["delta"])[:10]:
        print(f"  {m['sku']:<10} {m['current']:>6} -> {m['new']:>6} ({m['delta']:+d})  {m['product_title'][:60]}")
    print()
    print("Top 10 decreases:")
    for m in sorted(matched, key=lambda x: x["delta"])[:10]:
        print(f"  {m['sku']:<10} {m['current']:>6} -> {m['new']:>6} ({m['delta']:+d})  {m['product_title'][:60]}")
