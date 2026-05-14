import type { EdgeClickEvent } from "../shared/edge.js";
import { toEdgeLink } from "../shared/edge.js";
import type { ClickEvent, SmartLink } from "../shared/types.js";

const kvAccountId = process.env.CF_ACCOUNT_ID;
const kvNamespaceId = process.env.CF_KV_NAMESPACE_ID;
const kvApiToken = process.env.CF_API_TOKEN;

export function isEdgeSyncConfigured(): boolean {
  return Boolean(kvAccountId && kvNamespaceId && kvApiToken);
}

export async function syncLinkToEdge(link: SmartLink): Promise<void> {
  if (!isEdgeSyncConfigured()) return;
  const response = await fetch(kvUrl(`link:${link.slug}`), {
    method: "PUT",
    headers: kvHeaders(),
    body: JSON.stringify(toEdgeLink(link))
  });
  await assertCloudflareOk(response, `sync ${link.slug}`);
}

export async function deleteLinkFromEdge(slug: string): Promise<void> {
  if (!isEdgeSyncConfigured()) return;
  const response = await fetch(kvUrl(`link:${slug}`), {
    method: "DELETE",
    headers: kvHeaders()
  });
  await assertCloudflareOk(response, `delete ${slug}`);
}

export async function syncLinksToEdge(links: SmartLink[]): Promise<{ synced: number; configured: boolean }> {
  if (!isEdgeSyncConfigured()) return { synced: 0, configured: false };
  await Promise.all(links.map((link) => syncLinkToEdge(link)));
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

async function assertCloudflareOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`Cloudflare KV ${action} failed: ${response.status} ${await response.text()}`);
}
