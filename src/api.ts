import type { AnalyticsPayload, ApiKeyPermission, ApiKeySummary, AuthUser, CreatedApiKey, DashboardSummary, LinkGroup, LinkWithStats, SmartLink, TeamMember, UserRole, UserStatus } from "../shared/types";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });

  if (!response.ok) {
    const message = await response.text();
    let parsedError: string | undefined;
    try {
      const parsed = JSON.parse(message) as { error?: string };
      parsedError = parsed.error;
    } catch {
      parsedError = undefined;
    }
    if (message.trim().startsWith("<!DOCTYPE") || message.trim().startsWith("<html")) {
      throw new Error("Dashboard service is temporarily unavailable. Please refresh in a moment.");
    }
    throw new Error(parsedError || message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  me: async () => {
    const data = await requestJson<{ user: AuthUser | null }>("/api/auth/me");
    return data.user;
  },
  signup: async (payload: { email: string; password: string; name?: string }) => {
    const data = await requestJson<{ user: AuthUser }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return data.user;
  },
  login: async (payload: { email: string; password: string }) => {
    const data = await requestJson<{ user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return data.user;
  },
  logout: async () => {
    const response = await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Logout failed: ${response.status}`);
    }
  },
  forgotPassword: (payload: { email: string }) =>
    requestJson<{ ok: boolean; message: string }>("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  resetPassword: async (payload: { token: string; password: string }) => {
    const data = await requestJson<{ ok: boolean; user: AuthUser }>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return data.user;
  },
  teamMembers: () => requestJson<TeamMember[]>("/api/team"),
  updateTeamMember: (id: string, payload: { status?: UserStatus; role?: UserRole }) =>
    requestJson<TeamMember>(`/api/team/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    }),
  summary: () => requestJson<DashboardSummary>("/api/summary"),
  analytics: (days = 30) => requestJson<AnalyticsPayload>(`/api/analytics?days=${days}`),
  apiKeys: () => requestJson<ApiKeySummary[]>("/api/api-keys"),
  createApiKey: (payload: { name: string; permissions: ApiKeyPermission[] }) =>
    requestJson<CreatedApiKey>("/api/api-keys", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteApiKey: async (id: string) => {
    const response = await fetch(`/api/api-keys/${id}`, { method: "DELETE", credentials: "include" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete failed: ${response.status}`);
    }
  },
  links: () => requestJson<LinkWithStats[]>("/api/links"),
  groups: () => requestJson<LinkGroup[]>("/api/groups"),
  createGroup: (payload: Partial<LinkGroup>) =>
    requestJson<LinkGroup>("/api/groups", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateGroup: (id: string, payload: Partial<LinkGroup>) =>
    requestJson<LinkGroup>(`/api/groups/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  deleteGroup: async (id: string) => {
    const response = await fetch(`/api/groups/${id}`, { method: "DELETE", credentials: "include" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete failed: ${response.status}`);
    }
  },
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
    const response = await fetch(`/api/links/${id}`, { method: "DELETE", credentials: "include" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Delete failed: ${response.status}`);
    }
  }
};
