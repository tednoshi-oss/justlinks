# TapSocials

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
- User signup/login with private links, groups, and analytics per account.
- Link creation with title, destination URL, mobile deep-link targets, random/custom short code, notes, tags, external-browser helper mode, and local stats.
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

External-browser helper mode can wrap Android web destinations in an `intent://` URL from social in-app browsers. iOS does not allow a website to force Safari from every embedded browser, so iOS receives a small fallback page with an automatic continue plus manual open option when an in-app browser blocks the handoff.

## Production scale plan

The production setup separates the dashboard from public redirects:

- Render runs the dashboard/admin API.
- Cloudflare Worker runs the public `tapsocials.com/:slug` redirect path.
- Cloudflare KV stores active link configs at the edge.
- Cloudflare Queues buffers click events before sending them back to the dashboard API.
- Render remains the source of truth for links, groups, and analytics display.

That architecture lets the public redirect route absorb traffic spikes while analytics catches up safely in the background. The current app still includes the Node redirect route as a development/fallback path, but production should route `tapsocials.com/*` through the Cloudflare Worker.

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
- `EDGE_WORKER_SYNC_URL`: the Worker sync endpoint, for example `https://tapsocials.com/__edge`.

Password reset emails are sent through [Resend](https://resend.com). To enable them:

- `RESEND_API_KEY`: an API key from the Resend dashboard (set this as a secret; without it, reset links are only logged to the server console).
- `EMAIL_FROM`: the sender address, for example `TapSocials <noreply@tapsocials.com>`. The domain must be verified in Resend. For a quick test without a verified domain, use `onboarding@resend.dev` (only delivers to your own Resend account email).
- `APP_BASE_URL`: the public site URL used to build reset links, for example `https://tapsocials.com`.

After those are set, creating/updating/deleting links in the dashboard syncs them to Cloudflare KV automatically. You can also trigger a full sync with:

```bash
curl -X POST "$RENDER_URL/api/edge/sync" \
  -H "Authorization: Bearer $EDGE_SYNC_SECRET"
```

## Deploy Cloudflare Worker

The Worker lives in `worker/` and is configured by `worker/wrangler.toml`.

Create Cloudflare resources:

```bash
npx wrangler kv namespace create TAPSOCIALS_LINKS --config worker/wrangler.toml
npx wrangler kv namespace create TAPSOCIALS_LINKS --preview --config worker/wrangler.toml
npx wrangler queues create tapsocials-click-events
```

Then put the KV namespace IDs into `worker/wrangler.toml`, set `DASHBOARD_ORIGIN` to the Render `onrender.com` URL, and add the shared secret:

```bash
npx wrangler secret put EDGE_SYNC_SECRET --config worker/wrangler.toml
npm run worker:deploy
```

Cloudflare DNS should proxy `tapsocials.com` and `www.tapsocials.com`. The Worker routes in `worker/wrangler.toml` send dashboard/API/assets to Render and handle short-link redirects at the edge.
