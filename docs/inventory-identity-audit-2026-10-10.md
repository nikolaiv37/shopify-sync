# Inventory identity audit — 10 October 2026

Live Shopify/feed reads completed at 2026-10-10T08:34:13.793Z (11:34 Europe/Sofia). No Shopify mutations or B2BCenter writes were performed. No application code was changed. Existing uncommitted changes were inspected and preserved.

## Conclusion

Stop before implementation: many individual mappings are provable, but exclusive supplier ownership cannot be inferred for every variant. B2BMarkt and Symetron share vendor Europe, and one live feed product is present in both feeds and resolves to the same Shopify variant. No supplier identity metafields were found on the nine sampled variants or their products. This is a sample-level conclusion, not a claim that every store metafield was scanned.

The current working-tree Shopify inventory engine already accepts both old and migrated identifiers. Therefore the SKU migration alone does not explain all current failures. B2BMarkt ItemCode collisions, missing persistent identity, supplier overlap, and limited preview reporting are confirmed problems.

## Existing implementation

| Path | Matching / behavior |
| --- | --- |
| lib/inventorySync.js | MegaPap: feed sku OR model → trimmed live variant.sku within vendor Mebelcenter. B2BMarkt: ItemCode OR ProductCode → variant.sku within Europe. Two supplier definitions only. |
| lib/b2bcenterSync.js | Separate XML parser and matcher: MegaPap model / B2BMarkt ProductCode → products.sku; tenant_id + manufacturer isolation. Symetron absent. No shared matching architecture with Shopify. |
| lib/suppliers/*/adapter.js | All three catalog adapters exist. MegaPap extracts sku plus model; B2BMarkt/Symetron share format.js, extract ItemCode plus ProductCode/IdentificationCode and Stock. Inventory engines bypass these adapters. |
| lib/sku/config.js, engine.js, dashboard.js | model → sku; ProductCode → ItemCode. Migration reads local XML files. Mutation writes inventoryItem.sku only, with no original-ID metafield/tag/persistent variant mapping. Target duplicates remain selectable and are tested as allowed. |
| lib/missing-products/transform.js | CSV import writes SKU, barcode, vendor, category tags, and a generated handle. No supplier identity metafields. Legacy handles often remain after migration. |
| src/pages/InventorySyncPage.tsx | Two cards per destination. Static workflow rail, optimistic ready badge, counts limited to planned/updated/skipped/errors, no unmatched/conflict inspection. Apply has a confirmation modal but does not require a prior preview. Portal apply automatically requests allowLargeApply=true. |
| lib/dashboardApp.js | Two supplier registries, legacy HTML page plus React API. normalizeSummary drops detailed matching diagnostics. Shopify apply endpoint does not require confirm=true. Preview/apply rebuild from fresh feed/live state independently; no accepted-preview binding. |
| test/ | 84 tests covering catalog/missing-products, prices and SKU migration; no dedicated inventory or B2BCenter sync tests found. |

### Safety findings

- Shopify parser blocks repeated feed identifiers, but does not block multiple Shopify variants sharing one matching SKU. It indexes primary and legacy identifiers together, so an alias collision can also block a row.
- B2BCenter parser overwrites duplicate feed identifiers with the last quantity; it does not block multiple portal matches.
- Both parsers use parseInt and default invalid stock to zero; decimal/prefix strings can be accepted. One live MegaPap row has a negative quantity, requiring an explicit supplier policy.
- Both paths skip destination products absent from the feed, rather than resetting them to zero. Preserve that behavior.
- Shopify uses variant.inventoryQuantity as its observed quantity, but writes available at a chosen location with compareQuantity. Location-specific available must be read for reliable comparisons.
- Shopify retries/throttling and per-batch processing exist; its success count subtracts user-error count from batch size, which does not reliably describe batch-level failure. Module-global token/logger also require care under concurrent execution.
- Portal writes quantity only and guards tenant, manufacturer, observed quantity and visibility; a 40% default change threshold exists, but the UI always overrides it. updated_at is captured but not included in the write guard.
- Preview paths perform external reads and write local run logs; they do not mutate Shopify inventory or Supabase products.

## Live data coverage

All 11,664 Shopify variants were read. Counts below are feed rows with exact SKU candidates under the expected vendor; they are not counts of safe quantity changes. Old/new candidate counts can overlap.

| Supplier | Live rows | Old-ID SKU candidates | New-ID SKU candidates | Duplicate new-ID values | Missing new ID | Feed rows with multiple new-SKU Shopify candidates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| megapap | 3345 | 6 | 2923 | 0 | 0 | 0 |
| b2bmarkt | 8533 | 44 | 7034 | 82 | 1 | 82 |
| symetron | 399 | 0 | 350 | 0 | 0 | 0 |

All three live feeds have nonblank, unique legacy identifiers (model / ProductCode). ProductId is also nonblank and unique in both B2BMarkt-platform feeds. B2BMarkt has 82 distinct duplicate ItemCode values; 82 feed rows have multiple Shopify candidates by ItemCode. These are different measurements and should not be conflated.

Local migration/catalog snapshots differ from live inventory feeds: MegaPap 3615 local vs 3345 live; B2BMarkt 8461 vs 8533; Symetron 405 vs 399. Local approved identifiers are present in these copies. The configured live MegaPap and Symetron URLs return Greek titles despite the English local adapters. B2BMARKT_SYMETRON_URL is configured; B2BMARKT_SYMETRON_EN_URL is absent in this environment. Do not hard-code the absent English env variable as the sole inventory feed source.

## Nine representative real products

For Symetron, OLD MATCHING means the catalog/migration identifier; there is currently no Symetron inventory-sync path. Proposed keys below are recommendations for a persistent variant registry, not fields already present on Shopify.

### megapap

OLD MATCHING: feed `model` → Shopify variant SKU (Mebelcenter). Current inventory implementation also accepts `sku` against the live SKU.

PROPOSED MATCHING: `megapap + model` → explicitly recorded Shopify variant GID, independent of current SKU.

#### Example 1

| Field | Exact observed value |
| --- | --- |
| Feed product name | Διάτρητο πανί επαγγελματικό για πολυθρόνα σκηνοθέτη χρώματος πορτοκαλί Megapap |
| Feed identifier / exact field | `0086733` in `<model>` |
| Previously matched identifier | `0086733` against variant.sku |
| Migrated feed identifier / exact field | `GP011-0014` in `<sku>` |
| Shopify product title | Професионална перфорирана материя за режисьорски стол оранжев цвят |
| Shopify handle | `mc-0086733` |
| Current Shopify variant SKU | `GP011-0014` |
| Shopify vendor | Mebelcenter |
| Tags | Материал_PVC; Тъкани за столове на режисьори; Цвят_Оранжево |
| Variant metafields | None returned; pagination complete |
| Product metafields | None returned; pagination complete |
| Variant GID | `gid://shopify/ProductVariant/53226419257677` |
| ProductId corroboration | Not present in the inspected MegaPap product fields |
| Proposed stable matching field | Persisted `megapap:0086733` → `gid://shopify/ProductVariant/53226419257677` |

#### Example 2

| Field | Exact observed value |
| --- | --- |
| Feed product name | Διάτρητο πανί επαγγελματικό για πολυθρόνα σκηνοθέτη χρώματος μπορντώ Megapap |
| Feed identifier / exact field | `0086732` in `<model>` |
| Previously matched identifier | `0086732` against variant.sku |
| Migrated feed identifier / exact field | `GP011-0013` in `<sku>` |
| Shopify product title | Професионална перфорирана материя за режисьорски стол бордо цвят |
| Shopify handle | `mc-0086732` |
| Current Shopify variant SKU | `GP011-0013` |
| Shopify vendor | Mebelcenter |
| Tags | Материал_PVC; Тъкани за столове на режисьори; Цвят_Бордо |
| Variant metafields | None returned; pagination complete |
| Product metafields | None returned; pagination complete |
| Variant GID | `gid://shopify/ProductVariant/53226420470093` |
| ProductId corroboration | Not present in the inspected MegaPap product fields |
| Proposed stable matching field | Persisted `megapap:0086732` → `gid://shopify/ProductVariant/53226420470093` |

#### Example 3

| Field | Exact observed value |
| --- | --- |
| Feed product name | Διάτρητο πανί επαγγελματικό για πολυθρόνα σκηνοθέτη χρώματος μπλε Megapap |
| Feed identifier / exact field | `0086731` in `<model>` |
| Previously matched identifier | `0086731` against variant.sku |
| Migrated feed identifier / exact field | `GP011-0012` in `<sku>` |
| Shopify product title | Професионална перфорирана материя за режисьорски стол син цвят |
| Shopify handle | `mc-0086731` |
| Current Shopify variant SKU | `GP011-0012` |
| Shopify vendor | Mebelcenter |
| Tags | Материал_PVC; Тъкани за столове на режисьори; Цвят_Синьо |
| Variant metafields | None returned; pagination complete |
| Product metafields | None returned; pagination complete |
| Variant GID | `gid://shopify/ProductVariant/53226420666701` |
| ProductId corroboration | Not present in the inspected MegaPap product fields |
| Proposed stable matching field | Persisted `megapap:0086731` → `gid://shopify/ProductVariant/53226420666701` |

### b2bmarkt

OLD MATCHING: feed `ProductCode` → Shopify variant SKU (Europe). Current inventory implementation also accepts `ItemCode` against the live SKU.

PROPOSED MATCHING: `b2bmarkt + ProductCode` → explicitly recorded Shopify variant GID, independent of current SKU.

#### Example 1

| Field | Exact observed value |
| --- | --- |
| Feed product name | ΣΤΟΡΙ ΜΠΑΜΠΟΥ 180*180 ΜΠΕΖ Ε-0089 HM11292 |
| Feed identifier / exact field | `2123013` in `<ProductCode>` |
| Previously matched identifier | `2123013` against variant.sku |
| Migrated feed identifier / exact field | `Ε-0089` in `<ItemCode>` |
| Shopify product title | Бамбукови щори 180x180 Бежов |
| Shopify handle | `mc-43220` |
| Current Shopify variant SKU | `Ε-0089` |
| Shopify vendor | Europe |
| Tags | Декорация; Щори-Завеси-Щендери-Мрежи против комари |
| Variant metafields | None returned; pagination complete |
| Product metafields | None returned; pagination complete |
| Variant GID | `gid://shopify/ProductVariant/53473105576269` |
| ProductId corroboration | 43220 |
| Proposed stable matching field | Persisted `b2bmarkt:2123013` → `gid://shopify/ProductVariant/53473105576269` |

#### Example 2

| Field | Exact observed value |
| --- | --- |
| Feed product name | ΣΤΟΡΙ ΜΠΑΜΠΟΥ 120Χ180 ΜΠΕΖ Ε-0087  HM11290 |
| Feed identifier / exact field | `2123018` in `<ProductCode>` |
| Previously matched identifier | `2123018` against variant.sku |
| Migrated feed identifier / exact field | `Ε-0087` in `<ItemCode>` |
| Shopify product title | Бамбукови щори 120x180 Бежов |
| Shopify handle | `mc-43221` |
| Current Shopify variant SKU | `Ε-0087` |
| Shopify vendor | Europe |
| Tags | Декорация; Щори-Завеси-Щендери-Мрежи против комари |
| Variant metafields | None returned; pagination complete |
| Product metafields | None returned; pagination complete |
| Variant GID | `gid://shopify/ProductVariant/53473105609037` |
| ProductId corroboration | 43221 |
| Proposed stable matching field | Persisted `b2bmarkt:2123018` → `gid://shopify/ProductVariant/53473105609037` |

#### Example 3

| Field | Exact observed value |
| --- | --- |
| Feed product name | ΟΜΠΡΕΛΑ 3x3x2,65 μ. RAMSEY ΤΕΤΡΑΓΩΝΗ ΑΛΟΥΜΙΝΙΟΥ ΕΚΡΟΥ ΜΕ ΜΑΝΙΒΕΛΑ HM6004 |
| Feed identifier / exact field | `0612060` in `<ProductCode>` |
| Previously matched identifier | `0612060` against variant.sku |
| Migrated feed identifier / exact field | `HM6004` in `<ItemCode>` |
| Shopify product title | Чадър 3x3x2,65 м. Алуминий Крем с манивела |
| Shopify handle | `mc-43228` |
| Current Shopify variant SKU | `HM6004` |
| Shopify vendor | Europe |
| Tags | Чадъри; Чадъри-Основа |
| Variant metafields | None returned; pagination complete |
| Product metafields | None returned; pagination complete |
| Variant GID | `gid://shopify/ProductVariant/53473105641805` |
| ProductId corroboration | 43228 |
| Proposed stable matching field | Persisted `b2bmarkt:0612060` → `gid://shopify/ProductVariant/53473105641805` |

### symetron

OLD MATCHING: feed `ProductCode` → Shopify variant SKU (Europe). Current inventory implementation does not support this supplier.

PROPOSED MATCHING: `symetron + ProductCode` → explicitly recorded Shopify variant GID, independent of current SKU.

#### Example 1

| Field | Exact observed value |
| --- | --- |
| Feed product name | ΠΟΛΥΘΡΟΝΑ ΤΡΑΠΕΖΑΡΙΑΣ SHANKS HM6207.01 ΣΚΟΥΡΟ ΓΚΡΙ ΑΛΟΥΜ. & OLEFIN ΥΦΑΣΜΑ 62x60x75-80Υεκ |
| Feed identifier / exact field | `0612644` in `<ProductCode>` |
| Previously matched identifier | `0612644` against variant.sku |
| Migrated feed identifier / exact field | `HM6207.01` in `<ItemCode>` |
| Shopify product title | Трапезен стол Устика от тъмносив алуминий и плат олефин 62x60x75-80Hcm |
| Shopify handle | `mc-73498` |
| Current Shopify variant SKU | `HM6207.01` |
| Shopify vendor | Europe |
| Tags | Трапезни столове |
| Variant metafields | None returned; pagination complete |
| Product metafields | None returned; pagination complete |
| Variant GID | `gid://shopify/ProductVariant/53513498657101` |
| ProductId corroboration | 73498 |
| Proposed stable matching field | Persisted `symetron:0612644` → `gid://shopify/ProductVariant/53513498657101` |

#### Example 2

| Field | Exact observed value |
| --- | --- |
| Feed product name | ΠΟΛΥΘΡΟΝΑ DEXTER SM6205.02 ΚΡΕΜ ΑΛΟΥΜΙΝΙΟ-ΜΠΕΖ P.E. ΣΧΟΙΝΙ & OLEFIN ΥΦΑΣΜΑ-ΤΕΑΚ ΜΠΡΑΤΣΑ |
| Feed identifier / exact field | `0612641` in `<ProductCode>` |
| Previously matched identifier | `0612641` against variant.sku |
| Migrated feed identifier / exact field | `SM6205.02` in `<ItemCode>` |
| Shopify product title | Полутрап Версай крем алуминий-беж P.E. въже & Olefin плат-тек ръкохват |
| Shopify handle | `mc-0612641` |
| Current Shopify variant SKU | `SM6205.02` |
| Shopify vendor | Europe |
| Tags | Градина; Градински мебели; Градински столове; Градински фотьойли |
| Variant metafields | None returned; pagination complete |
| Product metafields | global.title_tag; global.description_tag; reelfy.rf_stories_product; reelfy.rf_section_product; reelfy.rf_pops_product; reelfy.productVideos (SEO/video fields; no supplier identity) |
| Variant GID | `gid://shopify/ProductVariant/53839198617933` |
| ProductId corroboration | 73810 |
| Proposed stable matching field | Persisted `symetron:0612641` → `gid://shopify/ProductVariant/53839198617933` |

#### Example 3

| Field | Exact observed value |
| --- | --- |
| Feed product name | ΠΟΛΥΘΡΟΝΑ DEXTER SM6205.01 ΣΚΟΥΡΟ ΓΚΡΙ ΑΛΟΥΜΙΝΙΟ-ΣΧΟΙΝΙ-OLEFIN ΜΑΞΙΛΑΡΙ-ΤΕΑΚ ΜΠΡΑΤΣΑ |
| Feed identifier / exact field | `0612642` in `<ProductCode>` |
| Previously matched identifier | `0612642` against variant.sku |
| Migrated feed identifier / exact field | `SM6205.01` in `<ItemCode>` |
| Shopify product title | Полутрапезна фотьойл Версай тъмно сив алуминий-въже-Olefin възглавница |
| Shopify handle | `mc-0612642` |
| Current Shopify variant SKU | `SM6205.01` |
| Shopify vendor | Europe |
| Tags | Градина; Градински мебели; Градински столове; Градински фотьойли |
| Variant metafields | None returned; pagination complete |
| Product metafields | global.title_tag; global.description_tag; reelfy.rf_stories_product; reelfy.rf_section_product; reelfy.rf_pops_product; reelfy.productVideos (SEO/video fields; no supplier identity) |
| Variant GID | `gid://shopify/ProductVariant/53839198847309` |
| ProductId corroboration | 73811 |
| Proposed stable matching field | Persisted `symetron:0612642` → `gid://shopify/ProductVariant/53839198847309` |

## Concrete conflicts

### Duplicate migrated SKU HM6006

| Feed ProductCode | ProductId | ItemCode | Quantity | Shopify handle | Shopify variant |
| --- | --- | --- | ---: | --- | --- |
| 0612089 | 43342 | HM6006 | 21 | mc-43342 | gid://shopify/ProductVariant/53473106297165 |
| 0597486 | 72025 | HM6006 | 0 | mc-72025 | gid://shopify/ProductVariant/53511722467661 |

The first is a whole umbrella, the second its replacement canopy. Matching only ItemCode cannot choose the correct quantity. ProductCode remains distinct. Other collisions include HM6002 and HM1018.01.

### Shared B2BMarkt/Symetron product

Both live feeds contain ProductCode 0612644, ProductId 73498, ItemCode HM6207.01, barcode 5208067179614, quantity 165. Both resolve to variant gid://shopify/ProductVariant/53513498657101, handle mc-73498, vendor Europe. Tags and sampled metafields do not establish exclusive supplier ownership. Equal quantities today do not establish a future source-precedence rule.

## Proposed architecture and required decision

1. Central supplier configuration binds feed URL selection, exact identity field (model / ProductCode), quantity field, adapter and destination resolver. Preserve strings and leading zeros exactly. ItemCode/sku are migration evidence, not permanent keys. ProductId and barcode corroborate initial backfill.
2. Persist an auditable registry keyed by (supplier, supplierProductId), mapping to a Shopify variant GID and, separately, a portal product ID. Enforce uniqueness of supplier identity and exclusive stock ownership of each destination entity. A database/file registry avoids changing unrelated Shopify fields; variant metafields would require a separately authorized backfill and are not part of this read-only audit.
3. Bootstrap only unique, corroborated candidates from legacy handles, ProductId, barcodes, old/new SKUs and migration evidence. Do not use handle as the permanent integration key: it is product-level and editable. A product with multiple variants must have variant-specific evidence. No title/fuzzy matching.
4. Classify feed rows and destination identities with explicit missing, malformed, duplicate-feed, duplicate-destination, cross-supplier-ownership and unmatched reasons. Never apply ambiguous matches, malformed quantities or implied zero for missing feed rows.
5. Use one classifier for Preview and Apply. Persist the preview plan and matching evidence; revalidate identity, supplier ownership and location-specific quantity immediately before guarded writes. Show feed/valid/matched/unmatched/conflicting/change/already-correct/skipped/error counts and inspectable rows. Preserve retry/throttling and portal threshold behavior.
6. Add Symetron through the existing platform adapter, including feed choice, quantity handling, both destination registrations only where portal ownership is established, UI card and tests.

Decision needed before an exclusive registry can be populated: should the shared product 0612644 / HM6207.01 receive stock from B2BMarkt or Symetron? Until resolved, block it under both suppliers. Remaining mappings without unique corroborating evidence must remain unresolved, never guessed. Negative supplier quantities also need a confirmed policy; default recommendation is skip/report rather than write or silently clamp.

## Verification and scope

- npm test: all 84 existing tests passed.
- npm run typecheck and npm run check:backend: both passed.
- Official Shopify toolkit validated the read-only audit queries against 2026-10. It could not validate/search 2025-10 because that version is absent from its supported list. Live requests used the repo-configured API version; no API-version configuration was changed. Query reference: https://shopify.dev/docs/api/admin-graphql/2026-10/queries/productVariants
- No application build was run during this audit because it regenerates existing tracked public assets; full build belongs after implementation.
- B2BCenter implementation was inspected statically. Portal products/schema were not queried live; portal identity ownership has not been proven by this audit.
- No inventory, SKU, price, title, tag, metafield, product or portal field was changed. Application implementation remains pending the mapping/ownership review required by the user.
- Raw read-only snapshots and helper scripts are in ignored .tmp/inventory-identity-*. Files contain no access tokens or feed URLs.
