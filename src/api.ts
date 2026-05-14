import type { AnalyticsPayload, DashboardSummary, LinkGroup, LinkWithStats, SmartLink } from "../shared/types";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    },
    ...init
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  summary: () => requestJson<DashboardSummary>("/api/summary"),
  analytics: (days = 30) => requestJson<AnalyticsPayload>(`/api/analytics?days=${days}`),
  links: () => requestJson<LinkWithStats[]>("/api/links"),
  groups: () => requestJson<LinkGroup[]>("/api/groups"),
  createGroup: (payload: Partial<LinkGroup>) =>
    requestJson<LinkGroup>("/api/groups", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createLink: (payload: Partial<SmartLink>) =>
    requestJson<LinkWithStats>("/api/links", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateLink: (id: string, payload: Partial<SmartLink>) =>
    requestJson<LinkWithStats>(`/api/links/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  deleteLink: async (id: string) => {
    const response = await fetch(`/api/links/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete failed: ${response.status}`);
    }
  }
};
