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
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from xml.dom import minidom

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


GREEK_RE = re.compile(r"[\u0391-\u03C9]")
CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")
ALLOW_LATIN = {"PVC", "MDF", "E1", "K/D", "YES", "NO"}
COMMON_FILTER_VALUE_MAP = {
    "orange": "Оранжево",
    "blue": "Синьо",
    "black": "Черно",
    "white": "Бяло",
    "green": "Зелено",
    "dark green": "Тъмнозелено",
    "red": "Червено",
    "walnut": "Орех",
    "bordeaux": "Бордо",
    "melamine": "Меламин",
    "metal": "Метал",
    "leather": "Кожа",
    "mesh": "Мрежа",
    "1 doors": "1 врата",
    "2 doors": "2 врати",
}


def contains_greek(text):
    return bool(text and GREEK_RE.search(text))


def hash_context(text):
    if text is None:
        text = ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def split_label(text):
    if text is None:
        return "", "", False
    if ":" in text:
        before, after = text.split(":", 1)
        return before.strip(), after, True
    return text.strip(), "", False


def normalize_whitespace(text):
    return " ".join((text or "").split())


def is_allow_latin(text):
    normalized = normalize_whitespace(text).upper()
    return normalized in ALLOW_LATIN


def timestamp_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def validate_translation(mode, source_primary, translated, qa_meta=None):
    if translated is None or not translated.strip():
        return False, "empty"
    if contains_greek(translated):
        return False, "greek"
    qa_meta = qa_meta or {}

    if mode in ("title", "category", "filter_group"):
        words = re.findall(r"[A-Za-z\u0400-\u04FF]{2,}", translated)
        english_words = re.findall(r"[A-Za-z]{2,}", translated)
        if words:
            ratio = len(english_words) / len(words)
            if ratio > 0.3:
                return False, "too_english"

    if mode == "filter_value":
        has_cyrillic = bool(CYRILLIC_RE.search(translated))
        has_latin_words = bool(re.search(r"[A-Za-z]{2,}", translated))
        if not has_cyrillic and has_latin_words and not is_allow_latin(translated):
            return False, "latin_only"

    if mode == "description":
        src = source_primary or ""
        tags = ["br", "ul", "li", "strong", "p", "b"]
        for tag in tags:
            if re.search(rf"<\s*{tag}\b", src, re.IGNORECASE):
                if not re.search(rf"<\s*{tag}\b", translated, re.IGNORECASE):
                    return False, f"missing_tag_{tag}"
            if re.search(rf"</\s*{tag}\b", src, re.IGNORECASE):
                if not re.search(rf"</\s*{tag}\b", translated, re.IGNORECASE):
                    return False, f"missing_tag_{tag}_close"

    if mode == "attribute_label":
        rest = qa_meta.get("rest", "")
        has_colon = qa_meta.get("has_colon", False)
        if has_colon:
            if ":" not in f"{translated}:{rest}":
                return False, "missing_colon"
            if rest not in f"{translated}:{rest}":
                return False, "rest_changed"
        else:
            if ":" in translated:
                return False, "unexpected_colon"

    if mode != "attribute_label":
        unit_source = qa_meta.get("source_full", source_primary or "")
        for unit in ("cm", "mm"):
            if unit_source and re.search(rf"\\b{unit}\\b", unit_source):
                if not re.search(rf"\\b{unit}\\b", translated):
                    return False, f"missing_unit_{unit}"

    return True, "ok"


CONNECTOR_WORDS = {
    "in",
    "of",
    "with",
    "for",
    "and",
    "color",
    "colour",
    "cm",
    "mm",
    "x",
}


DIMENSION_RE = re.compile(
    r"\\b\\d+(?:[.,]\\d+)?x\\d+(?:[.,]\\d+)?(?:x\\d+(?:[.,]\\d+)?)?(?:cm|mm)?\\b",
    re.IGNORECASE,
)


def split_title_prefix(title):
    tokens = normalize_whitespace(title).split()
    prefix_tokens = []
    idx = 0
    for token in tokens:
        if token.lower() in CONNECTOR_WORDS:
            break
        if not re.search(r"[A-Za-z]", token):
            break
        if _is_prefix_token(token):
            prefix_tokens.append(token)
            idx += 1
            continue
        break
    prefix = " ".join(prefix_tokens)
    rest = " ".join(tokens[idx:])
    return prefix, rest


def _is_prefix_token(token):
    if not re.search(r"[A-Za-z]", token):
        return False
    if re.search(r"[0-9-]", token):
        return True
    if token.isupper():
        return True
    if len(token) > 1 and token[0].isupper() and token[1:].islower():
        return True
    return False


def extract_dimensions(text):
    return DIMENSION_RE.findall(text or "")


def has_cyrillic(text):
    return bool(text and CYRILLIC_RE.search(text))


def build_handle(model_text):
    normalized = normalize_whitespace(model_text).lower().replace(" ", "")
    return f"mc-{normalized}"


def get_text(elem, tag):
    if elem is None:
        return ""
    return elem.findtext(tag) or ""


def load_repair_issues(path, issue_types, repair_modes):
    title_models = set()
    title_handles = set()
    title_ids = set()
    filter_models = set()
    filter_handles = set()
    filter_ids = set()
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            issue_type = (row.get("issue_type") or "").strip()
            if not issue_type or issue_type not in issue_types:
                continue
            field = (row.get("field") or "").strip().lower()
            model = (row.get("model") or "").strip()
            handle = (row.get("handle") or "").strip()
            product_id = (row.get("product_id") or "").strip()

            if "title" in repair_modes:
                if field and field not in ("title", "name"):
                    pass
                else:
                    if model:
                        title_models.add(model)
                    if handle:
                        title_handles.add(handle)
                    if product_id:
                        title_ids.add(product_id)

            if "filter_value" in repair_modes:
                if field and field != "filter_value":
                    continue
                if "filter" in issue_type or issue_type == "latin_only":
                    if model:
                        filter_models.add(model)
                    if handle:
                        filter_handles.add(handle)
                    if product_id:
                        filter_ids.add(product_id)

    return {
        "title_models": title_models,
        "title_handles": title_handles,
        "title_ids": title_ids,
        "filter_models": filter_models,
        "filter_handles": filter_handles,
        "filter_ids": filter_ids,
    }


def translate_single_with_cache(
    translator, mode, primary_text, context_text, repair_reason=None, use_cache=True
):
    if use_cache:
        cached, _ = translator.cache.get(mode, primary_text, context_text)
        if cached is not None:
            return cached, None, "cache", 0
    result, reason, model_used, attempts_used = translator._call_model(
        mode,
        [{"i": 0, "primary_text": primary_text, "context_text": context_text}],
        repair_reason=repair_reason,
    )
    if result is None:
        return None, reason, model_used, attempts_used
    translated = result.get(0)
    if translated is not None:
        translator.cache.set(mode, primary_text, context_text, translated)
    return translated, None, model_used, attempts_used


def validate_title_repair(original_title, prefix, translated_rest, final_title):
    if contains_greek(final_title):
        return False, "greek"
    dims = extract_dimensions(original_title)
    if dims:
        final_lower = final_title.lower()
        for dim in dims:
            if dim.lower() not in final_lower:
                return False, "missing_dimensions"
    if prefix:
        if not has_cyrillic(translated_rest):
            return False, "no_cyrillic_rest"
    else:
        if not has_cyrillic(final_title):
            return False, "no_cyrillic"
    return True, "ok"


class TranslationCache:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
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
            self._conn.execute(
                "INSERT OR REPLACE INTO translations (mode, primary_text, context_hash, translation) VALUES (?, ?, ?, ?)",
                (mode, primary_text, "", translation),
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

    def translate_mode(self, mode, items, batch_size):
        results = {}
        error_meta = {}
        cache_hits = {"exact": 0, "fallback": 0, "miss": 0}
        to_translate = []

        for item in items:
            if mode == "filter_value":
                normalized = normalize_whitespace(item["primary_text"])
                if is_allow_latin(normalized):
                    results[item["key"]] = normalized
                    self.cache.set(
                        mode, item["primary_text"], item["context_text"], normalized
                    )
                    cache_hits["exact"] += 1
                    continue
                mapped = COMMON_FILTER_VALUE_MAP.get(normalized.lower())
                if mapped:
                    results[item["key"]] = mapped
                    self.cache.set(
                        mode, item["primary_text"], item["context_text"], mapped
                    )
                    cache_hits["exact"] += 1
                    continue
            cached, hit_type = self.cache.get(
                mode, item["primary_text"], item["context_text"]
            )
            if cached is not None:
                results[item["key"]] = cached
                cache_hits[hit_type] += 1
            else:
                cache_hits["miss"] += 1
                to_translate.append(item)

        print(
            f"Mode {mode}: cache hits exact={cache_hits['exact']} fallback={cache_hits['fallback']} miss={cache_hits['miss']}"
        )

        if not to_translate:
            return results, error_meta

        batches = [
            to_translate[i : i + batch_size]
            for i in range(0, len(to_translate), batch_size)
        ]

        with ThreadPoolExecutor(max_workers=self.max_concurrency) as executor:
            futures = {
                executor.submit(self._translate_batch, mode, batch): batch
                for batch in batches
            }
            for future in as_completed(futures):
                batch = futures[future]
                batch_results, batch_reason, batch_model, batch_attempts = future.result()
                if not batch_results:
                    for item in batch:
                        results[item["key"]] = None
                        error_meta[item["key"]] = {
                            "reason": batch_reason or "unknown",
                            "model": batch_model,
                            "attempts": batch_attempts,
                        }
                    continue
                for item in batch:
                    results[item["key"]] = batch_results.get(item["key"])
                    if batch_results.get(item["key"]) is None:
                        error_meta[item["key"]] = {
                            "reason": batch_reason or "unknown",
                            "model": batch_model,
                            "attempts": batch_attempts,
                        }
                    if batch_results.get(item["key"]) is not None:
                        self.cache.set(
                            mode,
                            item["primary_text"],
                            item["context_text"],
                            batch_results[item["key"]],
                        )

        return results, error_meta

    def _translate_batch(self, mode, items):
        payload_items = []
        for idx, item in enumerate(items):
            payload_items.append(
                {
                    "i": idx,
                    "primary_text": item["primary_text"],
                    "context_text": item["context_text"],
                }
            )
        result, reason, model_used, attempts_used = self._call_model(
            mode, payload_items
        )
        if result is None:
            return None, reason, model_used, attempts_used

        translations = {}
        for idx, item in enumerate(items):
            translations[item["key"]] = result.get(idx)

        if any(
            t is not None and contains_greek(t) for t in translations.values()
        ):
            repair_items = []
            repair_map = []
            for idx, item in enumerate(items):
                t = translations[item["key"]]
                if t is not None and contains_greek(t):
                    repair_items.append(
                        {
                            "i": len(repair_items),
                            "primary_text": item["primary_text"],
                            "context_text": item["context_text"],
                        }
                    )
                    repair_map.append(item["key"])
            repair_result, repair_reason, repair_model, repair_attempts = self._call_model(
                mode, repair_items, repair_reason="greek"
            )
            if repair_result is not None:
                for repair_idx, key in enumerate(repair_map):
                    repaired = repair_result.get(repair_idx)
                    if repaired is not None and not contains_greek(repaired):
                        translations[key] = repaired
            for key, value in translations.items():
                if value is not None and contains_greek(value):
                    translations[key] = None
                    reason = "greek_output"
                    if repair_model:
                        model_used = repair_model
                    if repair_attempts:
                        attempts_used = repair_attempts

        return translations, reason, model_used, attempts_used

    def _call_model(self, mode, items, repair_reason=None):
        if not items:
            return {}, None, self.model, 0
        system_prompt = self._build_system_prompt(mode, repair_reason)
        payload = self._build_payload(mode, items, system_prompt)
        headers = self._build_headers()

        result, reason, attempts_used = self._call_model_with_retries(
            payload, headers, mode, items, repair_reason, self.model
        )
        if result is not None:
            return result, None, self.model, attempts_used

        if self.fallback_model:
            if self.debug:
                self._debug_log("FALLBACK", f"Using fallback model {self.fallback_model}")
            payload["model"] = self.fallback_model
            result, reason, attempts_used = self._call_model_with_retries(
                payload,
                headers,
                mode,
                items,
                repair_reason,
                self.fallback_model,
                max_attempts=1,
            )
            if result is not None:
                return result, None, self.fallback_model, attempts_used

        return None, reason, self.fallback_model or self.model, attempts_used

    def _call_model_with_retries(
        self,
        payload,
        headers,
        mode,
        items,
        repair_reason,
        model_name,
        max_attempts=None,
    ):
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
                    timeout=60,
                )
                if response.status_code != 200:
                    last_reason = f"http_{response.status_code}"
                    if self.debug:
                        self._debug_log(
                            "HTTP",
                            f"status={response.status_code} body={self._truncate(response.text)}",
                        )
                    self._maybe_log_failed_batch(payload, headers, response)
                    if response.status_code in retry_statuses and attempt + 1 < attempts:
                        sleep_seconds = (self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25)
                        time.sleep(sleep_seconds)
                        continue
                    return None, last_reason, attempts_used

                try:
                    data = response.json()
                except Exception as exc:
                    last_reason = "json_parse"
                    if self.debug:
                        self._debug_log(
                            "PARSE",
                            f"response_json_error={type(exc).__name__}: {exc}",
                        )
                    self._maybe_log_failed_batch(payload, headers, response)
                    if attempt + 1 < attempts:
                        time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
                    continue

                content = (
                    data.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", "")
                    .strip()
                )
                try:
                    parsed = self._parse_response_content(content)
                except Exception as exc:
                    last_reason = "json_parse"
                    if self.debug:
                        self._debug_log(
                            "PARSE",
                            f"content_parse_error={type(exc).__name__}: {exc}",
                        )
                    self._maybe_log_failed_batch(payload, headers, response)
                    if attempt + 1 < attempts:
                        time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
                    continue

                items_out = parsed.get("items")
                if not isinstance(items_out, list) or len(items_out) != len(items):
                    last_reason = "length_mismatch"
                    if self.debug:
                        self._debug_log(
                            "PARSE",
                            f"items_length_expected={len(items)} actual={len(items_out) if isinstance(items_out, list) else 'invalid'}",
                        )
                    if attempt + 1 < attempts:
                        time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
                    continue

                mapped = {}
                for item in items_out:
                    if "i" not in item or "t" not in item:
                        last_reason = "schema_mismatch"
                        raise ValueError("Missing keys in response item")
                    idx = item["i"]
                    if isinstance(idx, str) and idx.isdigit():
                        idx = int(idx)
                    if not isinstance(idx, int):
                        last_reason = "schema_mismatch"
                        raise ValueError("Invalid index type in response item")
                    mapped[idx] = item["t"]

                return mapped, None, attempts_used
            except requests.exceptions.RequestException as exc:
                last_reason = "request_exception"
                if self.debug:
                    self._debug_log(
                        "EXCEPTION",
                        f"{type(exc).__name__}: {exc}",
                    )
                if attempt + 1 < attempts:
                    time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))
                    continue
                return None, last_reason, attempts_used
            except Exception as exc:
                if last_reason == "unknown":
                    last_reason = "exception"
                if self.debug:
                    self._debug_log(
                        "EXCEPTION",
                        f"{type(exc).__name__}: {exc}",
                    )
                if attempt + 1 < attempts:
                    time.sleep((self.retry_backoff ** (attempt + 1)) + random.uniform(0, 0.25))

        return None, last_reason, attempts_used

    def _parse_response_content(self, content):
        if "```" in content:
            parts = content.split("```")
            content = "".join(
                part for idx, part in enumerate(parts) if idx % 2 == 1
            ) or content
        content = content.strip()
        first = content.find("{")
        last = content.rfind("}")
        if first == -1 or last == -1 or last < first:
            raise ValueError("No JSON object found in content")
        snippet = content[first : last + 1]
        return json.loads(snippet)

    def _build_payload(self, mode, items, system_prompt):
        return {
            "model": self.model,
            "temperature": self.temperature,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "mode": mode,
                            "target_lang": "bg",
                            "items": items,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
        }

    def _build_headers(self):
        return {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": "https://openrouter.ai",
            "X-Title": "MebelCenter Translator",
            "Content-Type": "application/json",
        }

    def _truncate(self, text, limit=2000):
        if text is None:
            return ""
        if len(text) <= limit:
            return text
        return text[:limit] + "...(truncated)"

    def _debug_log(self, label, message):
        print(f"[DEBUG] {label}: {message}")

    def _sanitize_payload(self, payload):
        payload_copy = json.loads(json.dumps(payload))
        return payload_copy

    def _sanitize_headers(self, headers):
        sanitized = dict(headers)
        if "Authorization" in sanitized:
            sanitized["Authorization"] = "Bearer ***"
        return sanitized

    def _maybe_log_failed_batch(self, payload, headers, response):
        if not self.debug or self._debug_logged:
            return
        self._debug_logged = True
        try:
            with open(self.debug_log_path, "w", encoding="utf-8") as f:
                f.write("REQUEST\n")
                f.write(json.dumps(self._sanitize_payload(payload), ensure_ascii=False, indent=2))
                f.write("\nHEADERS\n")
                f.write(json.dumps(self._sanitize_headers(headers), ensure_ascii=False, indent=2))
                f.write("\nRESPONSE_STATUS\n")
                f.write(str(response.status_code))
                f.write("\nRESPONSE_BODY\n")
                f.write(response.text or "")
                f.write("\n")
        except Exception:
            pass

    def _build_system_prompt(self, mode, repair_reason=None):
        base = [
            "You are a translation engine.",
            "Translate ONLY primary_text into Bulgarian; use context_text only for disambiguation.",
            "Output Bulgarian only for the translation string.",
            "Do not translate product codes, SKUs, or dimension patterns like 75x29x128cm.",
            "Preserve punctuation and formatting exactly.",
            "If primary_text includes HTML, keep tags unchanged.",
        ]

        if mode == "title":
            base.append(
                "Title mode: Bulgarian, concise, product-type first when possible."
            )
            base.append(
                "Keep brand names in Latin , but delete word 'Megapap' as we want to hide  the brand name"
            )
        elif mode == "category":
            base.append('Category mode: Bulgarian path, keep " > " separators.')
        elif mode in ("filter_group", "filter_value"):
            base.append(
                "Filters mode: keep short consistent terms (e.g. Материал, Цвят, Характеристики)."
            )
        elif mode == "attribute_label":
            base.append(
                'Attribute label mode: translate label to Bulgarian but keep units like "cm" and "mm" exactly as-is.'
            )
        elif mode == "availability":
            base.append(
                "Availability mode: natural Bulgarian shipping/availability phrasing."
            )
        elif mode == "description":
            base.append("Description mode: translate faithfully with no added features.")

        if repair_reason == "greek":
            base.append(
                "Previous output contained Greek letters. Ensure output is Bulgarian only and contains no Greek characters."
            )
        elif repair_reason == "invalid_json":
            base.append(
                "Previous output was invalid JSON. Return strict JSON only, matching the requested schema."
            )
        elif repair_reason and repair_reason.startswith("qa_failed"):
            base.append(
                "Return Bulgarian translation ONLY of primary_text; keep HTML and units EXACTLY; do not invent info; output strict JSON."
            )
            if mode == "filter_value":
                base.append(
                    "Output MUST be Bulgarian in Cyrillic unless it is a standard acronym like PVC/MDF/E1."
                )
        elif repair_reason and repair_reason.startswith("title_repair"):
            base.append(
                "Title repair mode: output Bulgarian in Cyrillic; do NOT translate KEEP_PREFIX tokens."
            )
            base.append(
                "Preserve dimensions like 120x70x75cm, mm/cm, and numeric values."
            )
            base.append(
                "Translate materials/colors/types (table, chair, oak, black, walnut, marble effect)."
            )
            base.append("Do not add or remove meaning; keep concise.")

        base.append(
            'Return only JSON matching: {"items":[{"i":0,"t":"..."}]}. No extra commentary.'
        )
        return "\n".join(base)

    def repair_single(self, mode, primary_text, context_text, qa_reason):
        items = [{"i": 0, "primary_text": primary_text, "context_text": context_text}]
        result, reason, model_used, attempts_used = self._call_model(
            mode, items, repair_reason=f"qa_failed:{qa_reason}"
        )
        if result is None:
            return None, reason, model_used, attempts_used
        return result.get(0), None, model_used, attempts_used


def build_gr_filters_map(gr_product):
    mapping = {}
    if gr_product is None:
        return mapping
    for filt in gr_product.findall("filters/filter"):
        group = filt.find("group")
        value = filt.find("value")
        if group is None or value is None:
            continue
        key = (group.get("id", ""), value.get("id", ""))
        mapping[key] = (group.text or "", value.text or "")
    return mapping


def build_gr_attributes_map(gr_product):
    mapping = {}
    if gr_product is None:
        return mapping
    for attr in gr_product.findall("attributes/attribute"):
        mapping[attr.get("id", "")] = attr.text or ""
    return mapping


def verify_first_product(product):
    _ = product.find("name")
    _ = product.find("category")
    _ = product.find("description")
    _ = product.find("filters/filter/group")
    _ = product.find("filters/filter/value")
    _ = product.find("attributes/attribute")
    _ = product.find("availability")


def serialize_with_cdata(root, cdata_tags):
    xml_bytes = ET.tostring(root, encoding="utf-8")
    dom = minidom.parseString(xml_bytes)
    for tag in cdata_tags:
        for node in dom.getElementsByTagName(tag):
            text = ""
            for child in list(node.childNodes):
                if child.nodeType == child.TEXT_NODE:
                    text += child.data
                node.removeChild(child)
            node.appendChild(dom.createCDATASection(text))
    return dom.toxml(encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=(
            "Recommended for first run: --model openai/gpt-4.1-mini --max-concurrency 1\n"
            "Note: google/gemma-3-27b-it:free may 429 rate-limit; use later or with BYOK."
        ),
    )
    parser.add_argument("--en", required=True)
    parser.add_argument("--gr", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="openai/gpt-4.1-mini")
    parser.add_argument("--fallback-model", default="")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--retry-backoff", type=float, default=1.5)
    parser.add_argument("--limit-products", type=int)
    parser.add_argument("--max-concurrency", type=int, default=1)
    parser.add_argument("--batch-size-title", type=int, default=20)
    parser.add_argument("--batch-size-desc", type=int, default=4)
    parser.add_argument("--batch-size-other", type=int, default=30)
    parser.add_argument("--checkpoint-every", type=int, default=100)
    parser.add_argument("--checkpoint-path")
    parser.add_argument("--repair-issues")
    parser.add_argument(
        "--repair-issue-types",
        default="english_title,greek_output",
    )
    parser.add_argument("--repair-modes", default="title")
    parser.add_argument("--repair-inplace", action="store_true")
    parser.add_argument(
        "--use-gemma-free-template",
        action="store_true",
        help=(
            "Convenience preset: --model google/gemma-3-27b-it:free "
            "--fallback-model openai/gpt-4o-mini --max-concurrency 1"
        ),
    )
    args = parser.parse_args()

    if args.use_gemma_free_template:
        args.model = "google/gemma-3-27b-it:free"
        if not args.fallback_model:
            args.fallback_model = "openai/gpt-4o-mini"
        args.max_concurrency = 1

    if not args.checkpoint_path:
        args.checkpoint_path = f"{args.out}.checkpoint.xml"

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print(
            "OPENROUTER_API_KEY is not set. Export it or create a .env file:\n"
            "  export OPENROUTER_API_KEY=...\n"
            "  or create .env with OPENROUTER_API_KEY=...",
            file=sys.stderr,
        )
        sys.exit(1)

    errors_path = "errors.log"
    with open(errors_path, "w", encoding="utf-8") as _:
        pass

    repair_issue_types = {
        part.strip()
        for part in (args.repair_issue_types or "").split(",")
        if part.strip()
    }
    repair_modes = {
        part.strip()
        for part in (args.repair_modes or "").split(",")
        if part.strip()
    }

    cache_path = "translation_cache.sqlite"
    print(f"Using model: {args.model}")
    print(f"Fallback model: {args.fallback_model or 'none'}")
    print(f"Concurrency: {args.max_concurrency}")
    print(f"Cache path: {cache_path}")

    cache = TranslationCache(cache_path)
    translator = OpenRouterTranslator(
        api_key=api_key,
        model=args.model,
        fallback_model=args.fallback_model,
        cache=cache,
        max_concurrency=args.max_concurrency,
        max_retries=args.max_retries,
        retry_backoff=args.retry_backoff,
        debug=args.debug,
        debug_log_path="debug_openrouter.log",
    )

    if args.repair_issues:
        issues_sets = load_repair_issues(
            args.repair_issues, repair_issue_types, repair_modes
        )
        input_path = args.out
        if not os.path.exists(input_path):
            input_path = args.en
        if not os.path.exists(input_path):
            print(
                f"Repair mode requires an existing BG XML. Not found at {args.out} or {args.en}.",
                file=sys.stderr,
            )
            sys.exit(1)

        output_path = input_path if args.repair_inplace else args.out
        repair_tree = ET.parse(input_path)
        repair_root = repair_tree.getroot()
        errors = []
        repaired_titles = 0
        repaired_filters = 0

        for product in repair_root.findall(".//product"):
            product_id = product.get("id", "")
            model = get_text(product, "model")
            handle = build_handle(model)

            needs_title = (
                model in issues_sets["title_models"]
                or handle in issues_sets["title_handles"]
                or product_id in issues_sets["title_ids"]
            )
            if "title" in repair_modes and needs_title:
                title_el = product.find("name")
                if title_el is not None:
                    original_title = title_el.text or ""
                    prefix, rest = split_title_prefix(original_title)
                    if rest.strip():
                        category = get_text(product, "category")
                        attr_labels = []
                        for attr in product.findall("attributes/attribute"):
                            label, _, _ = split_label(attr.text or "")
                            if label:
                                attr_labels.append(label)
                        context_text = (
                            f"KEEP_PREFIX={prefix}\n"
                            f"CATEGORY={category}\n"
                            f"ATTRS={', '.join(attr_labels)}\n"
                        )

                        translated, reason, model_used, attempts = translate_single_with_cache(
                            translator,
                            "title",
                            rest,
                            context_text,
                            repair_reason="title_repair",
                        )
                        if translated is None:
                            errors.append(
                                {
                                    "timestamp": timestamp_now(),
                                    "product_id": product_id,
                                    "mode": "title",
                                    "field": "name",
                                    "reason": reason or "translation_failed",
                                    "model_used": model_used,
                                    "attempt_count": attempts,
                                }
                            )
                        else:
                            final_title = f"{prefix} {translated}".strip() if prefix else translated
                            ok, qa_reason = validate_title_repair(
                                original_title, prefix, translated, final_title
                            )
                            if not ok:
                                translated, reason, model_used, attempts = translate_single_with_cache(
                                    translator,
                                    "title",
                                    rest,
                                    context_text,
                                    repair_reason="title_repair_retry",
                                    use_cache=False,
                                )
                                if translated is not None:
                                    final_title = f"{prefix} {translated}".strip() if prefix else translated
                                    ok, qa_reason = validate_title_repair(
                                        original_title, prefix, translated, final_title
                                    )
                            if not ok:
                                errors.append(
                                    {
                                        "timestamp": timestamp_now(),
                                        "product_id": product_id,
                                        "mode": "title",
                                        "field": "name",
                                        "reason": f"title_repair_failed:{qa_reason}",
                                        "model_used": model_used,
                                        "attempt_count": attempts,
                                    }
                                )
                            else:
                                title_el.text = final_title
                                repaired_titles += 1

            needs_filter = (
                model in issues_sets["filter_models"]
                or handle in issues_sets["filter_handles"]
                or product_id in issues_sets["filter_ids"]
            )
            if "filter_value" in repair_modes and needs_filter:
                filters_parent = product.find("filters")
                if filters_parent is not None:
                    for filt in filters_parent.findall("filter"):
                        value_el = filt.find("value")
                        if value_el is None:
                            continue
                        value_text = (value_el.text or "").strip()
                        if not value_text:
                            continue
                        if has_cyrillic(value_text):
                            continue
                        if is_allow_latin(value_text):
                            continue
                        if not re.search(r"[A-Za-z]", value_text):
                            continue

                        normalized = normalize_whitespace(value_text)
                        mapped = COMMON_FILTER_VALUE_MAP.get(normalized.lower())
                        if mapped:
                            value_el.text = mapped
                            cache.set("filter_value", normalized, "", mapped)
                            repaired_filters += 1
                            continue

                        translated, reason, model_used, attempts = translate_single_with_cache(
                            translator,
                            "filter_value",
                            normalized,
                            "",
                            repair_reason="filter_value_repair",
                        )
                        if translated is None:
                            errors.append(
                                {
                                    "timestamp": timestamp_now(),
                                    "product_id": product_id,
                                    "mode": "filter_value",
                                    "field": "filters/value",
                                    "reason": reason or "translation_failed",
                                    "model_used": model_used,
                                    "attempt_count": attempts,
                                }
                            )
                            continue

                        ok, qa_reason = validate_translation(
                            "filter_value", normalized, translated
                        )
                        if not ok or contains_greek(translated):
                            repaired, repair_reason, repair_model, repair_attempts = translator.repair_single(
                                "filter_value", normalized, "", qa_reason
                            )
                            if repaired is not None:
                                ok, qa_reason = validate_translation(
                                    "filter_value", normalized, repaired
                                )
                                if ok and not contains_greek(repaired):
                                    translated = repaired
                                    model_used = repair_model or model_used
                                    attempts = repair_attempts or attempts
                        if not ok:
                            errors.append(
                                {
                                    "timestamp": timestamp_now(),
                                    "product_id": product_id,
                                    "mode": "filter_value",
                                    "field": "filters/value",
                                    "reason": f"filter_value_repair_failed:{qa_reason}",
                                    "model_used": model_used,
                                    "attempt_count": attempts,
                                }
                            )
                            continue
                        value_el.text = translated
                        repaired_filters += 1

        if errors:
            with open(errors_path, "a", encoding="utf-8") as f:
                for entry in errors:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            print(f"Logged {len(errors)} errors to {errors_path}")

        cdata_tags = ["name", "category", "description", "availability", "attribute"]
        xml_out = serialize_with_cdata(repair_root, cdata_tags)
        with open(output_path, "wb") as f:
            f.write(xml_out)
        print(f"Repair complete. Titles updated: {repaired_titles}, filter values updated: {repaired_filters}")
        print(f"Written output to {output_path}")
        return

    en_tree = ET.parse(args.en)
    gr_tree = ET.parse(args.gr)
    en_root = en_tree.getroot()
    gr_root = gr_tree.getroot()

    gr_products = {
        product.get("id", ""): product
        for product in gr_root.findall(".//product")
    }
    en_products = en_root.findall(".//product")
    if args.limit_products:
        en_products = en_products[: args.limit_products]

    if en_products:
        verify_first_product(en_products[0])

    batch_sizes = {
        "title": args.batch_size_title,
        "description": args.batch_size_desc,
        "category": args.batch_size_other,
        "filter_group": args.batch_size_other,
        "filter_value": args.batch_size_other,
        "attribute_label": args.batch_size_other,
        "availability": args.batch_size_other,
    }

    def add_task(tasks, mode, primary_text, context_text, product_id, field, apply_func, qa_meta=None):
        if primary_text is None or not primary_text.strip():
            return
        context_text = context_text or ""
        key = (mode, primary_text, context_text)
        if key not in tasks:
            tasks[key] = {
                "mode": mode,
                "primary_text": primary_text,
                "context_text": context_text,
                "occurrences": [],
            }
        tasks[key]["occurrences"].append(
            {
                "product_id": product_id,
                "field": field,
                "apply": apply_func,
                "qa_meta": qa_meta or {},
            }
        )

    total_products = len(en_products)
    processed_products = 0
    for chunk_start in range(0, total_products, args.checkpoint_every):
        chunk = en_products[chunk_start : chunk_start + args.checkpoint_every]
        tasks = {}

        for idx, en_product in enumerate(chunk, chunk_start + 1):
            product_id = en_product.get("id", "")
            print(f"Processing product {idx}/{total_products} id={product_id}")
            gr_product = gr_products.get(product_id)

            en_name = en_product.findtext("name") or ""
            gr_name = gr_product.findtext("name") if gr_product is not None else ""
            add_task(
                tasks,
                "title",
                en_name,
                gr_name,
                product_id,
                "name",
                lambda t, el=en_product.find("name"): setattr(el, "text", t)
                if el is not None
                else None,
            )

            en_category = en_product.findtext("category") or ""
            gr_category = (
                gr_product.findtext("category") if gr_product is not None else ""
            )
            add_task(
                tasks,
                "category",
                en_category,
                gr_category,
                product_id,
                "category",
                lambda t, el=en_product.find("category"): setattr(el, "text", t)
                if el is not None
                else None,
            )

            en_desc = en_product.findtext("description") or ""
            gr_desc = (
                gr_product.findtext("description") if gr_product is not None else ""
            )
            if gr_desc:
                desc_primary = gr_desc
                desc_context = en_desc
            else:
                desc_primary = en_desc
                desc_context = ""
            add_task(
                tasks,
                "description",
                desc_primary,
                desc_context,
                product_id,
                "description",
                lambda t, el=en_product.find("description"): setattr(el, "text", t)
                if el is not None
                else None,
            )

            gr_filters_map = build_gr_filters_map(gr_product)
            for filt in en_product.findall("filters/filter"):
                group = filt.find("group")
                value = filt.find("value")
                if group is None or value is None:
                    continue
                key = (group.get("id", ""), value.get("id", ""))
                gr_group_text, gr_value_text = gr_filters_map.get(key, ("", ""))
                en_group_text = group.text or ""
                en_value_text = value.text or ""

                if gr_group_text:
                    group_primary = gr_group_text
                    group_context = en_group_text
                else:
                    group_primary = en_group_text
                    group_context = ""

                if gr_value_text:
                    value_primary = gr_value_text
                    value_context = en_value_text
                else:
                    value_primary = en_value_text
                    value_context = ""

                add_task(
                    tasks,
                    "filter_group",
                    group_primary,
                    group_context,
                    product_id,
                    "filters/group",
                    lambda t, el=group: setattr(el, "text", t),
                )
                add_task(
                    tasks,
                    "filter_value",
                    value_primary,
                    value_context,
                    product_id,
                    "filters/value",
                    lambda t, el=value: setattr(el, "text", t),
                )

            gr_attrs_map = build_gr_attributes_map(gr_product)
            for attr in en_product.findall("attributes/attribute"):
                attr_id = attr.get("id", "")
                en_text = attr.text or ""
                en_label, en_rest, en_has_colon = split_label(en_text)
                gr_text = gr_attrs_map.get(attr_id, "")
                gr_label, _, _ = split_label(gr_text) if gr_text else ("", "", False)
                if gr_label and contains_greek(gr_label):
                    primary_label = gr_label
                else:
                    primary_label = en_label
                context_text = en_text or gr_text

                def apply_attr(t, el=attr, rest=en_rest, has_colon=en_has_colon):
                    if el is None:
                        return
                    if has_colon:
                        el.text = f"{t}:{rest}"
                    else:
                        el.text = t

                add_task(
                    tasks,
                    "attribute_label",
                    primary_label,
                    context_text,
                    product_id,
                    "attributes/attribute",
                    apply_attr,
                    qa_meta={
                        "rest": en_rest,
                        "has_colon": en_has_colon,
                        "source_full": en_text or gr_text,
                    },
                )

            en_avail = en_product.findtext("availability") or ""
            gr_avail = (
                gr_product.findtext("availability") if gr_product is not None else ""
            )
            if gr_avail and contains_greek(gr_avail):
                avail_primary = gr_avail
                avail_context = en_avail
            else:
                avail_primary = en_avail
                avail_context = gr_avail
            add_task(
                tasks,
                "availability",
                avail_primary,
                avail_context,
                product_id,
                "availability",
                lambda t, el=en_product.find("availability"): setattr(el, "text", t)
                if el is not None
                else None,
            )

        mode_batches = {}
        for key, task in tasks.items():
            mode_batches.setdefault(task["mode"], []).append(
                {
                    "key": key,
                    "primary_text": task["primary_text"],
                    "context_text": task["context_text"],
                }
            )

        results = {}
        error_meta = {}
        for mode, items in mode_batches.items():
            print(f"Translating mode {mode} with {len(items)} unique items...")
            mode_results, mode_errors = translator.translate_mode(
                mode, items, batch_sizes.get(mode, 20)
            )
            results.update(mode_results)
            error_meta.update(mode_errors)

        errors = []
        for key, task in tasks.items():
            translation = results.get(key)
            error_info = error_meta.get(key, {})
            for occ in task["occurrences"]:
                if translation is None:
                    reason = error_info.get("reason", "unknown")
                    model_used = error_info.get("model", "unknown")
                    attempts = error_info.get("attempts", 0)
                    errors.append(
                        {
                            "timestamp": timestamp_now(),
                            "product_id": occ["product_id"],
                            "mode": task["mode"],
                            "field": occ["field"],
                            "reason": reason,
                            "model_used": model_used,
                            "attempt_count": attempts,
                        }
                    )
                    continue

                ok, qa_reason = validate_translation(
                    task["mode"], task["primary_text"], translation, occ.get("qa_meta")
                )
                if not ok:
                    repaired, repair_reason, repair_model, repair_attempts = translator.repair_single(
                        task["mode"],
                        task["primary_text"],
                        task["context_text"],
                        qa_reason,
                    )
                    if repaired is not None:
                        ok, qa_reason = validate_translation(
                            task["mode"], task["primary_text"], repaired, occ.get("qa_meta")
                        )
                    if not ok:
                        final_reason = f"qa_failed:{repair_reason or qa_reason}"
                        model_used = repair_model or error_info.get("model") or args.model
                        attempts = repair_attempts or error_info.get("attempts", 0)
                        errors.append(
                            {
                                "timestamp": timestamp_now(),
                                "product_id": occ["product_id"],
                                "mode": task["mode"],
                                "field": occ["field"],
                                "reason": final_reason,
                                "model_used": model_used,
                                "attempt_count": attempts,
                            }
                        )
                        continue
                    translation = repaired

                try:
                    occ["apply"](translation)
                except Exception:
                    errors.append(
                        {
                            "timestamp": timestamp_now(),
                            "product_id": occ["product_id"],
                            "mode": task["mode"],
                            "field": occ["field"],
                            "reason": "apply_failed",
                            "model_used": args.model,
                            "attempt_count": 0,
                        }
                    )

        if errors:
            with open(errors_path, "a", encoding="utf-8") as f:
                for entry in errors:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            print(f"Logged {len(errors)} errors to {errors_path}")

        processed_products += len(chunk)
        cdata_tags = ["name", "category", "description", "availability", "attribute"]
        if processed_products % args.checkpoint_every == 0 or processed_products == total_products:
            with open(errors_path, "a", encoding="utf-8") as _:
                pass
            xml_checkpoint = serialize_with_cdata(en_root, cdata_tags)
            with open(args.checkpoint_path, "wb") as f:
                f.write(xml_checkpoint)
            print(f"Wrote checkpoint to {args.checkpoint_path} ({processed_products}/{total_products})")

    cdata_tags = ["name", "category", "description", "availability", "attribute"]
    xml_out = serialize_with_cdata(en_root, cdata_tags)
    with open(args.out, "wb") as f:
        f.write(xml_out)

    print(f"Written output to {args.out}")


if __name__ == "__main__":
    main()
