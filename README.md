# Mebelcenter Operations

Private operations dashboard and CLI tools for syncing supplier inventory into
Shopify.

## What Works Today

Inventory sync is manual only. There are no cron jobs in this project.

| Supplier | Shopify vendor | Product tag | SKU tag | Stock tag |
| --- | --- | --- | --- | --- |
| Megapap | `Mebelcenter` | `<product>` | `<model>` | `<quantity>` |
| B2BMarkt | `Europe` | `<Product>` | `<ProductCode>` | `<Stock>` |

The sync only updates Shopify inventory quantities. It does not change product
titles, prices, vendors, tags, status, collections, handles, metafields, or
product cleanup state.

## Architecture

- [sync.js](/Users/nikolaiv37/projects/mebelcenter-shopify/sync.js) is the CLI wrapper.
- [lib/inventorySync.js](/Users/nikolaiv37/projects/mebelcenter-shopify/lib/inventorySync.js) contains the reusable inventory sync logic.
- [lib/dashboardApp.js](/Users/nikolaiv37/projects/mebelcenter-shopify/lib/dashboardApp.js) contains the password-protected dashboard and API handler.
- [dashboardServer.js](/Users/nikolaiv37/projects/mebelcenter-shopify/dashboardServer.js) runs the dashboard locally.
- [api/index.js](/Users/nikolaiv37/projects/mebelcenter-shopify/api/index.js) is the Vercel serverless entrypoint.

## Local Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`, log in with `DASHBOARD_PASSWORD`, and start with a
dry run.

## Dashboard

The dashboard is available at `/dashboard` after login.

Current controls:

- `Megapap Dry Run`
- `Megapap Apply Sync`
- `B2BMarkt Dry Run`
- `B2BMarkt Apply Sync`

Apply actions require browser confirmation:

```text
This will update Shopify inventory for [supplier]. Did you run a dry run first?
```

The dashboard displays run status, updated count, error count, skipped count,
planned count, elapsed time, supplier, mode, finished time, logs, and recent
inventory runs from the configured log folder.

## CLI Usage

Existing CLI behavior is preserved:

```bash
npm run sync              # both suppliers
npm run sync:megapap      # only Megapap -> Mebelcenter
npm run sync:b2bmarkt     # only B2BMarkt -> Europe

npm run dry-run           # both suppliers, no writes
npm run dry-run:megapap   # only Megapap, no writes
npm run dry-run:b2bmarkt  # only B2BMarkt, no writes

node sync.js
node sync.js all
node sync.js megapap
node sync.js b2bmarkt
node sync.js --dry-run
node sync.js megapap --dry-run
node sync.js b2bmarkt --dry-run
```

Exit code `0` means full success. Exit code `1` means at least one supplier
failed or returned row-level errors.

## Required Environment Variables

Set these locally in `.env` and in Vercel Project Settings:

```env
SHOPIFY_STORE_DOMAIN=mebel-center.myshopify.com
SHOPIFY_CLIENT_ID=replace-with-shopify-custom-app-client-id
SHOPIFY_CLIENT_SECRET=replace-with-shopify-custom-app-client-secret
SHOPIFY_API_VERSION=2025-10
OPENROUTER_API_KEY=replace-if-using-openrouter-tools
DASHBOARD_PASSWORD=replace-with-a-strong-password
LOG_DIR=./logs
BATCH_SIZE=50
```

Optional:

```env
DASHBOARD_PORT=3000
SHOPIFY_LOCATION_ID=gid://shopify/Location/...
MEGAPAP_FEED_URL=https://...
B2BMARKT_FEED_URL=https://...
```

The Shopify custom app needs these Admin API scopes:

```text
read_products
read_inventory
read_locations
write_inventory
```

Price sync tooling, if used separately, also needs `write_products`.

## Inventory Sync Behavior

Per supplier:

1. Download the supplier XML feed.
2. Parse it into a `SKU -> stock` map using the existing supplier tag mapping.
3. Query Shopify product IDs by vendor.
4. Defensively keep only exact vendor matches.
5. Paginate all Shopify variants.
6. Match by trimmed Shopify variant SKU.
7. Plan inventory quantity updates only for tracked, changed variants present in XML.
8. Apply `inventorySetQuantities` with `compareQuantity` in batches.
9. Write JSON and text logs.

The mutation intentionally uses `compareQuantity`, not `changeFromQuantity`, and
does not use `@idempotent`.

## Logs

Local runs write JSON and text logs to `LOG_DIR`, defaulting to `./logs`.

On Vercel, serverless function storage is ephemeral. When `LOG_DIR` is relative,
the dashboard writes logs to `/tmp/mebelcenter-logs` so each function invocation
can write safely, but those files are not durable. Recent runs on Vercel should
be treated as temporary visibility, not permanent audit history.

For long-term hosted history, add a durable store later such as Supabase, Vercel
Blob, or Postgres. This is intentionally not part of the current manual-only v1.

## Vercel

This project is Vercel-ready through [api/index.js](/Users/nikolaiv37/projects/mebelcenter-shopify/api/index.js)
and [vercel.json](/Users/nikolaiv37/projects/mebelcenter-shopify/vercel.json).

Vercel routes all requests to the dashboard handler so `/`, `/dashboard`, and
all `/api/*` endpoints are protected by the same password gate.

See [DEPLOYMENT.md](/Users/nikolaiv37/projects/mebelcenter-shopify/DEPLOYMENT.md)
for exact deployment steps.
