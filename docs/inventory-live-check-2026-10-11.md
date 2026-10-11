# Inventory live check — 11 October 2026

Read-only checks against Shopify and the selected supplier feeds. All times below are Europe/Sofia. No mappings or quantities were written during this investigation.

| Vendor | Already matches current feed | Needs update | Skipped / unmatched | Last confirmed writes |
|---|---:|---:|---:|---|
| MegaPap | 1101 | 1827 | 417 | 600 at 2026-10-11 13:23:11 (partial) |
| Symetron | 350 | 0 | 49 | 233 at 2026-10-11 13:13:45 (complete), 71 at 2026-10-11 13:12:38 (complete) |

Writer lock: {'holder': None, 'releasedAt': '2026-10-11T10:23:16.623Z'}. Both reports target Sofia (gid://shopify/Location/104700412237).

## Confirmed outcome

MegaPap completed six of twenty-five quantity batches: 600 confirmed updates, zero recorded skips and zero mutation errors. The seventh batch stopped before mutation at the whole-feed/location equality guard. The screenshot reports that guard error, and the current location still matches the approved location; feed drift is the likely trigger. The location in the run journal matches the current Sofia location. A fresh read shows 1,827 updates remaining and 1,101 already equal to the current feed. These current counts can change as the supplier feed or Shopify stock changes.

Symetron completed a 71-product run at 13:12 and a 233-product run at 13:13, both without recorded errors. All 350 currently mapped products now equal the current supplier feed; 49 feed products have no Shopify match. Therefore no eligible quantity update is currently needed.

The original journals record totals, not every updated variant. The 600 MegaPap updates are confirmed by the durable journal, but the exact 600-product list cannot be reconstructed reliably from current equality: that also includes products which were already correct before the operation. New journals retain ten confirmed before/after examples.

## Skipped items at 13:25

MegaPap skips 414 feed products without a Shopify variant, two products without a saved identity, and one invalid supplier quantity. The unresolved identities are `0290293` / `GP041-0138,1` and `0291941` / `GP041-0145,1`. The invalid quantity is `-1` for `0248964` / `GP052-0089`; the application does not turn that into an inventory write. Symetron's 49 skipped rows are missing Shopify variants. These rows do not prevent eligible mapped products from syncing.

## Implementation repair

Quantity apply no longer rejects the entire run because of an unrelated feed edit. Each approved item is looked up by its canonical supplier identifier, independent of row order. Deleted or duplicate identifiers and changed supplier quantities are skipped individually; only the signed quantity is eligible to write. Fresh metadata/ownership, selected location and compareQuantity checks remain in effect. Mapping setup still uses its strict evidence and feed checks.

Normal UI flow is preview → direct Sync. The preview shows current matches, eligible changes and skips. Large changes have an inline explicit approval checkbox; quantity writes have no additional modal. Setup remains an explicit advanced operation, separate from stock writes. Partial and completed runs show confirmed totals, including unprocessed items on a stop.

165 tests and the production build pass. No browser checks, commits or pushes were performed. Changes are local pending publication.
