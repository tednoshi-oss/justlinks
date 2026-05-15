import {
  classifyReferrer,
  deepLinkEscapeUrl,
  detectBrowser,
  detectDevice,
  type EdgeClickEvent,
  type EdgeLinkConfig,
  isLinkPreviewBot,
  isEscapedBrowserRequest,
  isHttpUrl,
  isMobileDevice,
  isDashboardPath,
  parseHtmlMetadata,
  previewFetchUrl,
  renderDeepLinkEscapePage,
  renderLinkPreviewPage,
  selectWebFallback,
  selectDestination,
  shouldServeFastDeepLinkEscape,
  shouldUseBrowserEscape,
  slugFromPath
} from "../shared/edge";

interface Env {
  TAPSOCIALS_LINKS: KVNamespace;
  TAPSOCIALS_CLICK_QUEUE?: Queue<EdgeClickEvent>;
  DASHBOARD_ORIGIN: string;
  EDGE_SYNC_SECRET?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Queue<T = unknown> {
  send(message: T): Promise<void>;
}

interface Message<T = unknown> {
  body: T;
}

interface MessageBatch<T = unknown> {
  messages: Message<T>[];
}

interface KVNamespace {
  get<T = string>(key: string, options?: { type?: "json" | "text" }): Promise<T | null>;
  list(options?: { cursor?: string; limit?: number; prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/__edge/")) {
      return handleEdgeSyncRequest(request, env, url);
    }

    if (isDashboardApiPath(url.pathname)) {
      return proxyDashboardApi(request, env, url);
    }

    if (isDashboardPath(url.pathname)) {
      return redirectToDashboard(url, env);
    }

    const slug = slugFromPath(url.pathname);
    if (!slug) return notFound();

    const userAgent = request.headers.get("user-agent") || "";
    if (isLinkPreviewBot(userAgent) && !isEscapedBrowserRequest(url.searchParams)) {
      const previewLink = await getEdgeLink(slug, env, context);
      if (!previewLink || previewLink.status !== "active") return notFound();
      return htmlResponse(await renderPreviewForLink(previewLink, request.url), 200, previewHeaders());
    }

    if (
      shouldServeFastDeepLinkEscape({
        pathname: url.pathname,
        searchParams: url.searchParams,
        userAgent,
        referrer: request.headers.get("referer")
      })
    ) {
      return htmlResponse(renderDeepLinkEscapePage(deepLinkEscapeUrl(request.url), userAgent), 200, noCacheHeaders());
    }

    const link = await getEdgeLink(slug, env, context);
    if (!link || link.status !== "active") return notFound();

    const device = detectDevice(userAgent, url.searchParams.get("target") || "");
    const webDestination = selectWebFallback(link);
    const browserEscape = shouldUseBrowserEscape(link);
    const destination = browserEscape ? webDestination : selectDestination(link, device);
    const click = await buildClickEvent(request, link, destination, device);

    if (env.TAPSOCIALS_CLICK_QUEUE) {
      context.waitUntil(env.TAPSOCIALS_CLICK_QUEUE.send(click));
    } else {
      context.waitUntil(sendClickBatchToDashboard([click], env));
    }

    if (browserEscape && isHttpUrl(webDestination) && isMobileDevice(device)) {
      if (isEscapedBrowserRequest(url.searchParams)) return Response.redirect(webDestination, 302);
      return htmlResponse(renderDeepLinkEscapePage(deepLinkEscapeUrl(request.url), userAgent), 200, noCacheHeaders());
    }

    return Response.redirect(destination, 302);
  },

  async queue(batch: MessageBatch<EdgeClickEvent>, env: Env): Promise<void> {
    await sendClickBatchToDashboard(batch.messages.map((message) => message.body), env);
  }
};

async function handleEdgeSyncRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAuthorizedEdgeRequest(request, env)) return jsonResponse({ error: "Unauthorized edge request." }, 401);

  if (request.method === "PUT" && url.pathname.startsWith("/__edge/links/")) {
    const pathSlug = decodeURIComponent(url.pathname.replace("/__edge/links/", ""));
    const link = await readJson<EdgeLinkConfig>(request);
    if (!link?.slug || link.slug !== pathSlug) return jsonResponse({ error: "Invalid link payload." }, 400);
    await env.TAPSOCIALS_LINKS.put(`link:${link.slug}`, JSON.stringify(link));
    return jsonResponse({ ok: true, synced: 1 });
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/__edge/links/")) {
    const slug = decodeURIComponent(url.pathname.replace("/__edge/links/", ""));
    if (!slug) return jsonResponse({ error: "Missing slug." }, 400);
    await env.TAPSOCIALS_LINKS.delete(`link:${slug}`);
    return jsonResponse({ ok: true, deleted: 1 });
  }

  if (request.method === "POST" && url.pathname === "/__edge/sync") {
    const body = await readJson<{ links?: EdgeLinkConfig[] }>(request);
    const links = Array.isArray(body?.links) ? body.links : [];
    const expectedKeys = new Set(links.filter((link) => link?.slug).map((link) => `link:${link.slug}`));
    await Promise.all(
      links
        .filter((link) => link?.slug)
        .map((link) => env.TAPSOCIALS_LINKS.put(`link:${link.slug}`, JSON.stringify(link)))
    );
    const deleted = await pruneMissingLinks(expectedKeys, env);
    return jsonResponse({ ok: true, synced: links.length, deleted });
  }

  return jsonResponse({ error: "Not found." }, 404);
}

async function pruneMissingLinks(expectedKeys: Set<string>, env: Env): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const page = await env.TAPSOCIALS_LINKS.list({ prefix: "link:", cursor });
    const staleKeys = page.keys.filter((key) => !expectedKeys.has(key.name));
    await Promise.all(staleKeys.map((key) => env.TAPSOCIALS_LINKS.delete(key.name)));
    deleted += staleKeys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return deleted;
}

async function getEdgeLink(slug: string, env: Env, context: ExecutionContext): Promise<EdgeLinkConfig | null> {
  const cached = await env.TAPSOCIALS_LINKS.get<EdgeLinkConfig>(`link:${slug}`, { type: "json" });
  if (cached) return cached;

  const fallback = await fetchDashboardJson<EdgeLinkConfig>(`/api/edge/links/${encodeURIComponent(slug)}`, env);
  if (!fallback) return null;
  context.waitUntil(env.TAPSOCIALS_LINKS.put(`link:${fallback.slug}`, JSON.stringify(fallback)));
  return fallback;
}

async function renderPreviewForLink(link: EdgeLinkConfig, shortUrl: string): Promise<string> {
  const destination = selectWebFallback(link);
  const metadata = await fetchPreviewMetadata(destination, link);
  return renderLinkPreviewPage(metadata, shortUrl, destination);
}

async function fetchPreviewMetadata(destination: string, link: EdgeLinkConfig) {
  const fetchUrl = previewFetchUrl(destination);
  const fallback = fallbackPreviewMetadata(destination, link);

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "TelegramBot (like TwitterBot)"
      }
    });
    if (!response.ok) return fallback;
    const html = await response.text();
    const parsed = parseHtmlMetadata(html, response.url || fetchUrl);
    return {
      title: parsed.title || fallback.title,
      description: parsed.description || fallback.description,
      image: parsed.image || fallback.image,
      siteName: parsed.siteName || fallback.siteName,
      url: parsed.url || fallback.url
    };
  } catch {
    return fallback;
  }
}

function fallbackPreviewMetadata(destination: string, link: EdgeLinkConfig) {
  const host = safeHost(destination);
  return {
    title: link.name || host || "TapSocials link",
    description: link.description || destination,
    image: undefined,
    siteName: host || "TapSocials",
    url: destination
  };
}

function safeHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function buildClickEvent(request: Request, link: EdgeLinkConfig, destination: string, device: EdgeClickEvent["device"]): Promise<EdgeClickEvent> {
  const userAgent = request.headers.get("user-agent") || "";
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
  return {
    id: crypto.randomUUID(),
    linkId: link.id,
    slug: link.slug,
    occurredAt: new Date().toISOString(),
    device,
    browser: detectBrowser(userAgent),
    country: request.headers.get("cf-ipcountry") || "Unknown",
    referrer: classifyReferrer(request.headers.get("referer")),
    visitorKey: await hashVisitor(`${ip}:${userAgent}`),
    destination
  };
}

async function sendClickBatchToDashboard(events: EdgeClickEvent[], env: Env): Promise<void> {
  if (!events.length) return;
  await fetchDashboardJson("/api/edge/clicks/batch", env, {
    method: "POST",
    body: JSON.stringify({ events })
  });
}

async function fetchDashboardJson<T>(pathname: string, env: Env, init: RequestInit = {}): Promise<T | null> {
  const origin = env.DASHBOARD_ORIGIN.replace(/\/+$/, "");
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(env.EDGE_SYNC_SECRET ? { Authorization: `Bearer ${env.EDGE_SYNC_SECRET}` } : {}),
      ...(init.headers || {})
    }
  });

  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

function redirectToDashboard(url: URL, env: Env): Response {
  const destination = new URL(env.DASHBOARD_ORIGIN);
  destination.pathname = url.pathname === "/" ? "/dashboard/links" : url.pathname;
  destination.search = url.search;
  destination.hash = url.hash;
  return Response.redirect(destination.toString(), 302);
}

function isDashboardApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function proxyDashboardApi(request: Request, env: Env, url: URL): Promise<Response> {
  const origin = new URL(env.DASHBOARD_ORIGIN);
  const destination = new URL(`${url.pathname}${url.search}`, origin);
  const headers = new Headers(request.headers);
  headers.set("host", origin.host);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return fetch(destination.toString(), init);
}

function isAuthorizedEdgeRequest(request: Request, env: Env): boolean {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(env.EDGE_SYNC_SECRET && provided === env.EDGE_SYNC_SECRET);
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function notFound(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#09090b;color:#f2f2f3}main{width:min(420px,calc(100vw - 32px));border:1px solid #27272f;border-radius:12px;background:#0f0f12;padding:28px}p{color:#8d8d98}</style></head><body><main><h1>Link unavailable</h1><p>This link is paused, deleted, or does not exist.</p></main></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function htmlResponse(html: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...extraHeaders
    }
  });
}

function noCacheHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-cache, must-revalidate, max-age=0",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff"
  };
}

function previewHeaders(): HeadersInit {
  return {
    "Cache-Control": "public, max-age=600",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff"
  };
}

function openInBrowserPage(destination: string): Response {
  const safeDestination = escapeHtml(destination);
  const jsDestination = JSON.stringify(destination);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1;url=${safeDestination}"><title>Opening link</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#09090b;color:#f2f2f3}main{width:min(420px,calc(100vw - 32px));border:1px solid #27272f;border-radius:10px;background:#0f0f12;padding:28px}h1{margin:0 0 8px;font-size:22px}p{margin:0 0 18px;color:#a1a1aa;line-height:1.5}a{display:inline-flex;min-height:42px;align-items:center;justify-content:center;border-radius:8px;background:#22d3ee;color:#071014;padding:0 14px;font-weight:700;text-decoration:none}</style><script>window.setTimeout(function(){window.location.replace(${jsDestination});},250);</script></head><body><main><h1>Opening link</h1><p>If your social app keeps this page inside its browser, use the app menu and choose Open in browser.</p><a href="${safeDestination}" rel="noreferrer">Continue</a></main></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === "\"") return "&quot;";
    return "&#039;";
  });
}

async function hashVisitor(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}
