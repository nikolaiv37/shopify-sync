# Deploy Mebelcenter Operations to Vercel

Recommended production domain:

```text
ops.mebelcenter.bg
```

Use `ops.mebelcenter.bg` instead of `sync.mebelcenter.bg` because the long-term
goal is a broader operations panel, not only inventory sync.

## 1. Connect the Repository

1. Push this repository to GitHub.
2. In Vercel, choose `Add New Project`.
3. Import the GitHub repository.
4. Keep the root directory as the repository root.
5. Use the default install command: `npm install`.
6. Use the build command: `npm run vercel-build`.

The app uses [api/index.js](/Users/nikolaiv37/projects/mebelcenter-shopify/api/index.js)
as the serverless dashboard entrypoint. [vercel.json](/Users/nikolaiv37/projects/mebelcenter-shopify/vercel.json)
routes `/`, `/dashboard`, and `/api/*` through that handler.

## 2. Add Environment Variables

Add these in Vercel Project Settings -> Environment Variables:

```env
SHOPIFY_STORE_DOMAIN=mebel-center.myshopify.com
SHOPIFY_CLIENT_ID=your-shopify-custom-app-client-id
SHOPIFY_CLIENT_SECRET=your-shopify-custom-app-client-secret
SHOPIFY_API_VERSION=2025-10
OPENROUTER_API_KEY=your-openrouter-key-if-used
DASHBOARD_PASSWORD=use-a-strong-private-password
LOG_DIR=./logs
BATCH_SIZE=50
```

Optional:

```env
SHOPIFY_LOCATION_ID=gid://shopify/Location/...
MEGAPAP_FEED_URL=https://...
B2BMARKT_FEED_URL=https://...
```

Do not commit real secrets. Local secrets belong only in `.env`, which is
ignored by git.

## 3. Deploy

Deploy through the Vercel dashboard or by pushing to the production branch.

The project includes a Vercel function duration setting:

```json
{
  "functions": {
    "api/index.js": {
      "maxDuration": 300
    }
  }
}
```

Actual maximum duration depends on the Vercel plan. If a full apply run takes
longer than the plan allows, the request can time out even though the local CLI
works. For this manual v1, test dry runs first and keep the CLI available as the
fallback for long operations.

## 4. Test Login

1. Open the Vercel deployment URL.
2. Log in with `DASHBOARD_PASSWORD`.
3. Confirm `/dashboard` loads.
4. Click `Logout`.
5. Confirm `/dashboard` redirects back to login when logged out.

## 5. Test Dry Run First

Start with:

```text
Megapap Dry Run
```

Then test:

```text
B2BMarkt Dry Run
```

Expected result:

- Status changes while the run is active.
- Buttons are disabled while running.
- Logs appear in the log panel.
- Summary shows `Mode: Dry Run`.
- `Updated` remains `0` for dry runs.
- `Planned`, `Skipped`, and `Errors` reflect the current Shopify/XML state.

## 6. Test Apply Sync

Only after a successful dry run, click:

```text
Megapap Apply Sync
```

The browser confirmation must say:

```text
This will update Shopify inventory for megapap. Did you run a dry run first?
```

Then repeat for:

```text
B2BMarkt Apply Sync
```

Expected result:

- Confirmation is required.
- Buttons are disabled while running.
- Summary returns updated, errors, skipped, planned, elapsed, supplier, mode,
  logs, and log file paths.

## 7. Add the Custom Domain

In Vercel Project Settings -> Domains, add:

```text
ops.mebelcenter.bg
```

Then create the DNS record Vercel provides. Keep access protected by
`DASHBOARD_PASSWORD`.

## 8. Logs on Vercel

Local runs write to `./logs`.

Vercel serverless functions cannot reliably persist project-folder logs. When
running on Vercel and `LOG_DIR` is relative, the dashboard writes to:

```text
/tmp/mebelcenter-logs
```

This is safe for function writes, but temporary. For durable hosted history, add
Supabase, Vercel Blob, or Postgres later.

## 9. What Is Not Enabled Yet

- No automatic cron runs.
- No price sync dashboard controls.
- No product deletion.
- No out-of-stock cleanup logic.
- No durable hosted run database.
