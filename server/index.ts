import compression from "compression";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "express";
import { addClickEvent, addClickEvents, createGroup, createLink, deleteLink, findLinkById, findLinkBySlug, getAnalytics, getSummary, listGroups, listLinks, listRawLinks, updateLink } from "./storage.js";
import { deleteLinkFromEdge, edgeClickToStoredClick, isEdgeSyncConfigured, syncLinksToEdge, syncLinkToEdge } from "./edge-sync.js";
import { classifyReferrer, detectBrowser, detectDevice, hashVisitor, selectDestination } from "./routing.js";
import { toEdgeLink, type EdgeClickEvent } from "../shared/edge.js";
import type { ClickEvent } from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 4174);
const clientDist = path.resolve(__dirname, "../client");

app.disable("x-powered-by");
app.use(compression());
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "justlinks", edgeSync: isEdgeSyncConfigured() });
});

app.get("/api/links", async (_request, response, next) => {
  try {
    response.json(await listLinks());
  } catch (error) {
    next(error);
  }
});

app.get("/api/groups", async (_request, response, next) => {
  try {
    response.json(await listGroups());
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
    response.status(201).json(await createGroup(request.body));
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
    const link = await createLink(request.body);
    await syncLinkToEdge(link).catch((error) => console.error("Failed to sync link to edge", error));
    response.status(201).json(link);
  } catch (error) {
    next(error);
  }
});

app.put("/api/links/:id", async (request, response, next) => {
  try {
    const previous = await findLinkById(request.params.id);
    const updated = await updateLink(request.params.id, request.body);
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
    const previous = await findLinkById(request.params.id);
    const deleted = await deleteLink(request.params.id);
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
    response.json(await getSummary());
  } catch (error) {
    next(error);
  }
});

app.get("/api/analytics", async (request, response, next) => {
  try {
    const days = Math.max(7, Math.min(90, Number(request.query.days || 30)));
    response.json(await getAnalytics(days));
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
    const link = await findLinkBySlug(request.params.slug);
    if (!link || link.status !== "active") {
      response.status(404).send(renderMissingLink());
      return;
    }

    const device = detectDevice(request.get("user-agent"), String(request.query.target || ""));
    const browser = detectBrowser(request.get("user-agent") || "");
    const destination = selectDestination(link, device);
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

    response.redirect(302, destination);
  } catch (error) {
    next(error);
  }
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
  console.log(`JustLinks running at http://localhost:${port}`);
});

function clientIp(request: Request): string {
  const forwardedFor = request.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return request.ip || "local";
}

function authorizeEdgeRequest(request: Request, response: express.Response): boolean {
  const secret = process.env.EDGE_SYNC_SECRET;
  if (!secret && process.env.NODE_ENV !== "production") return true;
  const provided = request.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (secret && provided === secret) return true;
  response.status(401).json({ error: "Unauthorized edge request." });
  return false;
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
