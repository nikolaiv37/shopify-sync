#!/usr/bin/env python3
"""Parse b2bmarkt.xml and emit (SKU, Name, Stock) for the first N products."""
import json
import sys
import xml.etree.ElementTree as ET

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 50

products = []
context = ET.iterparse("b2bmarkt.xml", events=("end",))
for _, elem in context:
    if elem.tag == "Product":
        sku = (elem.findtext("ProductCode") or "").strip()
        name = (elem.findtext("Name") or "").strip()
        stock_raw = (elem.findtext("Stock") or "0").strip()
        try:
            stock = int(float(stock_raw))
        except ValueError:
            stock = 0
        if sku:
            products.append({"sku": sku, "name": name, "stock": stock})
        elem.clear()
        if len(products) >= LIMIT:
            break

print(json.dumps(products, ensure_ascii=False, indent=2))
