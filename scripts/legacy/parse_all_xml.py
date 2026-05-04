#!/usr/bin/env python3
"""Parse b2bmarkt.xml in full into {SKU: stock} JSON."""
import json
import xml.etree.ElementTree as ET

out = {}
context = ET.iterparse("b2bmarkt.xml", events=("end",))
dupes = 0
for _, elem in context:
    if elem.tag == "Product":
        sku = (elem.findtext("ProductCode") or "").strip()
        stock_raw = (elem.findtext("Stock") or "0").strip()
        name = (elem.findtext("Name") or "").strip()
        try:
            stock = int(float(stock_raw))
        except ValueError:
            stock = 0
        if sku:
            if sku in out:
                dupes += 1
            out[sku] = {"stock": stock, "name": name}
        elem.clear()

with open("supplier_all.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)

print(f"Parsed {len(out)} unique SKUs (duplicates collapsed: {dupes})")
