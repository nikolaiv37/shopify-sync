#!/usr/bin/env python3
"""
Translate missing B2BMarkt kids room products from Greek to Bulgarian.
Reads: missing-products-kids-room.csv
Outputs:
  - translated-kids-room-products.json
  - translated-kids-room-products.csv
  - shopify-kids-room-import.csv

Usage:
  python3 translate_b2bmarkt_missing.py --input missing-products-kids-room.csv --model google/gemma-4-31b-it --fallback-model openai/gpt-4.1-mini --max-concurrency 1 --limit-products 3
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
ALLOW_LATIN = {"PVC", "MDF", "E1", "K/D", "YES", "NO", "LED", "HM", "SKU"}

# Shopify supports up to 10 images per product
MAX_SHOPIFY_IMAGES = 10

# Map B2BMarkt Greek category names to Bulgarian tags/types
CATEGORY_TAG_MAP = {
    "Παιδικό δωμάτιο": "Детска стая",
    "Σαλόνια - γωνίες": "Ъглови дивани",
    "Κρεβάτια": "Легла",
    "Τραπέζια": "Маси",
    "Καρέκλες - Πολυθρόνες": "Столове и фотьойли",
    "Φωτισμός": "Осветление",
    "Έπιπλα γραφείου": "Офис мебели",
    "Διακόσμηση": "Декорация",
}


def resolve_category_tag(greek_category, fallback=""):
    """Map a Greek B2BMarkt category to a Bulgarian tag. Returns empty string if unknown."""
    return CATEGORY_TAG_MAP.get(greek_category, fallback)


def ensure_text(val):
    """Coerce any LLM-derived value into a safe string.

    Handles: str -> as-is; None -> ""; dict/list -> json-dumped (lossless);
    single-key dict whose value is a string -> the inner string; anything else -> str(val).
    """
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    if isinstance(val, dict):
        if len(val) == 1:
            only = next(iter(val.values()))
            if isinstance(only, str):
                return only
        try:
            return json.dumps(val, ensure_ascii=False)
        except Exception:
            return str(val)
    if isinstance(val, list):
        if len(val) == 1 and isinstance(val[0], str):
            return val[0]
        try:
            return json.dumps(val, ensure_ascii=False)
        except Exception:
            return str(val)
    return str(val)


def contains_greek(text):
    text = ensure_text(text)
    return bool(text and GREEK_RE.search(text))


def has_cyrillic(text):
    return bool(text and CYRILLIC_RE.search(text))


def normalize_whitespace(text):
    return " ".join((text or "").split())


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
            if translated is not None and contains_greek(translated):
                repaired, _, repair_model, repair_attempts = self._call_model(
                    mode,
                    [{"i": 0, "primary_text": it["primary_text"], "context_text": it.get("context_text", "")}],
                    repair_reason="greek"
                )
                repaired_text = repaired.get(0) if repaired else None
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
                        # Some models return `t` as an object/array instead of a string.
                        # Coerce so downstream regex/contains_greek checks don't crash.
                        if isinstance(t_val, dict) and len(t_val) == 1:
                            only = next(iter(t_val.values()))
                            t_val = only if isinstance(only, str) else json.dumps(t_val, ensure_ascii=False)
                        elif isinstance(t_val, list) and len(t_val) == 1 and isinstance(t_val[0], str):
                            t_val = t_val[0]
                        else:
                            t_val = json.dumps(t_val, ensure_ascii=False)
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
            "X-Title": "MebelCenter B2BMarkt Translator",
            "Content-Type": "application/json",
        }

    def _build_system_prompt(self, mode, repair_reason=None):
        base = [
            "You are a professional e-commerce translation engine for Bulgarian furniture store MebelCenter.",
            "Translate ONLY primary_text into Bulgarian.",
            "Output Bulgarian only for the translation string.",
            "Do NOT translate: SKUs, barcodes, image URLs, dimension patterns (90x190cm, 120x60x75cm), units (cm, mm, kg), material codes (MDF, PVC, LED).",
            "Preserve HTML tags exactly.",
            "Return only JSON: {\"items\":[{\"i\":0,\"t\":\"...\"}]}. No extra text.",
        ]
        if mode == "title":
            base.append("Title mode: SEO-friendly Bulgarian. Product type FIRST (e.g. 'Детско легло', 'Детски гардероб', 'Бюро', 'Скрин', 'Етажерка', 'Нощно шкафче').")
            base.append("Remove model codes (HM739.03, etc.) from output.")
            base.append("Keep useful dimensions like 90x190, 120x60.")
            base.append("Translate colors: white=бял, oak=дъб, walnut=орех, grey=сив, black=черен, natural=естествен.")
            base.append("Max ~70 characters. No Greek characters.")
            base.append("Keep standard abbreviations: MDF, PVC, LED.")
        elif mode == "description":
            base.append("Description mode: Premium Bulgarian e-commerce copy.")
            base.append("Output clean HTML with <p><strong>intro</strong></p> and <ul><li><strong>Label:</strong> value</li></ul>.")
            base.append("Do NOT invent features, materials, sizes, or functions.")
            base.append("Preserve all factual data: dimensions, materials, colors exactly.")
            base.append("No Greek characters. No untranslated English.")
        elif mode == "seo_title":
            base.append("SEO title: Bulgarian, under 70 chars. Product type + main feature + color/dimension if useful. No Greek.")
        elif mode == "seo_description":
            base.append("SEO description: Bulgarian, 140-160 chars. Persuasive but factual. Mention MebelCenter/online order only if natural. No fake claims.")
        elif mode == "alt_text":
            base.append("Image alt text: Simple Bulgarian. Format: '[Product title] - снимка [number]'.")
        elif mode == "feed_copy":
            base.append("Feed copy mode: input primary_text is a JSON string with keys: title, description, category, dimensions (any language; usually Greek).")
            base.append("Return the translation/adaptation as a JSON-encoded STRING with this exact shape:")
            base.append('{"title_bg":"...","seo_title_bg":"...","seo_description_bg":"...","description_bg":"..."}')
            base.append("That JSON object MUST be returned as the value of `t` (a string), inside the outer wrapper {\"items\":[{\"i\":0,\"t\":\"<json-string>\"}]}.")
            base.append("title_bg: Bulgarian, SEO-friendly, product type first, max ~70 chars, no Greek, no model codes (HM10887.11 etc).")
            base.append("seo_title_bg: Bulgarian, max 70 chars, product type + main feature + dimension/color if useful.")
            base.append("seo_description_bg: Bulgarian, 140-160 chars, persuasive but factual. No fake claims.")
            base.append("description_bg: Bulgarian clean HTML — '<p><strong>intro</strong></p><ul><li><strong>Label:</strong> value</li></ul>'.")
            base.append("Adapt the source description: keep dimensions, materials, colors, maintenance instructions EXACTLY. Do NOT invent features.")
            base.append("Preserve HTML <br> by converting to <p>/<li> structure. No Greek characters anywhere in the output.")
            base.append("Translate colors: white=бял, oak=дъб, walnut=орех, grey=сив, black=черен, natural=естествен.")
            base.append("Keep MDF, PVC, LED, dimensions like 90x190, 120x60.")
        elif mode == "fast_copy":
            base.append("Fast copy mode: translate the source title into Bulgarian and produce SEO copy in ONE pass.")
            base.append("Return primary_text's translation as a JSON-encoded STRING with this exact shape:")
            base.append('{"title_bg":"...","seo_title_bg":"...","seo_description_bg":"..."}')
            base.append("That JSON object MUST be returned as the value of `t` (a string), inside the outer wrapper {\"items\":[{\"i\":0,\"t\":\"<json-string>\"}]}.")
            base.append("title_bg: Bulgarian, SEO-friendly, product type first, max ~70 chars, no Greek, no model codes.")
            base.append("seo_title_bg: Bulgarian, max 70 chars, product type + main feature + dimension/color if useful.")
            base.append("seo_description_bg: Bulgarian, 140-160 chars, persuasive but factual. No fake claims.")
            base.append("Translate colors: white=бял, oak=дъб, walnut=орех, grey=сив, black=черен, natural=естествен.")
            base.append("Keep dimensions like 90x190, 120x60. Keep MDF, PVC, LED.")
        if repair_reason == "greek":
            base.append("REPAIR: Previous output had Greek letters. Ensure Bulgarian only, no Greek characters.")
        return "\n".join(base)


def extract_source_category(categories_str):
    """Extract the most specific (last) source category from a categories string.
    Format: '[L1] Parent > [L2] Child' -> returns 'Child'
    """
    if not categories_str:
        return ""
    parts = categories_str.split(" > ")
    if not parts:
        return ""
    last_part = parts[-1].strip()
    # Remove [Lx] prefix
    return re.sub(r"\[L\d+\]\s*", "", last_part).strip()


def _build_fast_description_bg(bg_title, source_category, dimensions, title_orig):
    """Construct a short Bulgarian product description locally — no LLM call.

    Uses the Bulgarian title + (optionally) Bulgarian category + dimensions found
    in the original title (e.g. "150x55.5x240Hcm"). Output is short clean HTML
    matching the same shape the LLM description prompt asked for.
    """
    dims = extract_dimensions(title_orig or "")
    dim_line = dims[0] if dims else (dimensions or "")
    bullets = []
    if source_category:
        bullets.append(f"<li><strong>Категория:</strong> {source_category}</li>")
    if dim_line:
        bullets.append(f"<li><strong>Размери:</strong> {dim_line}</li>")
    bullets.append("<li><strong>Доставка:</strong> от MebelCenter</li>")
    return (
        f"<p><strong>{bg_title}</strong></p>"
        f"<ul>{''.join(bullets)}</ul>"
    )


def translate_product_fast(translator, product, idx, category_tag=""):
    """Fast path: 1 OpenRouter call for title + seo_title + seo_description.

    - Skips the full HTML description LLM call (generated locally).
    - Skips per-image alt LLM call (reuses Bulgarian title).
    - Output shape identical to translate_product() so the existing Shopify CSV
      builder and clean step keep working unchanged.
    """
    sku = product.get("sku", "")
    title = product.get("title", "")
    description = product.get("description", "")
    categories = product.get("categories", "")
    dimensions = product.get("dimensions", "")
    images_str = product.get("images", "")
    images = [img.strip() for img in images_str.split(";") if img.strip()] if images_str else []
    source_category = extract_source_category(categories)

    items = [{
        "key": "copy",
        "primary_text": title,
        "context_text": f"category={source_category}; dimensions={dimensions}",
    }]
    results, errors, _ = translator.translate_batch("fast_copy", items)
    raw = ensure_text(results.get("copy"))

    bg_title = ""
    bg_seo_title = ""
    bg_seo_description = ""
    try:
        parsed = json.loads(raw) if raw else {}
        if isinstance(parsed, dict):
            bg_title = ensure_text(parsed.get("title_bg", ""))
            bg_seo_title = ensure_text(parsed.get("seo_title_bg", ""))
            bg_seo_description = ensure_text(parsed.get("seo_description_bg", ""))
    except Exception:
        pass

    if not bg_title or contains_greek(bg_title):
        bg_title = (raw[:70] or f"Продукт {sku}")
    if not bg_seo_title or contains_greek(bg_seo_title):
        bg_seo_title = bg_title[:70]
    if not bg_seo_description or contains_greek(bg_seo_description):
        bg_seo_description = bg_title[:160]

    # Local description — no LLM call
    bg_description = _build_fast_description_bg(bg_title, source_category, dimensions, title)
    # Reuse Bulgarian title as alt text — no LLM call
    alt_texts = {img: f"{bg_title} - снимка {i}" for i, img in enumerate(images[:MAX_SHOPIFY_IMAGES], 1)}

    bg_categories = categories.replace("Παιδικό δωμάτιο", "Детска стая")
    tags = [category_tag] if category_tag else []

    return {
        "sku": sku,
        "title_original": title,
        "title_bg": bg_title[:70],
        "description_original": description,
        "description_bg": bg_description,
        "seo_title_bg": bg_seo_title[:70],
        "seo_description_bg": bg_seo_description[:160],
        "categories_bg": bg_categories,
        "source_category": source_category,
        "tags": tags,
        "images": images,
        "alt_texts": alt_texts,
        "price_retail": product.get("retail_price", ""),
        "price_wholesale": product.get("wholesale_price", ""),
        "price_market": product.get("market_price", ""),
        "stock": product.get("stock", ""),
        "barcode": product.get("barcode", ""),
        "dimensions": dimensions,
        "weight_kg": product.get("weight_kg", ""),
        "item_code": product.get("item_code", ""),
        "_mode": "fast",
    }


FEED_COPY_KEYS = ("title_bg", "seo_title_bg", "seo_description_bg", "description_bg")


def _parse_feed_copy_response(raw):
    """Robustly extract the four BG fields from a feed_copy LLM response.

    Handles every malformed shape observed so far:
      • raw is a JSON string of `{title_bg,...}`
      • raw is a JSON string of `{title_bg,...}` wrapped inside another JSON string (one or more levels)
      • raw is a dict with the four keys
      • raw is a dict with a single key whose value is the real payload (dict or JSON string)
      • raw is truncated or otherwise unparseable → fall back to per-field regex extraction
    Returns a dict with all four keys present (values may be ""), guaranteeing strings.
    """
    out = {k: "" for k in FEED_COPY_KEYS}
    if not raw:
        return out

    # Try up to 3 unwrap passes (handles nested string/dict wrappers).
    candidate = raw
    for _ in range(3):
        if isinstance(candidate, str):
            stripped = candidate.strip()
            if not stripped:
                break
            try:
                candidate = json.loads(stripped)
                continue
            except Exception:
                break
        if isinstance(candidate, dict):
            # Unwrap a single-key wrapper whose value is another payload
            if len(candidate) == 1 and not any(k in candidate for k in FEED_COPY_KEYS):
                only = next(iter(candidate.values()))
                if isinstance(only, (dict, str)):
                    candidate = only
                    continue
            break
        break

    if isinstance(candidate, dict):
        for k in FEED_COPY_KEYS:
            v = candidate.get(k, "")
            out[k] = ensure_text(v)
    else:
        # Last resort: regex-extract each field from the raw blob.
        # Matches: "title_bg":"<value>" allowing escaped quotes inside.
        for k in FEED_COPY_KEYS:
            m = re.search(rf'"{k}"\s*:\s*"((?:[^"\\]|\\.)*)"', raw, re.DOTALL)
            if m:
                try:
                    out[k] = json.loads(f'"{m.group(1)}"')
                except Exception:
                    out[k] = m.group(1)

    return out


def _is_invalid_bg_text(val):
    """Reject obvious JSON-leak or wrapper-leak content for short fields."""
    if not val:
        return True
    s = val.strip()
    if not s:
        return True
    if s.startswith("{") or s.startswith("["):
        return True
    # If the literal field-name keys leaked into the value, it's broken.
    if any(k in s for k in FEED_COPY_KEYS):
        return True
    return False


def _looks_like_html(val):
    if not val:
        return False
    s = val.strip()
    if not s:
        return False
    # Loose check: at least one common opening tag we asked for.
    return bool(re.search(r"<(?:p|ul|li|strong|br)\b", s, re.IGNORECASE))


def translate_product_feed_copy(translator, product, idx, category_tag=""):
    """Single-call mode for feed-sourced products.

    Sends title + description + category + dimensions to the LLM in ONE call and
    receives title_bg / seo_title_bg / seo_description_bg / description_bg.

    - 1 LLM call/product (vs. 5+ in default mode)
    - No per-image alt LLM call — alt text reuses bg_title
    - Output shape identical to translate_product() so the existing Shopify CSV
      builder and clean step keep working unchanged.
    """
    sku = product.get("sku", "")
    title = product.get("title", "")
    description = product.get("description", "") or ""
    categories = product.get("categories", "")
    dimensions = product.get("dimensions", "")
    images_str = product.get("images", "")
    images = [img.strip() for img in images_str.split(";") if img.strip()] if images_str else []
    source_category = extract_source_category(categories)

    # Cap to keep prompt under ~4KB. Real feed descriptions rarely exceed this.
    desc_cap = description[:3000]

    primary_payload = json.dumps({
        "title": title,
        "description": desc_cap,
        "category": source_category,
        "dimensions": dimensions or "",
    }, ensure_ascii=False)

    items = [{
        "key": "copy",
        "primary_text": primary_payload,
        "context_text": f"sku={sku}",
    }]
    results, errors, _ = translator.translate_batch("feed_copy", items)
    raw = ensure_text(results.get("copy"))

    parsed = _parse_feed_copy_response(raw)
    bg_title = parsed["title_bg"]
    bg_seo_title = parsed["seo_title_bg"]
    bg_seo_description = parsed["seo_description_bg"]
    bg_description = parsed["description_bg"]

    # Validation — if the model leaked the wrapper into a short field, treat that
    # field as failed so the cleaner's review-bucket logic catches it.
    if contains_greek(bg_title) or _is_invalid_bg_text(bg_title):
        # Deterministic, cleaner-recognised fallback (matches FALLBACK_TITLE_RE).
        bg_title = f"Продукт {sku}"
    if contains_greek(bg_seo_title) or _is_invalid_bg_text(bg_seo_title):
        bg_seo_title = bg_title[:70]
    if contains_greek(bg_seo_description) or _is_invalid_bg_text(bg_seo_description):
        bg_seo_description = bg_title[:160]
    if contains_greek(bg_description) or _is_invalid_bg_text(bg_description):
        bg_description = _build_fast_description_bg(bg_title, source_category, dimensions, title)
    elif not _looks_like_html(bg_description):
        # Looks like a plain string — wrap so the Shopify import body is at least valid HTML.
        bg_description = f"<p>{bg_description.strip()}</p>"

    # Reuse Bulgarian title as alt text — no LLM call
    alt_texts = {img: f"{bg_title} - снимка {i}" for i, img in enumerate(images[:MAX_SHOPIFY_IMAGES], 1)}

    bg_categories = categories.replace("Παιδικό δωμάτιο", "Детска стая")
    tags = [category_tag] if category_tag else []

    return {
        "sku": sku,
        "title_original": title,
        "title_bg": bg_title[:70],
        "description_original": description,
        "description_bg": bg_description,
        "seo_title_bg": bg_seo_title[:70],
        "seo_description_bg": bg_seo_description[:160],
        "categories_bg": bg_categories,
        "source_category": source_category,
        "tags": tags,
        "images": images,
        "alt_texts": alt_texts,
        "price_retail": product.get("retail_price", ""),
        "price_wholesale": product.get("wholesale_price", ""),
        "price_market": product.get("market_price", ""),
        "stock": product.get("stock", ""),
        "barcode": product.get("barcode", ""),
        "dimensions": dimensions,
        "weight_kg": product.get("weight_kg", ""),
        "item_code": product.get("item_code", ""),
        "_mode": "feed_copy",
    }


def translate_product(translator, product, idx, category_tag=""):
    sku = product.get("sku", "")
    title = product.get("title", "")
    description = product.get("description", "")
    categories = product.get("categories", "")
    dimensions = product.get("dimensions", "")
    images_str = product.get("images", "")
    images = [img.strip() for img in images_str.split(";") if img.strip()] if images_str else []
    items = [
        {"key": "title", "primary_text": title, "context_text": f"categories={categories}; dimensions={dimensions}"},
        {"key": "description", "primary_text": description, "context_text": f"title={title}"},
        {"key": "seo_title", "primary_text": title[:70], "context_text": f"title={title}"},
        {"key": "seo_description", "primary_text": f"{title[:50]} - {description[:100]}", "context_text": f"title={title}"},
    ]
    for i, img in enumerate(images[:MAX_SHOPIFY_IMAGES], 1):
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
    # NOTE: do NOT merge errors/errors_desc into `results` — they are error-metadata
    # dicts ({"reason":..., "model":..., "attempts":...}) and merging them would
    # overwrite the same key (e.g. "description") with a dict, which then crashes
    # downstream regex/contains_greek calls. translate_batch already wrote None
    # placeholders into results on failure, which is what we want.
    bg_title = ensure_text(results.get("title"))
    if not bg_title or contains_greek(bg_title):
        bg_title = f"Детски продукт {sku}"
    bg_description = ensure_text(results.get("description", ""))
    if not bg_description or contains_greek(bg_description):
        bg_description = f"<p>{title}</p>"
    bg_seo_title = ensure_text(results.get("seo_title", bg_title[:70]))
    bg_seo_description = ensure_text(results.get("seo_description", ""))
    alt_texts = {}
    for i, img in enumerate(images[:MAX_SHOPIFY_IMAGES], 1):
        alt_texts[img] = ensure_text(results.get(f"alt_{i}", f"{bg_title} - снимка {i}"))
    bg_categories = categories.replace("Παιδικό δωμάτιο", "Детска стая")
    tags = [category_tag] if category_tag else []
    source_category = extract_source_category(categories)
    return {
        "sku": sku,
        "title_original": title,
        "title_bg": bg_title[:70],
        "description_original": description,
        "description_bg": bg_description,
        "seo_title_bg": bg_seo_title[:70],
        "seo_description_bg": bg_seo_description[:160] if bg_seo_description else "",
        "categories_bg": bg_categories,
        "source_category": source_category,
        "tags": tags,
        "images": images,
        "alt_texts": alt_texts,
        "price_retail": product.get("retail_price", ""),
        "price_wholesale": product.get("wholesale_price", ""),
        "price_market": product.get("market_price", ""),
        "stock": product.get("stock", ""),
        "barcode": product.get("barcode", ""),
        "dimensions": dimensions,
        "weight_kg": product.get("weight_kg", ""),
        "item_code": product.get("item_code", ""),
    }


def build_shopify_csv_row(translated):
    handle = build_handle(translated["title_bg"], translated["sku"])
    images = translated.get("images", [])
    price = translated.get("price_retail") or translated.get("price_market") or ""
    barcode = translated.get("barcode", "")
    dimensions = translated.get("dimensions", "")
    weight = translated.get("weight_kg", "")
    rows = []
    for i, img in enumerate(images[:MAX_SHOPIFY_IMAGES], 1):
        row = {
            "Handle": handle,
            "Title": translated["title_bg"],
            "Body (HTML)": translated["description_bg"],
            "Vendor": "Europe",
            "Product Category": translated["categories_bg"],
            "Type": translated["categories_bg"].split(" > ")[-1] if " > " in translated["categories_bg"] else translated["categories_bg"],
            "Tags": ", ".join(translated["tags"]),
            "Published": "FALSE",
            "Option1 Name": "Title",
            "Option1 Value": "Default Title",
            "Variant SKU": translated["sku"],
            "Variant Inventory Tracker": "shopify",
            "Variant Inventory Qty": translated.get("stock") or "0",
            "Variant Inventory Policy": "deny",
            "Variant Fulfillment Service": "manual",
            "Variant Price": price,
            "Variant Compare At Price": translated.get("price_market", ""),
            "Variant Requires Shipping": "TRUE",
            "Variant Taxable": "TRUE",
            "Variant Barcode": barcode,
            "Image Src": img,
            "Image Position": str(i),
            "Image Alt Text": translated.get("alt_texts", {}).get(img, f"{translated['title_bg']} - снимка {i}"),
            "Gift Card": "FALSE",
            "SEO Title": translated["seo_title_bg"],
            "SEO Description": translated["seo_description_bg"],
            "Variant Weight Unit": "kg",
            "Status": "draft",
        }
        rows.append(row)
    if not images:
        row = {
            "Handle": handle,
            "Title": translated["title_bg"],
            "Body (HTML)": translated["description_bg"],
            "Vendor": "Europe",
            "Product Category": translated["categories_bg"],
            "Type": translated["categories_bg"].split(" > ")[-1] if " > " in translated["categories_bg"] else translated["categories_bg"],
            "Tags": ", ".join(translated["tags"]),
            "Published": "FALSE",
            "Option1 Name": "Title",
            "Option1 Value": "Default Title",
            "Variant SKU": translated["sku"],
            "Variant Inventory Tracker": "shopify",
            "Variant Inventory Qty": translated.get("stock") or "0",
            "Variant Inventory Policy": "deny",
            "Variant Fulfillment Service": "manual",
            "Variant Price": price,
            "Variant Compare At Price": translated.get("price_market", ""),
            "Variant Requires Shipping": "TRUE",
            "Variant Taxable": "TRUE",
            "Variant Barcode": barcode,
            "Image Src": "",
            "Image Position": "1",
            "Image Alt Text": "",
            "Gift Card": "FALSE",
            "SEO Title": translated["seo_title_bg"],
            "SEO Description": translated["seo_description_bg"],
            "Variant Weight Unit": "kg",
            "Status": "draft",
        }
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description="Translate B2BMarkt missing products to Bulgarian")
    parser.add_argument("--input", required=True, help="Input CSV file (missing-products CSV)")
    parser.add_argument("--model", default="google/gemma-4-31b-it", help="OpenRouter model")
    parser.add_argument("--fallback-model", default="openai/gpt-4.1-mini", help="Fallback model")
    parser.add_argument("--max-concurrency", type=int, default=1, help="Max concurrent translations")
    parser.add_argument("--max-retries", type=int, default=5, help="Max retries per request")
    parser.add_argument("--retry-backoff", type=float, default=1.5, help="Retry backoff multiplier")
    parser.add_argument("--limit-products", "--limit", dest="limit_products", type=int, help="Limit number of products to process")
    parser.add_argument("--out-base", default="translated-kids-room-products", help="Output base name (default: translated-kids-room-products)")
    parser.add_argument("--category", default="", help="B2BMarkt category name (e.g. Παιδικό δωμάτιο, Σαλόνια - γωνίες)")
    parser.add_argument("--all-categories", action="store_true", help="Process all categories (per-product category preserved)")
    parser.add_argument("--fast-product-copy", dest="fast_product_copy", action="store_true",
                        help="Single-call mode: generate title_bg/seo_title_bg/seo_description_bg in one LLM call; "
                             "build description_bg locally; reuse title for alt-text. ~5x fewer API calls per product.")
    parser.add_argument("--feed-product-copy", dest="feed_product_copy", action="store_true",
                        help="Single-call mode for feed-sourced products: sends title+description+category+dimensions "
                             "and receives title_bg/seo_title_bg/seo_description_bg/description_bg in one LLM call. "
                             "Reuses title for alt-text. ~5x fewer API calls per product than default mode.")
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

    cache = TranslationCache("translation_b2bmarkt_cache.sqlite")
    translator = OpenRouterTranslator(
        api_key=api_key,
        model=args.model,
        fallback_model=args.fallback_model,
        cache=cache,
        max_concurrency=args.max_concurrency,
        max_retries=args.max_retries,
        retry_backoff=args.retry_backoff,
        debug=args.debug,
        debug_log_path="debug_b2bmarkt.log",
    )

    with open(args.input, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        products = list(reader)

    if args.limit_products:
        products = products[: args.limit_products]

    print(f"Products to translate: {len(products)}")
    if args.feed_product_copy:
        print("Mode: FEED PRODUCT COPY (1 LLM call/product; title+desc+seo from feed; reused alt text)")
    elif args.fast_product_copy:
        print("Mode: FAST PRODUCT COPY (1 LLM call/product; local description; reused alt text)")
    if args.feed_product_copy:
        _translate_fn = translate_product_feed_copy
    elif args.fast_product_copy:
        _translate_fn = translate_product_fast
    else:
        _translate_fn = translate_product

    if args.all_categories:
        print("Mode: ALL CATEGORIES (per-product category preserved)")
        print("Category tag: (per-product — Tags empty, cleaner will map)")
    else:
        category_tag = resolve_category_tag(args.category)
        if category_tag:
            print(f"Category tag: {category_tag}")
        else:
            print("Category tag: (none — Tags will be empty)")

    translated_products = []
    errors_log = []

    with ThreadPoolExecutor(max_workers=args.max_concurrency) as executor:
        futures = {}
        for idx, p in enumerate(products):
            if args.all_categories:
                # Use per-product source category
                p_categories = p.get("categories", "")
                # Extract the first (primary) category text from the categories string
                # Format: "[L1] Category1 > [L2] Category2"
                primary_cat = ""
                if p_categories:
                    # Try to extract the last level category (most specific)
                    parts = p_categories.split(" > ")
                    if parts:
                        last_part = parts[-1].strip()
                        # Remove [Lx] prefix
                        primary_cat = re.sub(r"\[L\d+\]\s*", "", last_part).strip()
                tag = resolve_category_tag(primary_cat)
            else:
                tag = category_tag
            _t0 = time.time()
            fut = executor.submit(_translate_fn, translator, p, idx, tag)
            futures[fut] = (idx, p, _t0)
        for future in as_completed(futures):
            idx, product, t0 = futures[future]
            try:
                result = future.result()
                translated_products.append(result)
                dt = time.time() - t0
                mode_tag = result.get("_mode", "full")
                desc_kind = "local" if mode_tag == "fast" else "llm"
                print(f"  [{idx + 1}/{len(products)}] SKU {result['sku']}: OK ({dt:.1f}s, mode={mode_tag}, desc={desc_kind})")
            except Exception as e:
                import traceback as _tb
                tb_text = _tb.format_exc()
                errors_log.append({"sku": product.get("sku", ""), "error": str(e), "traceback": tb_text})
                print(f"  [{idx + 1}/{len(products)}] SKU {product.get('sku', '')}: ERROR - {e}")
                print(tb_text)

    print(f"\nTranslated: {len(translated_products)}")
    if errors_log:
        print(f"Errors: {len(errors_log)}")
        with open("translate_errors.log", "w", encoding="utf-8") as f:
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
        fieldnames = ["sku", "title_original", "title_bg", "description_original", "description_bg", "seo_title_bg", "seo_description_bg", "categories_bg", "tags", "images", "price_retail", "price_market", "stock", "barcode", "dimensions"]
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for p in translated_products:
            row = {k: p.get(k, "") for k in fieldnames}
            row["images"] = "; ".join(p.get("images", []))
            row["tags"] = ", ".join(p.get("tags", []))
            writer.writerow(row)
    print(f"Exported: {csv_path}")

    shopify_rows = []
    for p in translated_products:
        shopify_rows.extend(build_shopify_csv_row(p))

    shopify_fieldnames = ["Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published", "Option1 Name", "Option1 Value", "Variant SKU", "Variant Inventory Tracker", "Variant Inventory Qty", "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price", "Variant Compare At Price", "Variant Requires Shipping", "Variant Taxable", "Variant Barcode", "Image Src", "Image Position", "Image Alt Text", "Gift Card", "SEO Title", "SEO Description", "Variant Weight Unit", "Status"]
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
