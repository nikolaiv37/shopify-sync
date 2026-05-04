#!/usr/bin/env python3
"""Apply megapap inventory updates in batches of 50."""
import json
import sys
import time
import uuid

from shopify_cli import run

LOCATION_ID = "gid://shopify/Location/104700412237"  # Sofia
BATCH = 50
MUTATION = open("inventory_set.graphql").read()
PLAN_FILE = "megapap_update_plan.json"

with open(PLAN_FILE, encoding="utf-8") as f:
    plan = json.load(f)

start = int(sys.argv[1]) if len(sys.argv) > 1 else 0
limit = int(sys.argv[2]) if len(sys.argv) > 2 else len(plan)
plan = plan[start : start + limit]
RUN_ID = uuid.uuid4().hex[:10]
print(f"Applying {len(plan)} megapap updates (offset {start}, run_id {RUN_ID}) in batches of {BATCH}", flush=True)

total_ok = 0
total_errors = 0
error_rows = []
t0 = time.time()

for i in range(0, len(plan), BATCH):
    batch = plan[i : i + BATCH]
    quantities = [
        {
            "inventoryItemId": row["inventory_item_id"],
            "locationId": LOCATION_ID,
            "quantity": row["new"],
            "changeFromQuantity": row["current"],
        }
        for row in batch
    ]
    variables = {
        "input": {
            "name": "available",
            "reason": "correction",
            "referenceDocumentUri": "logistics://megapap-xml-sync",
            "quantities": quantities,
        },
        "key": f"megapap-{RUN_ID}-{start + i}",
    }

    try:
        data = run(MUTATION, variables, mutation=True)
    except Exception as e:
        total_errors += len(batch)
        error_rows.append({"batch_start": i, "error": str(e)[:800]})
        print(f"[batch {i//BATCH + 1}] CALL FAILED: {str(e)[:300]}", flush=True)
        time.sleep(2)
        continue

    payload = data.get("inventorySetQuantities", data.get("data", {}).get("inventorySetQuantities", {}))
    user_errors = payload.get("userErrors", []) or []
    if user_errors:
        total_errors += len(user_errors)
        error_rows.extend({"batch_start": i, "userError": ue} for ue in user_errors)
        print(f"[batch {i//BATCH + 1}] userErrors: {user_errors[:3]}", flush=True)
    ok = len(batch) - len(user_errors)
    total_ok += ok

    elapsed = int(time.time() - t0)
    done = i + len(batch)
    print(f"[batch {i//BATCH + 1}/{(len(plan)+BATCH-1)//BATCH}] ok={ok}/{len(batch)} | cum ok={total_ok}, err={total_errors} | {done}/{len(plan)} | {elapsed}s", flush=True)
    time.sleep(0.3)

with open("apply_megapap_errors.json", "w", encoding="utf-8") as f:
    json.dump(error_rows, f, ensure_ascii=False, indent=2)

print()
print("==== DONE ====")
print(f"Total rows processed:  {len(plan)}")
print(f"Successful updates:    {total_ok}")
print(f"Errors:                {total_errors}")
print(f"Elapsed:               {int(time.time() - t0)}s")
print(f"Error detail:          apply_megapap_errors.json")
