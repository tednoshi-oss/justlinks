import type { EdgeClickEvent, EdgeLinkConfig } from "../shared/edge.js";
import { toEdgeLink } from "../shared/edge.js";
import type { ClickEvent, LinkGroup, SmartLink } from "../shared/types.js";

const edgeWorkerSyncUrl = process.env.EDGE_WORKER_SYNC_URL?.replace(/\/+$/, "");
const edgeSyncSecret = process.env.EDGE_SYNC_SECRET;
const kvAccountId = process.env.CF_ACCOUNT_ID;
const kvNamespaceId = process.env.CF_KV_NAMESPACE_ID;
const kvApiToken = process.env.CF_API_TOKEN;

export function isEdgeSyncConfigured(): boolean {
  return Boolean((edgeWorkerSyncUrl && edgeSyncSecret) || (kvAccountId && kvNamespaceId && kvApiToken));
}

export async function syncLinkToEdge(link: SmartLink, group?: LinkGroup | null): Promise<void> {
  if (!isEdgeSyncConfigured()) return;
  const edgeLink = toEdgeLink(link, group ?? null);
  if (edgeWorkerSyncUrl && edgeSyncSecret) {
    const response = await fetch(`${edgeWorkerSyncUrl}/links/${encodeURIComponent(edgeLink.slug)}`, {
      method: "PUT",
      headers: edgeWorkerHeaders(),
      body: JSON.stringify(edgeLink)
    });
    await assertSyncOk(response, `sync ${edgeLink.slug}`);
    return;
  }

  const response = await fetch(kvUrl(`link:${link.slug}`), {
    method: "PUT",
    headers: kvHeaders(),
    body: JSON.stringify(edgeLink)
  });
  await assertCloudflareOk(response, `sync ${link.slug}`);
}

export async function deleteLinkFromEdge(slug: string): Promise<void> {
  if (!isEdgeSyncConfigured()) return;
  const tombstone = deletedEdgeLink(slug);
  if (edgeWorkerSyncUrl && edgeSyncSecret) {
    const response = await fetch(`${edgeWorkerSyncUrl}/links/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: edgeWorkerHeaders(),
      body: JSON.stringify(tombstone)
    });
    await assertSyncOk(response, `delete ${slug}`);
    return;
  }

  const response = await fetch(kvUrl(`link:${slug}`), {
    method: "PUT",
    headers: kvHeaders(),
    body: JSON.stringify(tombstone)
  });
  await assertCloudflareOk(response, `delete ${slug}`);
}

export async function syncLinksToEdge(links: SmartLink[], groups: LinkGroup[] = []): Promise<{ synced: number; configured: boolean }> {
  if (!isEdgeSyncConfigured()) return { synced: 0, configured: false };
  const groupById = new Map(groups.map((group) => [group.id, group] as const));
  const buildEdgeLink = (link: SmartLink) => toEdgeLink(link, link.groupId ? groupById.get(link.groupId) || null : null);

  if (edgeWorkerSyncUrl && edgeSyncSecret) {
    const response = await fetch(`${edgeWorkerSyncUrl}/sync`, {
      method: "POST",
      headers: edgeWorkerHeaders(),
      body: JSON.stringify({ links: links.map(buildEdgeLink) })
    });
    await assertSyncOk(response, "full sync");
    return { synced: links.length, configured: true };
  }

  await Promise.all(links.map((link) => syncLinkToEdge(link, link.groupId ? groupById.get(link.groupId) || null : null)));
  return { synced: links.length, configured: true };
}

export function edgeClickToStoredClick(event: EdgeClickEvent): ClickEvent {
  return {
    id: event.id,
    linkId: event.linkId,
    slug: event.slug,
    occurredAt: event.occurredAt,
    device: event.device,
    browser: event.browser,
    country: event.country,
    referrer: event.referrer,
    visitorKey: event.visitorKey,
    destination: event.destination
  };
}

function kvUrl(key: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${kvAccountId}/storage/kv/namespaces/${kvNamespaceId}/values/${encodeURIComponent(key)}`;
}

function kvHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${kvApiToken}`,
    "Content-Type": "application/json"
  };
}

function edgeWorkerHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${edgeSyncSecret}`,
    "Content-Type": "application/json"
  };
}

function deletedEdgeLink(slug: string): EdgeLinkConfig {
  return {
    id: `deleted:${slug}`,
    slug,
    status: "paused",
    iosUrl: "",
    androidUrl: "",
    webUrl: "",
    fallbackUrl: "",
    forceExternalBrowser: false
  };
}

async function assertSyncOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`Edge Worker ${action} failed: ${response.status} ${await response.text()}`);
}

async function assertCloudflareOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`Cloudflare KV ${action} failed: ${response.status} ${await response.text()}`);
}
