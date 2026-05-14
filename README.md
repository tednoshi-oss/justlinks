# JustLinks

Simple smart-link dashboard with three app sections: Dashboard, Links, and Analytics.

## Run locally

```bash
npm install
npm run build
npm run start
```

Open `http://localhost:4174/dashboard/links`.

## What is included

- Dashboard metrics, top links, and recent click activity.
- Link creation with title, destination URL, random/custom short code, notes, deep-link toggle, tags, and local stats.
- Redirect route at `/:slug` with device-aware routing. `/l/:slug` still works as a compatibility alias.
- Analytics for clicks over time, device, country, referrer, link performance, and recent events.
- Local JSON persistence for development.

## Redirect behavior

`/d-api-reference` detects the user agent and redirects to:

- iOS: `iosUrl`
- Android: `androidUrl`
- Desktop: `webUrl`
- Other: `fallbackUrl`

For testing, append `?target=ios`, `?target=android`, or `?target=web`.

## Production scale plan

The production setup separates the dashboard from public redirects:

- Render runs the dashboard/admin API.
- Cloudflare Worker runs the public `justlinks.cc/:slug` redirect path.
- Cloudflare KV stores active link configs at the edge.
- Cloudflare Queues buffers click events before sending them back to the dashboard API.
- Render remains the source of truth for links, groups, and analytics display.

That architecture lets the public redirect route absorb traffic spikes while analytics catches up safely in the background. The current app still includes the Node redirect route as a development/fallback path, but production should route `justlinks.cc/*` through the Cloudflare Worker.

## Deploy on Render

This repo includes `render.yaml`, which creates a Node web service with:

- Build command: `npm ci && npm run build`
- Start command: `npm run start`
- Health check: `/api/health`
- Persistent storage mounted at `/opt/render/project/src/storage`
- `DATA_DIR=/opt/render/project/src/storage`

Use Render's Blueprint flow from a Git repository. The persistent disk requires a paid Render web service; without a disk, local file changes such as links and analytics are lost when the service restarts.

Set these Render environment variables after the Cloudflare resources exist:

- `EDGE_SYNC_SECRET`: a long random secret shared with the Worker.
- `CF_ACCOUNT_ID`: your Cloudflare account ID.
- `CF_KV_NAMESPACE_ID`: the KV namespace ID for link configs.
- `CF_API_TOKEN`: Cloudflare API token with permission to edit that KV namespace.

After those are set, creating/updating/deleting links in the dashboard syncs them to Cloudflare KV automatically. You can also trigger a full sync with:

```bash
curl -X POST "$RENDER_URL/api/edge/sync" \
  -H "Authorization: Bearer $EDGE_SYNC_SECRET"
```

## Deploy Cloudflare Worker

The Worker lives in `worker/` and is configured by `worker/wrangler.toml`.

Create Cloudflare resources:

```bash
npx wrangler kv namespace create JUSTLINKS_LINKS --config worker/wrangler.toml
npx wrangler kv namespace create JUSTLINKS_LINKS --preview --config worker/wrangler.toml
npx wrangler queues create justlinks-click-events
```

Then put the KV namespace IDs into `worker/wrangler.toml`, set `DASHBOARD_ORIGIN` to the Render `onrender.com` URL, and add the shared secret:

```bash
npx wrangler secret put EDGE_SYNC_SECRET --config worker/wrangler.toml
npm run worker:deploy
```

Cloudflare DNS should proxy `justlinks.cc` and `www.justlinks.cc`. The Worker routes in `worker/wrangler.toml` send dashboard/API/assets to Render and handle short-link redirects at the edge.
