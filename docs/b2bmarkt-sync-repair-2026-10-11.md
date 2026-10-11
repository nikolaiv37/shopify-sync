# B2BMarkt inventory setup repair — 11 October 2026

Live read-only diagnosis found a working feed and Shopify permissions, but no persisted B2BMarkt supplier identities. Consequently, all 8,544 feed rows were skipped by inventory preview, which correctly refused to write stock by SKU alone.

The vendor-scoped setup identified 6,898 exclusive mappings that can be saved without transferring existing stock ownership. Another verified candidate is already owned by Symetron and remains under that supplier. There are 1,455 unmatched feed products, 187 rows with insufficient corroborating evidence, and three ambiguous rows.

Ambiguous ProductCodes: `0596177`, `0596178`, `0596179` (ItemCodes `HM1203.01`, `HM1203.03`, `HM1203.10`). Each has multiple candidate Shopify variants; no mapping or inventory changes are authorized for those candidates by this repair.

The application now displays the verified setup count directly in the supplier card and explains why Sync is unavailable before setup. The CLI discovery command also honors `--supplier`, avoiding a global catalog scan when a single vendor is requested.

Setup approval now fingerprints canonical supplier references (supplier ID, ItemCode, platform ID, barcode), preserving duplicate records while ignoring stock, titles and feed ordering. Stock changes cannot interrupt identity setup; changed identity evidence, duplicate records or a changed destination location still reject it. Existing older signed reports retain their strict original hash check. Shopify metadata compare-and-set digests and post-write verification remain intact.

Verification: 169 automated tests passed, including B2BMarkt setup followed by stock sync, quantity changes during setup, changed identity references, and duplicate records. Production build, backend syntax checks and TypeScript passed. No browser testing, commits or pushes.

The user stopped the live setup and clarified that they wanted implementation only. The process was terminated; 65 journaled batches saved 6,500 exclusive B2BMarkt mappings, with zero errors. The interrupted next batch was read back and all its identity/ownership fields were still empty. No inventory quantities were changed. The exact stopped writer lock was reconciled and released. The remaining 398 verified mappings can be saved from a fresh B2BMarkt preview using the setup button; the user controls subsequent stock sync. No final live stock sync or full stock preview was run.

The metadata already saved is shared by local and deployed dashboards. UI and guard code changes remain local until deployed by the user; production assets have been regenerated.
