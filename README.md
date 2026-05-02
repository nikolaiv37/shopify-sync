# Mebelcenter Supplier Sync

Fetches supplier XML feeds (Megapap + B2BMarkt) and pushes inventory updates
into Shopify, scoped to the matching vendor.

| Supplier  | Shopify vendor | SKU tag         | Stock tag   |
| --------- | -------------- | --------------- | ----------- |
| Megapap   | `Mebelcenter`  | `<model>`       | `<quantity>` |
| B2BMarkt  | `Europe`       | `<ProductCode>` | `<Stock>`    |

Sync flow per supplier:

1. Download the XML feed over HTTPS.
2. Parse it into a `{sku → stock}` map.
3. Query Shopify for product IDs where `vendor` matches (exact).
4. Paginate all product variants on the store.
5. Intersect: keep variants whose product ID is in the vendor set.
6. Match SKU → plan updates; drop missing, untracked, and unchanged.
7. Apply `inventorySetQuantities` (field-level `@idempotent` directive,
   `name: "available"`, `changeFromQuantity` guard) in batches of 50.
8. Write a per-run log (JSON + readable text) to `logs/`.

## Setup

```bash
cp .env.example .env     # fill in the values
npm install
```

Required `.env` values:

- `SHOPIFY_STORE_DOMAIN` — `mebel-center.myshopify.com`
- `SHOPIFY_CLIENT_ID` — client ID of your Shopify custom app
- `SHOPIFY_CLIENT_SECRET` — client secret of that same custom app
  (starts with `shpss_`)

The custom app needs these Admin API scopes: `read_products`, `read_inventory`,
`read_locations`, `write_inventory`.

No long-lived Admin API token is stored. At the start of every run the script
calls `POST https://<shop>/admin/oauth/access_token` with
`grant_type=client_credentials` and uses the short-lived token it receives for
the rest of that run.

Optional `.env` values:

- `SHOPIFY_API_VERSION` (default `2025-10`)
- `SHOPIFY_LOCATION_ID` (auto-discovered if omitted)
- `BATCH_SIZE` (default `50`)
- `LOG_DIR` (default `./logs`)
- `MEGAPAP_FEED_URL` / `B2BMARKT_FEED_URL` — override default feed URLs

## Run

```bash
npm run sync              # both suppliers
npm run sync:megapap      # only Megapap → Mebelcenter
npm run sync:b2bmarkt     # only B2BMarkt → Europe

# equivalent direct invocation
node sync.js all
node sync.js megapap
node sync.js b2bmarkt
```

Exit code `0` on full success, `1` if any row failed or a supplier crashed.

## Cron

Run daily at 03:15 local time:

```cron
15 3 * * * cd /Users/nikolaiv37/projects/mebelcenter-shopify && /usr/local/bin/node sync.js all >> logs/cron.out 2>&1
```

Notes for cron:

- Use absolute paths (cron's `PATH` is minimal).
- `/usr/local/bin/node` — replace with `which node` on the box.
- The script respects `.env`, so cron does not need env vars configured.
- Each run also writes a structured log to `logs/<supplier>-<timestamp>.json`.

## Log format

`logs/<supplier>-<YYYY-MM-DDTHH-MM-SS>.json` example:

```json
{
  "date": "2026-04-20T12:34:56.000Z",
  "supplier": "megapap",
  "vendor": "Mebelcenter",
  "storeDomain": "mebel-center.myshopify.com",
  "apiVersion": "2025-10",
  "locationId": "gid://shopify/Location/104700412237",
  "counts": {
    "supplierSkus": 3572,
    "vendorProducts": 3014,
    "storeVariants": 11239,
    "vendorVariants": 3014,
    "planned": 1227,
    "updated": 1227,
    "errors": 0,
    "skipped": { "notInXml": 79, "untracked": 0, "unchanged": 1708, "total": 1787 }
  },
  "elapsedSeconds": 87.4,
  "errorDetail": []
}
```

A plain-text twin `logs/<...>.log` is also written for quick `tail`.
