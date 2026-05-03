#!/usr/bin/env python3
"""
Translate missing Megapap products from English/Greek to Bulgarian.
Reads: missing-megapap-products.csv (or any CSV exported by export_missing_megapap_products.js)
Outputs:
  - <out-base>.json
  - <out-base>.csv
  - <out-base>-shopify-import.csv

Usage:
  python3 translate_megapap_missing.py --input=missing-megapap-batch-1.csv --model=openai/gpt-4.1-mini --fallback-model=openai/gpt-4o-mini --max-concurrency=1 --out-base=translated-megapap-batch-1
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import time
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


GREEK_RE = re.compile(r"[\u0391-\u03C9]")
CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")
ALLOW_LATIN = {"PVC", "MDF", "E1", "K/D", "YES", "NO", "LED", "SKU", "ABS", "PP", "PE", "RAL"}


DIAMETER_RE = re.compile(r"Φ\d+")


def contains_greek(text):
    if not isinstance(text, str):
        return False
    stripped = DIAMETER_RE.sub("", text)
    return bool(stripped and GREEK_RE.search(stripped))


def has_cyrillic(text):
    if not isinstance(text, str):
        return False
    return bool(text and CYRILLIC_RE.search(text))


def normalize_whitespace(text):
    if not isinstance(text, str):
        return ""
    return " ".join(text.split())


def to_str(val):
    """Safely convert any value to string. Dicts become JSON, lists become joined strings."""
    if val is None:
        return ""
    if isinstance(val, str):
        return val.strip()
    if isinstance(val, (int, float, bool)):
        return str(val)
    if isinstance(val, dict):
        return json.dumps(val, ensure_ascii=False)
    if isinstance(val, list):
        return "; ".join(str(v) for v in val)
    return str(val)


def hash_context(text):
    if text is None:
        text = ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def timestamp_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def extract_dimensions(text):
    pattern = r"\b\d+(?:[.,]\d+)?x\d+(?:[.,]\d+)?(?:x\d+(?:[.,]\d+)?)?(?:cm|mm)?\b"
    return re.findall(pattern, text or "", re.IGNORECASE)


def build_handle(bulgarian_title, sku):
    sku_clean = re.sub(r"[\s/]+", "-", sku.strip())
    return f"mc-{sku_clean}".lower()


class TranslationCache:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS translations (
                mode TEXT NOT NULL,
                primary_text TEXT NOT NULL,
                context_hash TEXT NOT NULL,
                translation TEXT NOT NULL,
                PRIMARY KEY (mode, primary_text, context_hash)
            )
            """
        )
        self._conn.commit()

    def get(self, mode, primary_text, context_text):
        context_hash = hash_context(context_text)
        with self._lock:
            cur = self._conn.execute(
                "SELECT translation FROM translations WHERE mode=? AND primary_text=? AND context_hash=?",
                (mode, primary_text, context_hash),
            )
            row = cur.fetchone()
            if row:
                return row[0], "exact"
            cur = self._conn.execute(
                "SELECT translation FROM translations WHERE mode=? AND primary_text=? LIMIT 1",
                (mode, primary_text),
            )
            row = cur.fetchone()
            if row:
                return row[0], "fallback"
        return None, "miss"

    def set(self, mode, primary_text, context_text, translation):
        context_hash = hash_context(context_text)
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO translations (mode, primary_text, context_hash, translation) VALUES (?, ?, ?, ?)",
                (mode, primary_text, context_hash, translation),
            )
            self._conn.commit()


class OpenRouterTranslator:
    def __init__(
        self,
        api_key,
        model,
        fallback_model,
        cache,
        max_concurrency,
        max_retries,
        retry_backoff,
        debug,
        debug_log_path,
        temperature=0.2,
    ):
        self.api_key = api_key
        self.model = model
        self.fallback_model = fallback_model or ""
        self.cache = cache
        self.max_concurrency = max_concurrency
        self.max_retries = max_retries
        self.retry_backoff = retry_backoff
        self.debug = debug
        self.debug_log_path = debug_log_path
        self._debug_logged = False
        self.temperature = temperature
        self.session = requests.Session()

    def translate_batch(self, mode, items):
        if not items:
            return {}, None, 0
        results = {}
        error_meta = {}
        to_translate = []
        for item in items:
            cached, hit_type = self.cache.get(
                mode, item["primary_text"], item.get("context_text", "")
            )
            if cached is not None:
                results[item["key"]] = cached
            else:
                to_translate.append(item)
        if not to_translate:
            return results, None, 0
        batch_result, reason, model_used, attempts = self._call_model(
            mode,
            [{"i": idx, "primary_text": it["primary_text"], "context_text": it.get("context_text", "")} for idx, it in enumerate(to_translate)],
        )
        if batch_result is None:
            for it in to_translate:
                results[it["key"]] = None
                error_meta[it["key"]] = {"reason": reason, "model": model_used, "attempts": attempts}
            return results, error_meta, attempts
        for idx, it in enumerate(to_translate):
            translated = batch_result.get(idx)
            if translated is not None:
                if not isinstance(translated, str):
                    translated = to_str(translated)
            if translated is not None and contains_greek(translated):
                repaired, _, repair_model, repair_attempts = self._call_model(
                    mode,
                    [{"i": 0, "primary_text": it["primary_text"], "context_text": it.get("context_text", "")}],
                    repair_reason="greek"
                )
                repaired_text = repaired.get(0) if repaired else None
                if repaired_text is not None:
                    if not isinstance(repaired_text, str):
                        repaired_text = to_str(repaired_text)
                if repaired_text is not None and not contains_greek(repaired_text):
                    translated = repaired_text
                    model_used = repair_model or model_used
                    attempts = repair_attempts or attempts
                else:
                    translated = None
            results[it["key"]] = translated
            if translated is not None:
                self.cache.set(mode, it["primary_text"], it.get("context_text", ""), translated)
            else:
                error_meta[it["key"]] = {"reason": reason or "greek_output", "model": model_used, "attempts": attempts}
        return results, error_meta, attempts

    def _call_model(self, mode, items, repair_reason=None):
        if not items:
            return {}, None, self.model, 0
        system_prompt = self._build_system_prompt(mode, repair_reason)
        payload = self._build_payload(mode, items, system_prompt)
        headers = self._build_headers()
        result, reason, attempts_used = self._call_with_retries(payload, headers, mode, items, repair_reason, self.model)
        if result is not None:
            return result, None, self.model, attempts_used
        if self.fallback_model:
            if self.debug:
                print(f"[DEBUG] FALLBACK: Using fallback model {self.fallback_model}")
            payload["model"] = self.fallback_model
            result, reason, attempts_used = self._call_with_retries(
                payload, headers, mode, items, repair_reason, self.fallback_model, max_attempts=1
            )
            if result is not None:
                return result, None, self.fallback_model, attempts_used
        return None, reason, self.fallback_model or self.model, attempts_used

    def _call_with_retries(self, payload, headers, mode, items, repair_reason, model_name, max_attempts=None):
        attempts = max_attempts if max_attempts is not None else self.max_retries
        last_reason = "unknown"
        attempts_used = 0
        retry_statuses = {429, 500, 502, 503, 504}
        for attempt in range(attempts):
            attempts_used = attempt + 1
            try:
                response = self.session.post(
                    "https://openrouter.ai/api/v1/chat/completions",
                    headers=headers,
                    json=payload,
                    timeout=90,
                )
                if response.status_code != 200:
                    last_reason = f"http_{response.status_code}"
                    if response.status_code in retry_statuses and attempt + 1 < attempts:
                        sleep_seconds = (self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25)
                        time.sleep(sleep_seconds)
                        continue
                    return None, last_reason, attempts_used
                try:
                    data = response.json()
                except Exception:
                    last_reason = "json_parse"
                    if attempt + 1 < attempts:
                        time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
                    continue
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
                try:
                    parsed = self._parse_content(content)
                except Exception:
                    last_reason = "json_parse"
                    if attempt + 1 < attempts:
                        time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
                    continue
                items_out = parsed.get("items")
                if not isinstance(items_out, list) or len(items_out) != len(items):
                    last_reason = "length_mismatch"
                    if attempt + 1 < attempts:
                        time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
                    continue
                mapped = {}
                for item in items_out:
                    if "i" not in item or "t" not in item:
                        raise ValueError("Missing keys")
                    idx = item["i"]
                    if isinstance(idx, str) and idx.isdigit():
                        idx = int(idx)
                    t_val = item["t"]
                    if not isinstance(t_val, str):
                        t_val = to_str(t_val)
                    mapped[idx] = t_val
                return mapped, None, attempts_used
            except requests.exceptions.RequestException:
                last_reason = "request_exception"
                if attempt + 1 < attempts:
                    time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
                    continue
                return None, last_reason, attempts_used
            except Exception:
                if last_reason == "unknown":
                    last_reason = "exception"
                if attempt + 1 < attempts:
                    time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
        return None, last_reason, attempts_used

    def _parse_content(self, content):
        if "```" in content:
            parts = content.split("```")
            content = "".join(part for idx, part in enumerate(parts) if idx % 2 == 1) or content
        content = content.strip()
        first = content.find("{")
        last = content.rfind("}")
        if first == -1 or last == -1 or last < first:
            raise ValueError("No JSON object")
        snippet = content[first : last + 1]
        return json.loads(snippet)

    def _build_payload(self, mode, items, system_prompt):
        return {
            "model": self.model,
            "temperature": self.temperature,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps({"mode": mode, "target_lang": "bg", "items": items}, ensure_ascii=False)},
            ],
        }

    def _build_headers(self):
        return {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": "https://openrouter.ai",
            "X-Title": "MebelCenter Megapap Translator",
            "Content-Type": "application/json",
        }

    def _build_system_prompt(self, mode, repair_reason=None):
        base = [
            "You are a professional e-commerce translation engine for Bulgarian furniture store MebelCenter.",
            "Translate ONLY primary_text into Bulgarian.",
            "Output Bulgarian only for the translation string.",
            "Do NOT translate: SKUs, barcodes, image URLs, dimension patterns (90x190cm, 120x60x75cm), units (cm, mm, kg), material codes (MDF, PVC, LED, ABS, PP, PE, RAL).",
            "Preserve HTML tags exactly.",
            "Remove the brand name 'Megapap' from any output.",
            "The Greek letter Φ (Phi) is a diameter symbol in dimensions like Φ62mm — keep it as-is, do NOT translate or remove it.",
            "Return only JSON: {\"items\":[{\"i\":0,\"t\":\"...\"}]}. No extra text.",
        ]
        if mode == "title":
            base.append("Title mode: SEO-friendly Bulgarian. Product type FIRST (e.g. 'Офис стол', 'Маса', 'Рафт', 'Полица', 'Стол', 'Фотьойл').")
            base.append("Remove model codes and supplier codes from output.")
            base.append("Keep useful dimensions like 90x190, 120x60.")
            base.append("Translate colors: white=бял, oak=дъб, walnut=орех, grey=сив, black=черен, natural=естествен.")
            base.append("Max ~70 characters. No Greek characters.")
            base.append("Keep standard abbreviations: MDF, PVC, LED, ABS, PP, PE, RAL.")
        elif mode == "description":
            base.append("Description mode: Premium Bulgarian e-commerce copy.")
            base.append("Output clean HTML with <p><strong>intro</strong></p> and <ul><li><strong>Label:</strong> value</li></ul>.")
            base.append("Do NOT invent features, materials, sizes, or functions.")
            base.append("Preserve all factual data: dimensions, materials, colors exactly.")
            base.append("No Greek characters. No untranslated English.")
        elif mode == "seo_title":
            base.append("SEO title: Bulgarian, under 70 chars. Product type + main feature + color/dimension if useful. No Greek.")
        elif mode == "seo_description":
            base.append("SEO description: Bulgarian, 140-160 chars. Persuasive but factual. No fake claims.")
        elif mode == "alt_text":
            base.append("Image alt text: Simple Bulgarian. Format: '[Product title] - снимка [number]'.")
        if repair_reason == "greek":
            base.append("REPAIR: Previous output had Greek letters. Ensure Bulgarian only, no Greek characters.")
        return "\n".join(base)


def translate_product(translator, product, idx):
    sku = to_str(product.get("sku", ""))
    title = to_str(product.get("title", ""))
    description = to_str(product.get("description", ""))
    category = to_str(product.get("category", ""))
    weight = to_str(product.get("weight_kg", ""))
    images_raw = product.get("images", "")
    if isinstance(images_raw, list):
        images = [to_str(img) for img in images_raw if to_str(img)]
    elif isinstance(images_raw, str):
        images = [img.strip() for img in images_raw.split(";") if img.strip()]
    else:
        images = []

    context_for_title = f"category={category}; weight={weight}kg"
    items = [
        {"key": "title", "primary_text": title, "context_text": context_for_title},
        {"key": "description", "primary_text": description, "context_text": f"title={title}"},
        {"key": "seo_title", "primary_text": title[:70], "context_text": f"title={title}"},
        {"key": "seo_description", "primary_text": f"{title[:50]} - {description[:100]}", "context_text": f"title={title}"},
    ]
    for i, img in enumerate(images[:5], 1):
        items.append({"key": f"alt_{i}", "primary_text": f"{title} - image {i}", "context_text": ""})

    results, errors, _ = translator.translate_batch("title", [it for it in items if it["key"] == "title"])
    results_desc, errors_desc, _ = translator.translate_batch("description", [it for it in items if it["key"] == "description"])
    results_seo_t, _, _ = translator.translate_batch("seo_title", [it for it in items if it["key"] == "seo_title"])
    results_seo_d, _, _ = translator.translate_batch("seo_description", [it for it in items if it["key"] == "seo_description"])
    results_alt, _, _ = translator.translate_batch("alt_text", [it for it in items if it["key"].startswith("alt_")])
    results.update(results_desc)
    results.update(results_seo_t)
    results.update(results_seo_d)
    results.update(results_alt)

    bg_title = results.get("title")
    if bg_title is not None and not isinstance(bg_title, str):
        bg_title = to_str(bg_title)
    if not bg_title or contains_greek(bg_title):
        bg_title = f"Продукт {sku}"
    bg_description = results.get("description") or ""
    if bg_description is not None and not isinstance(bg_description, str):
        bg_description = to_str(bg_description)
    if not bg_description or contains_greek(bg_description):
        bg_description = f"<p>{title}</p>"
    bg_seo_title = results.get("seo_title") or bg_title[:70]
    if bg_seo_title is not None and not isinstance(bg_seo_title, str):
        bg_seo_title = to_str(bg_seo_title)
    bg_seo_description = results.get("seo_description") or ""
    if bg_seo_description is not None and not isinstance(bg_seo_description, str):
        bg_seo_description = to_str(bg_seo_description)
    alt_texts = {}
    for i, img in enumerate(images[:5], 1):
        alt_texts[img] = results.get(f"alt_{i}") or f"{bg_title} - снимка {i}"

    return {
        "sku": sku,
        "supplier_sku": to_str(product.get("supplier_sku", "")),
        "ean": to_str(product.get("ean", "")),
        "title_original": title,
        "title_bg": (bg_title or "")[:70],
        "description_original": description,
        "description_bg": bg_description or "",
        "seo_title_bg": (bg_seo_title or bg_title or "")[:70],
        "seo_description_bg": (bg_seo_description or "")[:160],
        "category_original": category,
        "images": images,
        "alt_texts": alt_texts,
        "wholesale_price_without_vat": to_str(product.get("wholesale_price_without_vat", "")),
        "retail_price_with_vat": to_str(product.get("retail_price_with_vat", "")),
        "quantity": to_str(product.get("quantity", "")),
        "weight_kg": to_str(product.get("weight_kg", "")),
        "volume_m3": to_str(product.get("volume_m3", "")),
        "filters": to_str(product.get("filters", "")),
        "attributes": to_str(product.get("attributes", "")),
    }


def build_shopify_csv_row(translated):
    handle = build_handle(translated["title_bg"], translated["sku"])
    images = translated.get("images", [])
    rows = []
    for i, img in enumerate(images[:5], 1):
        row = {
            "Handle": handle,
            "Title": translated["title_bg"],
            "Body (HTML)": translated["description_bg"],
            "Vendor": "Mebelcenter",
            "Product Category": "",
            "Type": "",
            "Tags": "",
            "Published": "FALSE",
            "Option1 Name": "Title",
            "Option1 Value": "Default Title",
            "Variant SKU": translated["sku"],
            "Variant Inventory Tracker": "shopify",
            "Variant Inventory Qty": translated.get("quantity") or "0",
            "Variant Inventory Policy": "deny",
            "Variant Fulfillment Service": "manual",
            "Variant Price": "",
            "Variant Compare At Price": "",
            "Variant Requires Shipping": "TRUE",
            "Variant Taxable": "TRUE",
            "Variant Barcode": translated.get("ean", ""),
            "Image Src": img,
            "Image Position": str(i),
            "Image Alt Text": translated.get("alt_texts", {}).get(img, f"{translated['title_bg']} - снимка {i}"),
            "Gift Card": "FALSE",
            "SEO Title": translated["seo_title_bg"],
            "SEO Description": translated["seo_description_bg"],
            "Variant Weight Unit": "kg",
            "Variant Weight": "",
            "Status": "draft",
        }
        rows.append(row)
    if not images:
        row = {
            "Handle": handle,
            "Title": translated["title_bg"],
            "Body (HTML)": translated["description_bg"],
            "Vendor": "Mebelcenter",
            "Product Category": "",
            "Type": "",
            "Tags": "",
            "Published": "FALSE",
            "Option1 Name": "Title",
            "Option1 Value": "Default Title",
            "Variant SKU": translated["sku"],
            "Variant Inventory Tracker": "shopify",
            "Variant Inventory Qty": translated.get("quantity") or "0",
            "Variant Inventory Policy": "deny",
            "Variant Fulfillment Service": "manual",
            "Variant Price": "",
            "Variant Compare At Price": "",
            "Variant Requires Shipping": "TRUE",
            "Variant Taxable": "TRUE",
            "Variant Barcode": translated.get("ean", ""),
            "Image Src": "",
            "Image Position": "1",
            "Image Alt Text": "",
            "Gift Card": "FALSE",
            "SEO Title": translated["seo_title_bg"],
            "SEO Description": translated["seo_description_bg"],
            "Variant Weight Unit": "kg",
            "Variant Weight": "",
            "Status": "draft",
        }
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description="Translate Megapap missing products to Bulgarian")
    parser.add_argument("--input", required=True, help="Input CSV file")
    parser.add_argument("--model", default="openai/gpt-4.1-mini", help="OpenRouter model")
    parser.add_argument("--fallback-model", default="openai/gpt-4o-mini", help="Fallback model")
    parser.add_argument("--max-concurrency", type=int, default=1, help="Max concurrent translations")
    parser.add_argument("--max-retries", type=int, default=5, help="Max retries per request")
    parser.add_argument("--retry-backoff", type=float, default=1.5, help="Retry backoff multiplier")
    parser.add_argument("--limit-products", type=int, help="Limit number of products to process")
    parser.add_argument("--out-base", default="translated-megapap-products", help="Output base name")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY not set. Please export it or create a .env file.", file=sys.stderr)
        sys.exit(1)

    print(f"Model: {args.model}")
    print(f"Fallback: {args.fallback_model}")
    print(f"Concurrency: {args.max_concurrency}")
    print(f"Input: {args.input}")

    cache = TranslationCache("translation_megapap_cache.sqlite")
    translator = OpenRouterTranslator(
        api_key=api_key,
        model=args.model,
        fallback_model=args.fallback_model,
        cache=cache,
        max_concurrency=args.max_concurrency,
        max_retries=args.max_retries,
        retry_backoff=args.retry_backoff,
        debug=args.debug,
        debug_log_path="debug_megapap.log",
    )

    with open(args.input, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        products = list(reader)

    if args.limit_products:
        products = products[: args.limit_products]

    print(f"Products to translate: {len(products)}")

    translated_products = []
    errors_log = []

    with ThreadPoolExecutor(max_workers=args.max_concurrency) as executor:
        futures = {executor.submit(translate_product, translator, p, idx): (idx, p) for idx, p in enumerate(products)}
        for future in as_completed(futures):
            idx, product = futures[future]
            try:
                result = future.result()
                translated_products.append(result)
                print(f"  [{idx + 1}/{len(products)}] SKU {result['sku']}: OK")
            except Exception as e:
                errors_log.append({"sku": product.get("sku", ""), "error": str(e)})
                print(f"  [{idx + 1}/{len(products)}] SKU {product.get('sku', '')}: ERROR - {e}")

    print(f"\nTranslated: {len(translated_products)}")
    if errors_log:
        print(f"Errors: {len(errors_log)}")
        with open("translate_megapap_errors.log", "w", encoding="utf-8") as f:
            for err in errors_log:
                f.write(json.dumps(err, ensure_ascii=False) + "\n")

    export_data = {
        "exported_at": timestamp_now(),
        "source": args.input,
        "total_translated": len(translated_products),
        "products": translated_products,
    }

    json_path = f"{args.out_base}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(export_data, f, ensure_ascii=False, indent=2)
    print(f"Exported: {json_path}")

    csv_path = f"{args.out_base}.csv"
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        fieldnames = ["sku", "supplier_sku", "ean", "title_original", "title_bg", "description_original", "description_bg", "seo_title_bg", "seo_description_bg", "category_original", "wholesale_price_without_vat", "retail_price_with_vat", "quantity", "weight_kg", "volume_m3", "images"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for p in translated_products:
            row = {k: p.get(k, "") for k in fieldnames}
            row["images"] = "; ".join(p.get("images", []))
            writer.writerow(row)
    print(f"Exported: {csv_path}")

    shopify_rows = []
    for p in translated_products:
        shopify_rows.extend(build_shopify_csv_row(p))

    shopify_fieldnames = ["Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Inventory Tracker", "Variant Inventory Qty", "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price", "Variant Compare At Price", "Variant Requires Shipping", "Variant Taxable", "Variant Barcode", "Image Src", "Image Position", "Image Alt Text", "Gift Card", "SEO Title", "SEO Description", "Variant Weight Unit", "Variant Weight", "Status"]
    shopify_path = f"{args.out_base}-shopify-import.csv"
    with open(shopify_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=shopify_fieldnames)
        writer.writeheader()
        for row in shopify_rows:
            writer.writerow(row)
    print(f"Exported: {shopify_path}")

    print("\nDone!")


if __name__ == "__main__":
    main()
