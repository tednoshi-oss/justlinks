import compression from "compression";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import {
  addClickEvent,
  addClickEvents,
  authenticateUser,
  createGroup,
  createLink,
  createSession,
  createUserAccount,
  deleteGroup,
  deleteLink,
  deleteSession,
  findLinkById,
  findLinkBySlug,
  getAnalytics,
  getSummary,
  getUserBySession,
  listGroups,
  listLinks,
  listRawLinks,
  updateGroup,
  updateLink
} from "./storage.js";
import { deleteLinkFromEdge, edgeClickToStoredClick, isEdgeSyncConfigured, syncLinksToEdge, syncLinkToEdge } from "./edge-sync.js";
import { classifyReferrer, detectBrowser, detectDevice, hashVisitor, selectDestination } from "./routing.js";
import { deepLinkEscapeUrl, isEscapedBrowserRequest, isHttpUrl, isLinkPreviewBot, isMobileDevice, parseHtmlMetadata, previewFetchUrl, renderDeepLinkEscapePage, renderLinkPreviewPage, selectWebFallback, shouldServeFastDeepLinkEscape, shouldUseBrowserEscape, toEdgeLink, type EdgeClickEvent } from "../shared/edge.js";
import type { AuthUser, ClickEvent, SmartLink } from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 4174);
const clientDist = path.resolve(__dirname, "../client");

app.disable("x-powered-by");
app.use(compression());
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "tapsocials", edgeSync: isEdgeSyncConfigured() });
});

app.get("/api/auth/me", async (request, response, next) => {
  try {
    response.json({ user: await getRequestUser(request) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/signup", async (request, response, next) => {
  try {
    const user = await createUserAccount(request.body || {});
    const sessionId = await createSession(user.id);
    setSessionCookie(request, response, sessionId);
    response.status(201).json({ user });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create account." });
  }
});

app.post("/api/auth/login", async (request, response, next) => {
  try {
    const user = await authenticateUser(request.body?.email, request.body?.password);
    if (!user) {
      response.status(401).json({ error: "Invalid email or password." });
      return;
    }
    const sessionId = await createSession(user.id);
    setSessionCookie(request, response, sessionId);
    response.json({ user });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (request, response, next) => {
  try {
    await deleteSession(readSessionCookie(request));
    clearSessionCookie(request, response);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/edge/links", async (request, response, next) => {
  if (!authorizeEdgeRequest(request, response)) return;
  try {
    const links = await listRawLinks();
    response.json(links.map(toEdgeLink));
  } catch (error) {
    next(error);
  }
});

app.get("/api/edge/links/:slug", async (request, response, next) => {
  if (!authorizeEdgeRequest(request, response)) return;
  try {
    const link = await findLinkBySlug(request.params.slug);
    if (!link) {
      response.status(404).json({ error: "Link not found." });
      return;
    }
    response.json(toEdgeLink(link));
  } catch (error) {
    next(error);
  }
});

app.post("/api/edge/sync", async (request, response, next) => {
  if (!authorizeEdgeRequest(request, response)) return;
  try {
    response.json(await syncLinksToEdge(await listRawLinks()));
  } catch (error) {
    next(error);
  }
});

app.post("/api/edge/clicks/batch", async (request, response, next) => {
  if (!authorizeEdgeRequest(request, response)) return;
  try {
    const events = Array.isArray(request.body?.events) ? request.body.events as EdgeClickEvent[] : [];
    await addClickEvents(events.map(edgeClickToStoredClick));
    response.status(202).json({ accepted: events.length });
  } catch (error) {
    next(error);
  }
});

app.use("/api", requireAuth);

app.get("/api/links", async (_request, response, next) => {
  try {
    response.json(await listLinks(currentUser(response).id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/groups", async (_request, response, next) => {
  try {
    response.json(await listGroups(currentUser(response).id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/groups", async (request, response, next) => {
  try {
    if (!request.body?.name) {
      response.status(400).json({ error: "Group name is required." });
      return;
    }
    response.status(201).json(await createGroup(request.body, currentUser(response).id));
  } catch (error) {
    next(error);
  }
});

app.put("/api/groups/:id", async (request, response, next) => {
  try {
    const updated = await updateGroup(request.params.id, request.body, currentUser(response).id);
    if (!updated) {
      response.status(404).json({ error: "Group not found." });
      return;
    }
    response.json(updated);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Unable to update group." });
  }
});

app.delete("/api/groups/:id", async (request, response, next) => {
  try {
    const deleted = await deleteGroup(request.params.id, currentUser(response).id);
    response.status(deleted ? 204 : 404).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/links", async (request, response, next) => {
  try {
    if (!request.body?.name || !request.body?.fallbackUrl) {
      response.status(400).json({ error: "Name and fallback URL are required." });
      return;
    }
    const link = await createLink(request.body, currentUser(response).id);
    await syncLinkToEdge(link).catch((error) => console.error("Failed to sync link to edge", error));
    response.status(201).json(link);
  } catch (error) {
    next(error);
  }
});

app.put("/api/links/:id", async (request, response, next) => {
  try {
    const userId = currentUser(response).id;
    const previous = await findLinkById(request.params.id, userId);
    const updated = await updateLink(request.params.id, request.body, userId);
    if (!updated) {
      response.status(404).json({ error: "Link not found." });
      return;
    }
    if (previous && previous.slug !== updated.slug) {
      await deleteLinkFromEdge(previous.slug).catch((error) => console.error("Failed to delete old edge slug", error));
      await syncLinkToEdge(updated).catch((error) => console.error("Failed to sync link to edge", error));
    } else {
      await syncLinkToEdge(updated).catch((error) => console.error("Failed to sync link to edge", error));
    }
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/links/:id", async (request, response, next) => {
  try {
    const userId = currentUser(response).id;
    const previous = await findLinkById(request.params.id, userId);
    const deleted = await deleteLink(request.params.id, userId);
    if (deleted && previous) {
      await deleteLinkFromEdge(previous.slug).catch((error) => console.error("Failed to delete edge link", error));
      await syncLinksToEdge(await listRawLinks()).catch((error) => console.error("Failed to reconcile edge links", error));
    }
    response.status(deleted ? 204 : 404).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/summary", async (_request, response, next) => {
  try {
    response.json(await getSummary(currentUser(response).id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/analytics", async (request, response, next) => {
  try {
    const days = Math.max(7, Math.min(90, Number(request.query.days || 30)));
    response.json(await getAnalytics(currentUser(response).id, days));
  } catch (error) {
    next(error);
  }
});

app.get("/l/:slug", redirectSlug);
app.get("/:slug", (request, response, next) => {
  const reserved = new Set(["dashboard", "api", "assets", "favicon.png"]);
  if (reserved.has(request.params.slug) || request.params.slug.includes(".")) {
    next();
    return;
  }
  void redirectSlug(request, response, next);
});

async function redirectSlug(request: express.Request, response: express.Response, next: express.NextFunction) {
  try {
    const userAgent = request.get("user-agent") || "";
    if (isLinkPreviewBot(userAgent) && !isEscapedBrowserRequest(new URLSearchParams(request.query as Record<string, string>))) {
      const link = await findLinkBySlug(request.params.slug);
      if (!link || link.status !== "active") {
        response.status(404).send(renderMissingLink());
        return;
      }
      response.set({
        "Cache-Control": "public, max-age=600",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff"
      });
      response.status(200).send(await renderPreviewForLink(link, absoluteRequestUrl(request)));
      return;
    }

    if (
      shouldServeFastDeepLinkEscape({
        pathname: request.path,
        searchParams: new URLSearchParams(request.query as Record<string, string>),
        userAgent,
        referrer: request.get("referer")
      })
    ) {
      response.set({
        "Cache-Control": "no-cache, must-revalidate, max-age=0",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff"
      });
      response.status(200).send(renderDeepLinkEscapePage(deepLinkEscapeUrl(absoluteRequestUrl(request)), userAgent));
      return;
    }

    const link = await findLinkBySlug(request.params.slug);
    if (!link || link.status !== "active") {
      response.status(404).send(renderMissingLink());
      return;
    }

    const device = detectDevice(userAgent, String(request.query.target || ""));
    const browser = detectBrowser(userAgent);
    const webDestination = selectWebFallback(link);
    const browserEscape = shouldUseBrowserEscape(link);
    const destination = browserEscape ? webDestination : selectDestination(link, device);
    const clickEvent: ClickEvent = {
      id: crypto.randomUUID(),
      linkId: link.id,
      slug: link.slug,
      occurredAt: new Date().toISOString(),
      device,
      browser,
      country: String(request.get("cf-ipcountry") || request.get("x-vercel-ip-country") || "Unknown"),
      referrer: classifyReferrer(request.get("referer")),
      visitorKey: hashVisitor(`${clientIp(request)}:${request.get("user-agent") || ""}`),
      destination
    };

    void addClickEvent(clickEvent).catch((error) => {
      console.error("Failed to record click", error);
    });

    if (browserEscape && isHttpUrl(webDestination) && isMobileDevice(device)) {
      if (isEscapedBrowserRequest(new URLSearchParams(request.query as Record<string, string>))) {
        response.redirect(302, webDestination);
        return;
      }
      response.status(200).send(renderDeepLinkEscapePage(deepLinkEscapeUrl(absoluteRequestUrl(request)), userAgent));
      return;
    }

    response.redirect(302, destination);
  } catch (error) {
    next(error);
  }
}

async function renderPreviewForLink(link: SmartLink, shortUrl: string): Promise<string> {
  const destination = selectWebFallback(link);
  const metadata = await fetchPreviewMetadata(destination, link);
  return renderLinkPreviewPage(metadata, shortUrl, destination);
}

async function fetchPreviewMetadata(destination: string, link: SmartLink) {
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

function fallbackPreviewMetadata(destination: string, link: SmartLink) {
  const host = safeHost(destination);
  return {
    title: link.name || host || "TapSocials link",
    description: link.description || link.notes || destination,
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

function absoluteRequestUrl(request: Request): string {
  const protocol = String(request.get("x-forwarded-proto") || request.protocol || "https").split(",")[0].trim();
  const host = String(request.get("x-forwarded-host") || request.get("host") || "localhost");
  return `${protocol}://${host}${request.originalUrl}`;
}

app.use(express.static(clientDist, { maxAge: "1h", etag: true }));

app.get("*", (_request, response) => {
  response.sendFile(path.join(clientDist, "index.html"));
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "Something went wrong." });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`TapSocials running at http://localhost:${port}`);
  void warmEdgeCache();
});

async function warmEdgeCache(): Promise<void> {
  if (!isEdgeSyncConfigured()) return;
  try {
    const result = await syncLinksToEdge(await listRawLinks());
    console.log(`Synced ${result.synced} links to Cloudflare edge.`);
  } catch (error) {
    console.error("Failed to sync links to edge on startup", error);
  }
}

function clientIp(request: Request): string {
  const forwardedFor = request.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return request.ip || "local";
}

async function requireAuth(request: express.Request, response: express.Response, next: express.NextFunction) {
  try {
    const user = await getRequestUser(request);
    if (!user) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }
    response.locals.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

async function getRequestUser(request: Request): Promise<AuthUser | null> {
  return getUserBySession(readSessionCookie(request));
}

function currentUser(response: express.Response): AuthUser {
  const user = response.locals.user as AuthUser | undefined;
  if (!user) throw new Error("Authenticated user missing from request.");
  return user;
}

function readSessionCookie(request: Request): string | undefined {
  const cookies = parseCookies(request.get("cookie") || "");
  return cookies.ts_session;
}

function setSessionCookie(request: Request, response: express.Response, sessionId: string): void {
  response.setHeader("Set-Cookie", serializeSessionCookie(request, sessionId, 30 * 24 * 60 * 60));
}

function clearSessionCookie(request: Request, response: express.Response): void {
  response.setHeader("Set-Cookie", serializeSessionCookie(request, "", 0));
}

function serializeSessionCookie(request: Request, value: string, maxAge: number): string {
  const parts = [
    `ts_session=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  const domain = cookieDomain(request);
  if (domain) parts.push(`Domain=${domain}`);
  if (isSecureRequest(request)) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(header: string): Record<string, string> {
  return header.split(";").reduce<Record<string, string>>((cookies, part) => {
    const [name, ...rest] = part.trim().split("=");
    if (!name) return cookies;
    cookies[name] = decodeURIComponent(rest.join("="));
    return cookies;
  }, {});
}

function cookieDomain(request: Request): string | null {
  const host = (request.get("x-forwarded-host") || request.get("host") || "").split(":")[0].toLowerCase();
  if (host === "tapsocials.com" || host.endsWith(".tapsocials.com")) return ".tapsocials.com";
  return null;
}

function isSecureRequest(request: Request): boolean {
  return request.secure || request.get("x-forwarded-proto") === "https" || process.env.NODE_ENV === "production";
}

function authorizeEdgeRequest(request: Request, response: express.Response): boolean {
  const secret = process.env.EDGE_SYNC_SECRET;
  if (!secret && process.env.NODE_ENV !== "production") return true;
  const provided = request.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (secret && provided === secret) return true;
  response.status(401).json({ error: "Unauthorized edge request." });
  return false;
}

function renderOpenInBrowser(destination: string): string {
  const safeDestination = escapeHtml(destination);
  const jsDestination = JSON.stringify(destination);
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta http-equiv="refresh" content="1;url=${safeDestination}" />
      <title>Opening link</title>
      <style>
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #f2f2f3; }
        main { width: min(420px, calc(100vw - 32px)); border: 1px solid #27272f; border-radius: 10px; background: #0f0f12; padding: 28px; }
        h1 { margin: 0 0 8px; font-size: 22px; }
        p { margin: 0 0 18px; color: #a1a1aa; line-height: 1.5; }
        a { display: inline-flex; min-height: 42px; align-items: center; justify-content: center; border-radius: 8px; background: #22d3ee; color: #071014; padding: 0 14px; font-weight: 700; text-decoration: none; }
      </style>
      <script>
        window.setTimeout(function () {
          window.location.replace(${jsDestination});
        }, 250);
      </script>
    </head>
    <body>
      <main>
        <h1>Opening link</h1>
        <p>If your social app keeps this page inside its browser, use the app menu and choose Open in browser.</p>
        <a href="${safeDestination}" rel="noreferrer">Continue</a>
      </main>
    </body>
  </html>`;
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

function renderMissingLink(): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Link unavailable</title>
      <style>
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f6f7f3; color: #19211f; }
        main { width: min(420px, calc(100vw - 32px)); background: #fff; border: 1px solid #dfe5dc; border-radius: 8px; padding: 28px; box-shadow: 0 20px 60px rgba(23,32,29,.08); }
        h1 { margin: 0 0 8px; font-size: 24px; }
        p { margin: 0; color: #68716c; line-height: 1.5; }
      </style>
    </head>
    <body>
      <main>
        <h1>Link unavailable</h1>
        <p>This link is paused, deleted, or does not exist.</p>
      </main>
    </body>
  </html>`;
}
