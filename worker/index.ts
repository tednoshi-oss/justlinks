import {
  classifyReferrer,
  detectBrowser,
  detectDevice,
  type EdgeClickEvent,
  type EdgeLinkConfig,
  isDashboardPath,
  selectDestination,
  slugFromPath
} from "../shared/edge";

interface Env {
  JUSTLINKS_LINKS: KVNamespace;
  JUSTLINKS_CLICK_QUEUE?: Queue<EdgeClickEvent>;
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
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (isDashboardPath(url.pathname)) {
      if (url.pathname === "/") return Response.redirect(`${url.origin}/dashboard/links`, 302);
      return proxyDashboard(request, env);
    }

    const slug = slugFromPath(url.pathname);
    if (!slug) return notFound();

    const link = await getEdgeLink(slug, env);
    if (!link || link.status !== "active") return notFound();

    const device = detectDevice(request.headers.get("user-agent") || "", url.searchParams.get("target") || "");
    const destination = selectDestination(link, device);
    const click = await buildClickEvent(request, link, destination, device);

    if (env.JUSTLINKS_CLICK_QUEUE) {
      context.waitUntil(env.JUSTLINKS_CLICK_QUEUE.send(click));
    } else {
      context.waitUntil(sendClickBatchToDashboard([click], env));
    }

    return Response.redirect(destination, 302);
  },

  async queue(batch: MessageBatch<EdgeClickEvent>, env: Env): Promise<void> {
    await sendClickBatchToDashboard(batch.messages.map((message) => message.body), env);
  }
};

async function getEdgeLink(slug: string, env: Env): Promise<EdgeLinkConfig | null> {
  const cached = await env.JUSTLINKS_LINKS.get<EdgeLinkConfig>(`link:${slug}`, { type: "json" });
  if (cached) return cached;

  const fallback = await fetchDashboardJson<EdgeLinkConfig>(`/api/edge/links/${encodeURIComponent(slug)}`, env);
  if (!fallback) return null;
  return fallback;
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

function proxyDashboard(request: Request, env: Env): Promise<Response> {
  const incoming = new URL(request.url);
  const origin = new URL(env.DASHBOARD_ORIGIN);
  incoming.protocol = origin.protocol;
  incoming.hostname = origin.hostname;
  incoming.port = origin.port;

  const headers = new Headers(request.headers);
  headers.set("host", origin.host);
  headers.set("x-forwarded-host", new URL(request.url).host);

  return fetch(new Request(incoming, { method: request.method, headers, body: request.body, redirect: "manual" }));
}

function notFound(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#09090b;color:#f2f2f3}main{width:min(420px,calc(100vw - 32px));border:1px solid #27272f;border-radius:12px;background:#0f0f12;padding:28px}p{color:#8d8d98}</style></head><body><main><h1>Link unavailable</h1><p>This link is paused, deleted, or does not exist.</p></main></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function hashVisitor(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}
