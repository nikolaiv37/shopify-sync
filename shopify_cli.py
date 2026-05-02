"""Helpers for calling `shopify store execute` and parsing its JSON output."""
import json
import re
import subprocess

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
STORE = "mebel-center.myshopify.com"


def _extract_json(text: str) -> dict:
    text = ANSI_RE.sub("", text)
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
        raise ValueError(f"No JSON in output: {text[:500]}")
    return json.loads(best)


def run(query: str, variables: dict | None = None, mutation: bool = False) -> dict:
    cmd = [
        "shopify", "store", "execute",
        "--store", STORE,
        "--query", query,
        "--json",
        "--no-color",
    ]
    if variables is not None:
        cmd += ["--variables", json.dumps(variables)]
    if mutation:
        cmd += ["--allow-mutations"]

    res = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    combined = ANSI_RE.sub("", res.stderr + res.stdout)
    if res.returncode != 0:
        raise RuntimeError(f"shopify exited {res.returncode}: {combined[-1200:]}")
    return _extract_json(res.stdout)
