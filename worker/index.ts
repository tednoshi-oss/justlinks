import {
  classifyReferrer,
  deepLinkEscapeUrl,
  detectBrowser,
  detectDevice,
  type EdgeClickEvent,
  type EdgeLinkConfig,
  isCountryBlocked,
  isLinkPreviewBot,
  isEscapedBrowserRequest,
  isHttpUrl,
  isMobileDevice,
  isDashboardPath,
  normalizeCountryCode,
  parseHtmlMetadata,
  previewFetchUrl,
  renderCountryBlockedPage,
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

    if (url.pathname === "/debug/open" || url.pathname.startsWith("/debug/open/")) {
      return handleDebugOpenRequest(url);
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

    const country = normalizeCountryCode(request.headers.get("cf-ipcountry"));
    if (isCountryBlocked(link, country)) {
      return new Response(renderCountryBlockedPage(country), {
        status: 451,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "strict-origin-when-cross-origin",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

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

const debugOpenTargetSlug = "d-pctdmkl7";
const debugOpenVariants = [
  ["a", "ForLinks order", "x-safari first, Safari tab second"],
  ["b", "Safari tab first", "com-apple-mobilesafari-tab first, x-safari second"],
  ["c", "Anchor click", "iOS opens Safari, Android opens Chrome"],
  ["d", "window.open", "window.open to x-safari"],
  ["e", "replace", "location.replace to x-safari"],
  ["f", "meta refresh", "meta refresh to x-safari"],
  ["g", "302 scheme", "edge 302 redirect to x-safari"],
  ["h", "shortcut fallback", "Shortcuts x-error then Safari"],
  ["i", "Android default intent", "anchor click to Android default browser"],
  ["j", "Android Chrome action", "anchor click to Chrome with browsable action"],
  ["k", "Android Samsung intent", "anchor click to Samsung Internet"],
  ["l", "Android real tap", "manual tap intent to test Reddit blocking"]
] as const;

function handleDebugOpenRequest(url: URL): Response {
  const variant = url.pathname.replace(/^\/debug\/open\/?/, "").toLowerCase() || "";
  const target = debugOpenTarget(url);
  const safari = safariSchemeUrl(target);
  const safariTab = `com-apple-mobilesafari-tab:${target}`;
  const androidDefaultIntent = androidIntentUrl(target);
  const androidChromeIntent = androidIntentUrl(target, "chrome-action");
  const androidSamsungIntent = androidIntentUrl(target, "samsung");

  if (!variant) {
    return htmlResponse(renderDebugOpenIndex(url, target), 200, noCacheHeaders());
  }

  if (!debugOpenVariants.some(([id]) => id === variant)) {
    return htmlResponse(renderDebugOpenIndex(url, target), 404, noCacheHeaders());
  }

  if (variant === "g") {
    return new Response(null, {
      status: 302,
      headers: {
        Location: safari,
        ...noCacheHeaders()
      }
    });
  }

  return htmlResponse(renderDebugOpenVariant(variant, target, safari, safariTab, androidDefaultIntent, androidChromeIntent, androidSamsungIntent), 200, noCacheHeaders());
}

function debugOpenTarget(url: URL): string {
  const requestedSlug = url.searchParams.get("slug") || debugOpenTargetSlug;
  const slug = /^d-[a-zA-Z0-9_-]{3,64}$/.test(requestedSlug) ? requestedSlug : debugOpenTargetSlug;
  const target = new URL(`/${slug}`, url.origin);
  target.searchParams.set("escaped", "1");
  return target.toString();
}

function safariSchemeUrl(target: string): string {
  return `x-safari-https://${target.replace(/^https?:\/\//, "")}`;
}

function androidIntentUrl(target: string, browser: "default" | "chrome-action" | "samsung" = "default"): string {
  const url = new URL(target);
  const packageName = browser === "chrome-action" ? "package=com.android.chrome;" : browser === "samsung" ? "package=com.sec.android.app.sbrowser;" : "";
  const action = browser === "chrome-action" ? "action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;" : "";
  return `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=https;${action}${packageName}S.browser_fallback_url=${encodeURIComponent(target)};end`;
}

function renderDebugOpenIndex(url: URL, target: string): string {
  const links = debugOpenVariants
    .map(([id, name, description]) => {
      const href = new URL(`/debug/open/${id}`, url.origin);
      href.searchParams.set("slug", new URL(target).pathname.replace("/", ""));
      return `<a href="${escapeHtml(href.toString())}"><strong>${escapeHtml(id.toUpperCase())}. ${escapeHtml(name)}</strong><span>${escapeHtml(description)}</span></a>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TapSocials Open Test</title>${debugOpenStyles()}</head><body><main><p class="eyebrow">TapSocials debug</p><h1>Open Browser Test Lab</h1><p class="copy">Send each direct test link in Reddit and tap it from your iPhone. The one that opens Safari without the popup is the method we will move into production.</p><section>${links}</section><p class="target">Target: ${escapeHtml(target)}</p></main></body></html>`;
}

function renderDebugOpenVariant(variant: string, target: string, safari: string, safariTab: string, androidDefaultIntent: string, androidChromeIntent: string, androidSamsungIntent: string): string {
  const jsTarget = JSON.stringify(target);
  const jsSafari = JSON.stringify(safari);
  const jsSafariTab = JSON.stringify(safariTab);
  const jsAndroidDefaultIntent = JSON.stringify(androidDefaultIntent);
  const jsAndroidChromeIntent = JSON.stringify(androidChromeIntent);
  const jsAndroidSamsungIntent = JSON.stringify(androidSamsungIntent);
  const label = debugOpenVariants.find(([id]) => id === variant)?.[1] || "Test";
  let script = "";
  let extraHead = "";
  let manualAndroidTarget = "androidDefaultIntent";

  if (variant === "a") {
    script = `
      var uniqueUrl = target + (target.indexOf("?") === -1 ? "?" : "&") + "_t=" + Date.now() + Math.random().toString(36).slice(2, 6);
      var w = uniqueUrl.replace(/^https?:\\/\\//, "");
      window.location.href = "x-safari-https://" + w;
      setTimeout(function () { window.location.href = "com-apple-mobilesafari-tab:" + uniqueUrl; }, 200);
    `;
  } else if (variant === "b") {
    script = `
      var uniqueUrl = target + (target.indexOf("?") === -1 ? "?" : "&") + "_t=" + Date.now() + Math.random().toString(36).slice(2, 6);
      window.location.href = "com-apple-mobilesafari-tab:" + uniqueUrl;
      setTimeout(function () { window.location.href = "x-safari-https://" + uniqueUrl.replace(/^https?:\\/\\//, ""); }, 200);
    `;
  } else if (variant === "c") {
    manualAndroidTarget = "androidChromeIntent";
    script = `
      var a = document.createElement("a");
      a.href = /Android/i.test(navigator.userAgent || "") ? androidChromeIntent : safari;
      a.target = "_self";
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
      if (!/Android/i.test(navigator.userAgent || "")) setTimeout(function () { window.location.href = safariTab; }, 200);
    `;
  } else if (variant === "d") {
    script = `
      window.open(safari, "_self");
      setTimeout(function () { window.open(safariTab, "_self"); }, 200);
    `;
  } else if (variant === "e") {
    script = `
      window.location.replace(safari);
      setTimeout(function () { window.location.replace(safariTab); }, 200);
    `;
  } else if (variant === "f") {
    extraHead = `<meta http-equiv="refresh" content="0;url=${escapeHtml(safari)}">`;
    script = `
      setTimeout(function () { window.location.href = safariTab; }, 200);
    `;
  } else if (variant === "h") {
    script = `
      var randomName = Math.random().toString(36).slice(2, 10);
      window.location.href = "shortcuts://x-callback-url/run-shortcut?name=" + randomName + "&x-error=" + encodeURIComponent(target);
      setTimeout(function () { window.location.href = safari; }, 150);
      setTimeout(function () { window.location.href = safariTab; }, 300);
    `;
  } else if (variant === "i") {
    script = `
      var a = document.createElement("a");
      a.href = androidDefaultIntent;
      a.target = "_self";
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
    `;
  } else if (variant === "j") {
    manualAndroidTarget = "androidChromeIntent";
    script = `
      var a = document.createElement("a");
      a.href = androidChromeIntent;
      a.target = "_self";
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
    `;
  } else if (variant === "k") {
    manualAndroidTarget = "androidSamsungIntent";
    script = `
      var a = document.createElement("a");
      a.href = androidSamsungIntent;
      a.target = "_self";
      a.rel = "noreferrer";
      document.body.appendChild(a);
      a.click();
    `;
  } else if (variant === "l") {
    script = "";
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${extraHead}<title>${escapeHtml(label)}</title>${debugOpenStyles()}</head><body><main><p class="eyebrow">Test ${escapeHtml(variant.toUpperCase())}</p><h1>${escapeHtml(label)}</h1><p class="copy">Trying to open your outside browser now. If Reddit shows no popup for this one, tell me the letter.</p><a class="button" href="${escapeHtml(safari)}">Open manually</a></main><script>
    (function () {
      var target = ${jsTarget};
      var safari = ${jsSafari};
      var safariTab = ${jsSafariTab};
      var androidDefaultIntent = ${jsAndroidDefaultIntent};
      var androidChromeIntent = ${jsAndroidChromeIntent};
      var androidSamsungIntent = ${jsAndroidSamsungIntent};
      var manual = document.querySelector(".button");
      if (manual && /Android/i.test(navigator.userAgent || "")) manual.href = ${manualAndroidTarget};
      ${script}
    })();
  </script></body></html>`;
}

function debugOpenStyles(): string {
  return `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,Inter,ui-sans-serif,system-ui,sans-serif}main{width:min(520px,calc(100vw - 32px));padding:28px}h1{margin:0 0 12px;font-size:28px;letter-spacing:0}.eyebrow{margin:0 0 8px;color:#0891b2;font-weight:800;text-transform:uppercase;font-size:12px;letter-spacing:.08em}.copy{margin:0 0 22px;color:#555;line-height:1.45}section{display:grid;gap:10px}a{display:flex;flex-direction:column;gap:4px;border:1px solid #ddd;border-radius:12px;padding:14px 16px;color:#111;text-decoration:none;background:#fafafa}.button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;border-color:#111;background:#111;color:#fff;font-weight:800}span{color:#666;font-size:14px}.target{margin-top:20px;color:#777;font-size:12px;word-break:break-all}</style>`;
}

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
