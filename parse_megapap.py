#!/usr/bin/env python3
"""Parse megapap_en.xml into {SKU: {stock, name}}. SKU = <model> tag."""
import json
import xml.etree.ElementTree as ET

out = {}
context = ET.iterparse("megapap_en.xml", events=("end",))
dupes = 0
for _, elem in context:
    if elem.tag == "product":
        sku = (elem.findtext("model") or "").strip()
        qty_raw = (elem.findtext("quantity") or "0").strip()
        name = (elem.findtext("name") or "").strip()
        try:
            qty = int(float(qty_raw))
        except ValueError:
            qty = 0
        if sku:
            if sku in out:
                dupes += 1
            out[sku] = {"stock": qty, "name": name}
        elem.clear()

with open("megapap_all.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)

print(f"Parsed {len(out)} unique SKUs (duplicates collapsed: {dupes})")
