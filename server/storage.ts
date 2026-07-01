import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type {
  AnalyticsPayload,
  ApiKeyPermission,
  ApiKeySummary,
  CountryFilterMode,
  CreatedApiKey,
  AuthUser,
  ClickEvent,
  DashboardSummary,
  DailyBreakdownPoint,
  LinkGroup,
  LinkStatus,
  LinkWithStats,
  SmartLink,
  TeamAnalyticsPayload,
  TeamMember,
  TeamMemberStat,
  UserRole,
  UserStatus
} from "../shared/types.js";
import { cleanSlug } from "./routing.js";

interface StoredUser extends AuthUser {
  passwordHash: string;
}

interface AuthSession {
  idHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface StoredApiKey extends ApiKeySummary {
  userId: string;
  keyHash: string;
}

interface PasswordReset {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface ApiKeyAuthContext {
  userId: string;
  keyId: string;
  permissions: ApiKeyPermission[];
  userStatus: UserStatus;
}

export interface PublicLinkStats {
  link: {
    id: string;
    title: string;
    short_code: string;
    destination_url: string;
    is_deep_link: boolean;
    created_at: string;
  };
  totalClicks: number;
  uniqueClicks: number;
  dailyStats: {
    date: string;
    clicks: number;
    uniqueClicks: number;
  }[];
  countryStats: {
    country: string;
    clicks: number;
  }[];
}

interface StoreShape {
  links: SmartLink[];
  groups: LinkGroup[];
  events: ClickEvent[];
  users: StoredUser[];
  sessions: AuthSession[];
  apiKeys: StoredApiKey[];
  passwordResets: PasswordReset[];
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const dataFile = path.join(dataDir, "store.json");

let cachedStore: StoreShape | null = null;
let slugIndex: Map<string, SmartLink> | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let persistCounter = 0;

const seedGroups: LinkGroup[] = [
  { id: "campaign", name: "Campaign", color: "#6366f1" },
  { id: "mobile", name: "Mobile", color: "#06b6d4" },
  { id: "referral", name: "Referral", color: "#22c55e" },
  { id: "press", name: "Press", color: "#ec4899" }
];

const seedLinks: SmartLink[] = [
  {
    id: "lnk_summer_drop",
    name: "Summer Campaign",
    slug: "summer-drop",
    description: "Routes app users into the summer collection screen.",
    iosUrl: "myapp://collection/summer",
    androidUrl: "intent://collection/summer#Intent;scheme=myapp;package=com.tapsocials.demo;end",
    webUrl: "https://example.com/summer",
    fallbackUrl: "https://example.com/download",
    deepLinkPath: "/collection/summer",
    notes: "Campaign",
    isDeepLink: true,
    groupId: "campaign",
    tags: ["campaign", "mobile"],
    status: "active",
    createdAt: daysAgo(20),
    updatedAt: daysAgo(2)
  },
  {
    id: "lnk_invite_flow",
    name: "Invite Flow",
    slug: "invite",
    description: "Deep links new users into invitation acceptance.",
    iosUrl: "myapp://invite",
    androidUrl: "intent://invite#Intent;scheme=myapp;package=com.tapsocials.demo;end",
    webUrl: "https://example.com/invite",
    fallbackUrl: "https://example.com/download",
    deepLinkPath: "/invite",
    notes: "Referral",
    isDeepLink: true,
    groupId: "referral",
    tags: ["referral"],
    status: "active",
    createdAt: daysAgo(16),
    updatedAt: daysAgo(1)
  },
  {
    id: "lnk_product_launch",
    name: "Product Launch",
    slug: "launch",
    description: "Routes press and social traffic to the launch page.",
    iosUrl: "myapp://product/new",
    androidUrl: "intent://product/new#Intent;scheme=myapp;package=com.tapsocials.demo;end",
    webUrl: "https://example.com/products/new",
    fallbackUrl: "https://example.com/products/new",
    deepLinkPath: "/product/new",
    notes: "Press",
    isDeepLink: true,
    groupId: "press",
    tags: ["launch", "press"],
    status: "active",
    createdAt: daysAgo(12),
    updatedAt: daysAgo(3)
  },
  {
    id: "lnk_archived_test",
    name: "QA Test Link",
    slug: "qa-test",
    description: "Paused test link for old routing QA.",
    iosUrl: "myapp://qa",
    androidUrl: "intent://qa#Intent;scheme=myapp;package=com.tapsocials.demo;end",
    webUrl: "https://example.com/qa",
    fallbackUrl: "https://example.com/qa",
    deepLinkPath: "/qa",
    notes: "Internal",
    isDeepLink: false,
    groupId: null,
    tags: ["internal"],
    status: "paused",
    createdAt: daysAgo(42),
    updatedAt: daysAgo(11)
  }
];

export async function getStore(): Promise<StoreShape> {
  if (cachedStore) return cachedStore;

  let raw: string | null = null;
  try {
    raw = await fs.readFile(dataFile, "utf-8");
  } catch {
    raw = null; // first run — the store file doesn't exist yet
  }

  if (raw !== null) {
    let parsed: Partial<StoreShape>;
    try {
      parsed = JSON.parse(raw) as Partial<StoreShape>;
    } catch (error) {
      // The file exists but is unparseable. Do NOT re-seed over it — that would
      // wipe real clicks. Preserve it for recovery and start from an empty store
      // (with atomic writes this path should now be unreachable in practice).
      const backup = `${dataFile}.corrupt.${Date.now()}`;
      try {
        await fs.rename(dataFile, backup);
      } catch {
        // ignore — best effort
      }
      console.error(`store.json was unparseable; backed up to ${backup} to avoid overwriting recoverable data.`, error);
      cachedStore = { links: [], groups: [], events: [], users: [], sessions: [], apiKeys: [], passwordResets: [] };
      await persistStore(cachedStore);
      return cachedStore;
    }
    cachedStore = {
      links: parsed.links || seedLinks,
      groups: parsed.groups || seedGroups,
      events: parsed.events || [],
      users: parsed.users || [],
      sessions: pruneExpiredSessions(parsed.sessions || []),
      apiKeys: (parsed as Partial<StoreShape>).apiKeys || [],
      passwordResets: pruneExpiredResets((parsed as Partial<StoreShape>).passwordResets || [])
    };
    migrateOwnedData(cachedStore);
    if (ensureUserAccess(cachedStore)) {
      await persistStore(cachedStore);
    }
    return cachedStore;
  }

  // First run: no store file yet — seed it.
  cachedStore = {
    links: seedLinks,
    groups: seedGroups,
    events: buildSeedEvents(seedLinks),
    users: [],
    sessions: [],
    apiKeys: [],
    passwordResets: []
  };
  await persistStore(cachedStore);
  return cachedStore;
}

// Flush any debounced changes to disk on shutdown (Render sends SIGTERM on
// redeploy) so the most recent clicks aren't lost with the in-memory store.
let flushing = false;
async function flushStoreOnExit(signal: NodeJS.Signals): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (cachedStore) await persistStore(cachedStore);
  } catch (error) {
    console.error("Failed to flush store on exit", error);
  } finally {
    process.exit(signal === "SIGINT" ? 130 : 0);
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void flushStoreOnExit(signal));
}

export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const store = await getStore();
  return store.apiKeys.filter((key) => key.userId === userId).map(publicApiKey);
}

export async function createApiKey(input: { name?: string; permissions?: ApiKeyPermission[] }, userId: string): Promise<CreatedApiKey> {
  const store = await getStore();
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Key name is required.");

  const permissions = normalizeApiKeyPermissions(input.permissions);
  if (!permissions.length) throw new Error("Select at least one permission.");

  const secret = `flk_${crypto.randomBytes(24).toString("hex")}`;
  const now = new Date().toISOString();
  const key: StoredApiKey = {
    id: `key_${cryptoRandom()}`,
    userId,
    name,
    prefix: `${secret.slice(0, 12)}...`,
    permissions,
    createdAt: now,
    lastUsedAt: null,
    keyHash: hashApiKey(secret)
  };

  store.apiKeys.unshift(key);
  await persistStore(store);
  return { key: publicApiKey(key), secret };
}

export async function deleteApiKey(id: string, userId: string): Promise<boolean> {
  const store = await getStore();
  const previousLength = store.apiKeys.length;
  store.apiKeys = store.apiKeys.filter((key) => key.id !== id || key.userId !== userId);
  if (store.apiKeys.length === previousLength) return false;
  await persistStore(store);
  return true;
}

export async function authenticateApiKey(secret: string | undefined): Promise<ApiKeyAuthContext | null> {
  if (!secret?.startsWith("flk_")) return null;
  const store = await getStore();
  const keyHash = hashApiKey(secret);
  const key = store.apiKeys.find((candidate) => safeCompare(candidate.keyHash, keyHash));
  if (!key) return null;
  const user = store.users.find((entry) => entry.id === key.userId);
  if (!user) return null;
  key.lastUsedAt = new Date().toISOString();
  schedulePersist(store);
  return {
    userId: key.userId,
    keyId: key.id,
    permissions: key.permissions,
    userStatus: user.status
  };
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  const store = await getStore();
  return store.users
    .map(publicTeamMember)
    .sort((a, b) => statusWeight(a.status) - statusWeight(b.status) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function updateTeamMember(
  id: string,
  input: { status?: UserStatus; role?: UserRole },
  actorUserId: string
): Promise<TeamMember | null> {
  const store = await getStore();
  const actor = store.users.find((user) => user.id === actorUserId);
  const target = store.users.find((user) => user.id === id);
  if (!actor || !target || actor.status !== "approved" || !canAdminTeam(actor)) return null;

  const nextStatus = normalizeUserStatus(input.status);
  const nextRole = normalizeUserRole(input.role);

  if (nextRole && actor.role !== "owner") {
    throw new Error("Only the owner can change team roles.");
  }
  if (target.role === "owner" && actor.role !== "owner") {
    throw new Error("Only the owner can change another owner.");
  }
  if (target.id === actor.id && nextStatus && nextStatus !== "approved") {
    throw new Error("You cannot suspend your own account.");
  }
  if (target.role === "owner" && nextRole && nextRole !== "owner" && countOwners(store) <= 1) {
    throw new Error("At least one owner is required.");
  }
  if (target.role === "owner" && nextStatus && nextStatus !== "approved" && countOwners(store) <= 1) {
    throw new Error("At least one active owner is required.");
  }

  if (nextStatus) {
    target.status = nextStatus;
    if (nextStatus === "approved") ensureDefaultGroups(store, target.id);
  }
  if (nextRole) {
    target.role = nextRole;
    if (nextRole === "owner") target.status = "approved";
  }

  await persistStore(store);
  return publicTeamMember(target);
}

export async function listPublicApiLinks(userId: string) {
  const store = await getStore();
  return linksForUser(store, userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 500)
    .map(publicApiLink);
}

export async function getPublicLinkStats(linkId: string, userId: string): Promise<PublicLinkStats | null> {
  const store = await getStore();
  const link = store.links.find((candidate) => candidate.id === linkId && candidate.userId === userId);
  if (!link) return null;

  const events = eventsForLinks(store, [link], userId).filter((event) => event.linkId === link.id || event.slug === link.slug);
  const daily = new Map<string, ClickEvent[]>();
  const countries = new Map<string, number>();

  for (const event of events) {
    const day = event.occurredAt.slice(0, 10);
    daily.set(day, [...(daily.get(day) || []), event]);
    countries.set(event.country || "Unknown", (countries.get(event.country || "Unknown") || 0) + 1);
  }

  return {
    link: publicApiLink(link),
    totalClicks: events.length,
    uniqueClicks: new Set(events.map((event) => event.visitorKey)).size,
    dailyStats: Array.from(daily.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, entries]) => ({
        date,
        clicks: entries.length,
        uniqueClicks: new Set(entries.map((event) => event.visitorKey)).size
      })),
    countryStats: Array.from(countries.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([country, clicks]) => ({ country, clicks }))
  };
}

export async function listGroups(userId: string): Promise<LinkGroup[]> {
  const store = await getStore();
  return groupsForUser(store, userId);
}

export async function listLinks(userId: string): Promise<LinkWithStats[]> {
  const store = await getStore();
  const links = linksForUser(store, userId);
  return withStats(links, eventsForLinks(store, links, userId));
}

export async function listRawLinks(userId?: string): Promise<SmartLink[]> {
  const store = await getStore();
  return userId ? linksForUser(store, userId) : store.links;
}

export async function findLinkById(id: string, userId?: string): Promise<SmartLink | undefined> {
  const store = await getStore();
  return store.links.find((link) => link.id === id && (!userId || link.userId === userId));
}

export async function findLinkBySlug(slug: string): Promise<SmartLink | undefined> {
  const store = await getStore();
  return getSlugIndex(store).get(slug);
}

export async function getUserBySession(sessionId: string | undefined): Promise<AuthUser | null> {
  if (!sessionId) return null;
  const store = await getStore();
  const idHash = hashSessionId(sessionId);
  const session = store.sessions.find((entry) => entry.idHash === idHash);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    store.sessions = store.sessions.filter((entry) => entry.idHash !== idHash);
    schedulePersist(store);
    return null;
  }
  const user = store.users.find((entry) => entry.id === session.userId);
  return user ? publicUser(user) : null;
}

export async function createUserAccount(input: { email?: string; name?: string; password?: string }): Promise<AuthUser> {
  const store = await getStore();
  const email = normalizeEmail(input.email);
  const password = String(input.password || "");
  if (!email) throw new Error("Email is required.");
  if (password.length < 6) throw new Error("Password must be at least 6 characters.");
  if (store.users.some((user) => user.email === email)) throw new Error("An account with this email already exists.");

  const isFirstUser = store.users.length === 0;
  const now = new Date().toISOString();
  const user: StoredUser = {
    id: `usr_${cryptoRandom()}`,
    email,
    name: String(input.name || email.split("@")[0] || "User").trim(),
    role: isFirstUser ? "owner" : "member",
    status: isFirstUser ? "approved" : "pending",
    passwordHash: hashPassword(password),
    createdAt: now
  };

  store.users.push(user);
  if (isFirstUser) {
    claimLegacyData(store, user.id);
  } else {
    ensureDefaultGroups(store, user.id);
  }
  await persistStore(store);
  return publicUser(user);
}

export async function authenticateUser(emailInput: string | undefined, passwordInput: string | undefined): Promise<AuthUser | null> {
  const store = await getStore();
  const email = normalizeEmail(emailInput);
  const user = store.users.find((entry) => entry.email === email);
  if (!user || !verifyPassword(String(passwordInput || ""), user.passwordHash)) return null;
  return publicUser(user);
}

export async function createSession(userId: string): Promise<string> {
  const store = await getStore();
  const sessionId = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  store.sessions = pruneExpiredSessions(store.sessions).filter((session) => session.userId !== userId || new Date(session.expiresAt).getTime() > Date.now());
  store.sessions.push({
    idHash: hashSessionId(sessionId),
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  });
  await persistStore(store);
  return sessionId;
}

export async function deleteSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const store = await getStore();
  const idHash = hashSessionId(sessionId);
  store.sessions = store.sessions.filter((session) => session.idHash !== idHash);
  await persistStore(store);
}

// === Password reset ===

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ACTIVE_RESETS_PER_USER = 3;

// Creates a single-use reset token for the account with this email. Returns the
// raw token (to email) + the user, or null if no such account exists. Callers
// must NOT reveal to the requester whether the email matched (no enumeration).
export async function createPasswordReset(emailInput: string | undefined): Promise<{ token: string; user: AuthUser } | null> {
  const store = await getStore();
  const email = normalizeEmail(emailInput);
  if (!email) return null;
  const user = store.users.find((entry) => entry.email === email);
  if (!user) return null;
  // Suspended accounts can't reset their way back in.
  if (user.status === "suspended") return null;

  store.passwordResets = pruneExpiredResets(store.passwordResets);
  // Cap concurrent active tokens per user (drop oldest beyond the cap).
  const active = store.passwordResets.filter((reset) => reset.userId === user.id && !reset.usedAt);
  if (active.length >= MAX_ACTIVE_RESETS_PER_USER) {
    const oldest = active.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    store.passwordResets = store.passwordResets.filter((reset) => reset !== oldest);
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  store.passwordResets.push({
    tokenHash: hashResetToken(token),
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RESET_TTL_MS).toISOString(),
    usedAt: null
  });
  await persistStore(store);
  return { token, user: publicUser(user) };
}

// Validates a reset token and sets a new password. Marks the token used and
// invalidates ALL of that user's existing sessions. Returns the user on success.
export async function consumePasswordReset(token: string | undefined, newPassword: string | undefined): Promise<AuthUser> {
  const store = await getStore();
  const raw = String(token || "");
  const password = String(newPassword || "");
  if (!raw) throw new Error("This reset link is invalid.");
  if (password.length < 6) throw new Error("Password must be at least 6 characters.");

  const tokenHash = hashResetToken(raw);
  const reset = store.passwordResets.find((entry) => safeCompare(entry.tokenHash, tokenHash));
  if (!reset) throw new Error("This reset link is invalid.");
  if (reset.usedAt) throw new Error("This reset link has already been used.");
  if (new Date(reset.expiresAt).getTime() <= Date.now()) throw new Error("This reset link has expired. Please request a new one.");

  const user = store.users.find((entry) => entry.id === reset.userId);
  if (!user) throw new Error("This reset link is invalid.");

  user.passwordHash = hashPassword(password);
  reset.usedAt = new Date().toISOString();
  // Invalidate every other reset token for this user + log them out everywhere.
  store.passwordResets = store.passwordResets.map((entry) =>
    entry.userId === user.id && !entry.usedAt ? { ...entry, usedAt: new Date().toISOString() } : entry
  );
  store.sessions = store.sessions.filter((session) => session.userId !== user.id);
  await persistStore(store);
  return publicUser(user);
}

function pruneExpiredResets(resets: PasswordReset[]): PasswordReset[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // keep used/expired tokens 24h for safety, then drop
  return resets.filter((reset) => new Date(reset.expiresAt).getTime() > cutoff);
}

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export async function addClickEvent(event: ClickEvent): Promise<void> {
  const store = await getStore();
  // Drop clicks for links that no longer exist (e.g. an edge-queued click that
  // lands after the link was deleted) so nothing from a deleted link is stored.
  if (!store.links.some((link) => link.id === event.linkId)) return;
  // Idempotent: the Cloudflare Queue delivers at-least-once, so the same click
  // (same id) can arrive more than once — never count it twice.
  if (store.events.some((existing) => existing.id === event.id)) return;
  store.events.unshift(withEventOwner(store, event));
  store.events = store.events.slice(0, 100000);
  schedulePersist(store);
}

export async function addClickEvents(events: ClickEvent[]): Promise<void> {
  if (!events.length) return;
  const store = await getStore();
  const liveLinkIds = new Set(store.links.map((link) => link.id));
  // Idempotent on event.id — absorbs Cloudflare Queue at-least-once redelivery and
  // duplicate ids within the same batch so redelivered batches can't inflate counts.
  const seenIds = new Set(store.events.map((existing) => existing.id));
  const accepted: ClickEvent[] = [];
  for (const event of events) {
    if (!liveLinkIds.has(event.linkId) || seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    accepted.push(event);
  }
  if (!accepted.length) return;
  store.events.unshift(...accepted.map((event) => withEventOwner(store, event)));
  store.events = store.events.slice(0, 100000);
  schedulePersist(store);
}

export async function createGroup(input: Partial<LinkGroup>, userId: string): Promise<LinkGroup> {
  const store = await getStore();
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Group name is required.");
  const group: LinkGroup = {
    id: uniqueGroupId(slugText(name), groupsForUser(store, userId)),
    userId,
    name,
    color: String(input.color || "#6366f1"),
    countryFilterMode: normalizeCountryFilterMode(input.countryFilterMode),
    blockedCountries: normalizeBlockedCountries(input.blockedCountries),
    allowedCountries: normalizeBlockedCountries(input.allowedCountries)
  };
  store.groups.push(group);
  await persistStore(store);
  return group;
}

export async function updateGroup(id: string, input: Partial<LinkGroup>, userId: string): Promise<LinkGroup | null> {
  const store = await getStore();
  const index = store.groups.findIndex((group) => group.id === id && group.userId === userId);
  if (index === -1) return null;

  const current = store.groups[index];
  const name = typeof input.name === "string" ? input.name.trim() : current.name;
  if (!name) throw new Error("Group name is required.");

  const updated: LinkGroup = {
    ...current,
    name,
    color: typeof input.color === "string" && input.color.trim() ? input.color.trim() : current.color,
    countryFilterMode: input.countryFilterMode !== undefined ? normalizeCountryFilterMode(input.countryFilterMode) : current.countryFilterMode,
    blockedCountries: input.blockedCountries !== undefined ? normalizeBlockedCountries(input.blockedCountries) : current.blockedCountries,
    allowedCountries: input.allowedCountries !== undefined ? normalizeBlockedCountries(input.allowedCountries) : current.allowedCountries
  };

  store.groups[index] = updated;
  await persistStore(store);
  return updated;
}

export async function findGroupById(id: string, userId?: string): Promise<LinkGroup | undefined> {
  const store = await getStore();
  return store.groups.find((group) => group.id === id && (!userId || group.userId === userId));
}

// Returns the IDs of all links that belong to the given group (used to re-sync to the edge when a group's filter changes).
export async function listLinksInGroup(groupId: string, userId: string): Promise<SmartLink[]> {
  const store = await getStore();
  return store.links.filter((link) => link.userId === userId && link.groupId === groupId);
}

// Used by edge-sync flows to know each link's group for effective-filter resolution.
export async function listAllGroups(): Promise<LinkGroup[]> {
  const store = await getStore();
  return store.groups;
}

export async function deleteGroup(id: string, userId: string): Promise<boolean> {
  const store = await getStore();
  const previousLength = store.groups.length;
  store.groups = store.groups.filter((group) => group.id !== id || group.userId !== userId);

  if (store.groups.length === previousLength) return false;

  store.links = store.links.map((link) => (link.userId === userId && link.groupId === id ? { ...link, groupId: null, updatedAt: new Date().toISOString() } : link));
  invalidateIndexes();
  await persistStore(store);
  return true;
}

// Create one or many links from the same input. For count > 1 (bulk), every link
// gets its OWN unique random short code and a "Name #n" suffix, but shares the same
// destination, deep-link setting, group and country filters — so one destination can
// be spread across many shortcodes (e.g. one per subreddit) in a single write.
export async function createLinks(input: Partial<SmartLink>, userId: string, count = 1): Promise<LinkWithStats[]> {
  const store = await getStore();
  const total = Math.max(1, Math.min(100, Math.floor(Number(count)) || 1));
  const isDeepLink = input.isDeepLink !== false;
  const baseName = String(input.name || "Untitled Link").trim();
  const groupId = isGroupOwnedByUser(store, userId, input.groupId) ? input.groupId || null : null;
  const created: SmartLink[] = [];

  for (let index = 0; index < total; index += 1) {
    // A custom slug only applies to a single link; bulk always gets unique codes.
    const requestedSlug =
      total === 1 && input.slug
        ? cleanSlug(input.slug)
        : isDeepLink
          ? `d-${cryptoRandom()}`
          : cleanSlug(String(input.name || "new-link"));
    const slug = await uniqueSlug(isDeepLink && !requestedSlug.startsWith("d-") ? `d-${requestedSlug}` : requestedSlug, store.links);
    const now = new Date().toISOString();
    const link: SmartLink = {
      id: `lnk_${cryptoRandom()}`,
      userId,
      name: total > 1 ? `${baseName} #${index + 1}` : baseName,
      slug,
      description: String(input.description || "").trim(),
      iosUrl: String(input.iosUrl || "").trim(),
      androidUrl: String(input.androidUrl || "").trim(),
      webUrl: String(input.webUrl || input.fallbackUrl || "").trim(),
      fallbackUrl: String(input.fallbackUrl || input.webUrl || "").trim(),
      deepLinkPath: String(input.deepLinkPath || "").trim(),
      notes: String(input.notes || input.description || "").trim(),
      isDeepLink,
      forceExternalBrowser: Boolean(input.forceExternalBrowser),
      groupId,
      tags: normalizeTags(input.tags),
      status: normalizeStatus(input.status),
      countryFilterMode: normalizeCountryFilterMode(input.countryFilterMode),
      blockedCountries: normalizeBlockedCountries(input.blockedCountries),
      allowedCountries: normalizeBlockedCountries(input.allowedCountries),
      createdAt: now,
      updatedAt: now
    };
    store.links.unshift(link);
    created.push(link);
  }

  invalidateIndexes();
  await persistStore(store);
  return created.map((link) => withStats([link], store.events)[0]);
}

export async function createLink(input: Partial<SmartLink>, userId: string): Promise<LinkWithStats> {
  const [link] = await createLinks(input, userId, 1);
  return link;
}

export async function updateLink(id: string, input: Partial<SmartLink>, userId: string): Promise<LinkWithStats | null> {
  const store = await getStore();
  const index = store.links.findIndex((link) => link.id === id && link.userId === userId);
  if (index === -1) return null;

  const current = store.links[index];
  let nextSlug = current.slug;
  if (typeof input.slug === "string" && cleanSlug(input.slug) !== current.slug) {
    nextSlug = await uniqueSlug(cleanSlug(input.slug), store.links.filter((link) => link.id !== id));
  }

  const updated: SmartLink = {
    ...current,
    ...input,
    id: current.id,
    userId: current.userId,
    createdAt: current.createdAt,
    slug: nextSlug,
    notes: typeof input.notes === "string" ? input.notes.trim() : current.notes,
    isDeepLink: typeof input.isDeepLink === "boolean" ? input.isDeepLink : current.isDeepLink,
    forceExternalBrowser: typeof input.forceExternalBrowser === "boolean" ? input.forceExternalBrowser : Boolean(current.forceExternalBrowser),
    groupId: input.groupId !== undefined && isGroupOwnedByUser(store, userId, input.groupId) ? input.groupId : input.groupId === null ? null : current.groupId,
    tags: input.tags ? normalizeTags(input.tags) : current.tags,
    status: input.status ? normalizeStatus(input.status) : current.status,
    countryFilterMode: input.countryFilterMode !== undefined ? normalizeCountryFilterMode(input.countryFilterMode) : current.countryFilterMode,
    blockedCountries: input.blockedCountries !== undefined ? normalizeBlockedCountries(input.blockedCountries) : current.blockedCountries,
    allowedCountries: input.allowedCountries !== undefined ? normalizeBlockedCountries(input.allowedCountries) : current.allowedCountries,
    updatedAt: new Date().toISOString()
  };

  store.links[index] = updated;
  invalidateIndexes();
  await persistStore(store);
  return withStats([updated], store.events)[0];
}

export async function deleteLink(id: string, userId: string): Promise<boolean> {
  const store = await getStore();
  const previousLength = store.links.length;
  store.links = store.links.filter((link) => link.id !== id || link.userId !== userId);
  const deleted = store.links.length !== previousLength;
  if (deleted) {
    // Keep the deleted link's clicks in analytics — tag its events with the owner
    // so they still count toward the user's totals once the link itself is gone.
    for (const event of store.events) {
      if (event.linkId === id && !event.userId) event.userId = userId;
    }
  }
  invalidateIndexes();
  await persistStore(store);
  return deleted;
}

export async function getSummary(userId: string): Promise<DashboardSummary> {
  const store = await getStore();
  const rawLinks = linksForUser(store, userId);
  const events = eventsForLinks(store, rawLinks, userId);
  const links = withStats(rawLinks, events);
  const activeLinks = rawLinks.filter((link) => link.status === "active").length;
  const totalClicks = events.length;
  const uniqueVisitors = new Set(events.map((event) => event.visitorKey)).size;
  const deepLinkedClicks = events.filter((event) => event.destination.startsWith("myapp://") || event.destination.startsWith("intent://")).length;

  return {
    totalClicks,
    activeLinks,
    uniqueVisitors,
    deepLinkRate: totalClicks ? Math.round((deepLinkedClicks / totalClicks) * 100) : 0,
    trend: buildSeries(events, 14),
    topLinks: links.sort((a, b) => b.clicks - a.clicks).slice(0, 5),
    recentEvents: events.slice(0, 7)
  };
}

export async function getAnalytics(userId: string, days = 30): Promise<AnalyticsPayload> {
  const store = await getStore();
  const links = linksForUser(store, userId);
  const userEvents = eventsForLinks(store, links, userId);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = userEvents.filter((event) => new Date(event.occurredAt).getTime() >= since);

  return {
    clicksOverTime: buildSeries(events, Math.min(days, 30)),
    deviceBreakdown: breakdown(events.map((event) => event.device)),
    countryBreakdown: breakdown(events.map((event) => event.country)),
    referrerBreakdown: breakdown(events.map((event) => event.referrer)),
    browserBreakdown: breakdown(events.map((event) => event.browser || "Unknown")),
    dailyBreakdown: buildDailyBreakdown(events, Math.min(days, 30)),
    linkPerformance: withStats(links, events).sort((a, b) => b.clicks - a.clicks),
    recentEvents: events.slice(0, 20)
  };
}

// Team-wide analytics (owner only): combined totals + a per-member (per-VA)
// breakdown so the owner can see each team member's performance. Each click
// belongs to exactly one member (its owner), so summing members never double-counts.
export async function getTeamAnalytics(days = 30): Promise<TeamAnalyticsPayload> {
  const store = await getStore();
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const inRange = (event: ClickEvent) => new Date(event.occurredAt).getTime() >= since;

  const teamEvents: ClickEvent[] = [];
  let activeLinks = 0;
  let totalLinks = 0;

  const members: TeamMemberStat[] = store.users
    .map((user) => {
      const links = linksForUser(store, user.id);
      const events = eventsForLinks(store, links, user.id).filter(inRange);
      teamEvents.push(...events);
      const active = links.filter((link) => link.status === "active").length;
      activeLinks += active;
      totalLinks += links.length;
      const perLink = withStats(links, events).sort((a, b) => b.clicks - a.clicks);
      const top = perLink[0];
      return {
        userId: user.id,
        name: user.name || user.email,
        email: user.email,
        role: user.role,
        status: user.status,
        clicks: events.length,
        uniqueVisitors: new Set(events.map((event) => event.visitorKey)).size,
        activeLinks: active,
        totalLinks: links.length,
        topLinkName: top && top.clicks > 0 ? top.name : null,
        topLinkClicks: top ? top.clicks : 0,
        lastClickAt: events[0]?.occurredAt ?? null
      };
    })
    .sort((a, b) => b.clicks - a.clicks);

  return {
    totalClicks: teamEvents.length,
    uniqueVisitors: new Set(teamEvents.map((event) => event.visitorKey)).size,
    activeLinks,
    totalLinks,
    memberCount: store.users.length,
    clicksOverTime: buildSeries(teamEvents, Math.min(days, 30)),
    members
  };
}

async function persistStore(store: StoreShape): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await fs.mkdir(dataDir, { recursive: true });
  // Write atomically (unique temp file + rename) so an overlapping write or a
  // crash mid-write can never leave a half-written / unparseable store.json —
  // which previously got re-seeded on the next load, wiping real clicks.
  const tempFile = `${dataFile}.tmp.${process.pid}.${persistCounter}`;
  persistCounter += 1;
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2));
  await fs.rename(tempFile, dataFile);
}

function linksForUser(store: StoreShape, userId: string): SmartLink[] {
  return store.links.filter((link) => link.userId === userId);
}

function groupsForUser(store: StoreShape, userId: string): LinkGroup[] {
  return store.groups.filter((group) => group.userId === userId);
}

// Analytics keep a user's clicks even after a link is deleted. We count events
// owned by the user (event.userId) OR belonging to one of their current links, so
// a deleted link's historical clicks stay in every aggregate (Dashboard totals,
// Analytics, breakdowns) instead of disappearing.
function eventsForLinks(store: StoreShape, links: SmartLink[], userId: string): ClickEvent[] {
  const linkIds = new Set(links.map((link) => link.id));
  return store.events.filter((event) => event.userId === userId || linkIds.has(event.linkId));
}

function isGroupOwnedByUser(store: StoreShape, userId: string, groupId: string | null | undefined): boolean {
  if (!groupId) return true;
  return groupsForUser(store, userId).some((group) => group.id === groupId);
}

function withEventOwner(store: StoreShape, event: ClickEvent): ClickEvent {
  if (event.userId) return event;
  const link = store.links.find((candidate) => candidate.id === event.linkId || candidate.slug === event.slug);
  return link?.userId ? { ...event, userId: link.userId } : event;
}

function migrateOwnedData(store: StoreShape): void {
  if (store.users.length !== 1) return;
  const userId = store.users[0].id;
  let changed = false;

  for (const link of store.links) {
    if (!link.userId) {
      link.userId = userId;
      changed = true;
    }
  }
  for (const group of store.groups) {
    if (!group.userId) {
      group.userId = userId;
      changed = true;
    }
  }
  for (let index = 0; index < store.events.length; index += 1) {
    const owned = withEventOwner(store, store.events[index]);
    if (owned !== store.events[index]) {
      store.events[index] = owned;
      changed = true;
    }
  }

  if (changed) schedulePersist(store);
}

function claimLegacyData(store: StoreShape, userId: string): void {
  for (const link of store.links) {
    if (!link.userId) link.userId = userId;
  }
  for (const group of store.groups) {
    if (!group.userId) group.userId = userId;
  }
  for (let index = 0; index < store.events.length; index += 1) {
    store.events[index] = withEventOwner(store, store.events[index]);
  }
}

function ensureDefaultGroups(store: StoreShape, userId: string): void {
  if (groupsForUser(store, userId).length) return;
  store.groups.push(...seedGroups.map((group) => ({ ...group, userId })));
}

function ensureUserAccess(store: StoreShape): boolean {
  if (!store.users.length) return false;

  let changed = false;
  const configuredOwnerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  const existingOwner = store.users.find((user) => user.role === "owner");
  const configuredOwner = configuredOwnerEmail ? store.users.find((user) => user.email === configuredOwnerEmail) : undefined;
  const usersByCreatedAt = [...store.users].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const firstHumanUser = usersByCreatedAt.find((user) => !user.email.endsWith(".test") && !user.email.startsWith("api-") && !user.email.includes("@example.com"));
  const firstUser = usersByCreatedAt[0];
  const owner = existingOwner || configuredOwner || firstHumanUser || firstUser;

  for (const user of store.users) {
    const rawRole = (user as Partial<StoredUser>).role;
    const rawStatus = (user as Partial<StoredUser>).status;
    const role = normalizeUserRole(rawRole);
    const status = normalizeUserStatus(rawStatus);

    if (!role) {
      user.role = user.id === owner.id ? "owner" : "member";
      changed = true;
    }
    if (!status) {
      user.status = user.id === owner.id ? "approved" : "pending";
      changed = true;
    }
  }

  if (!store.users.some((user) => user.role === "owner")) {
    owner.role = "owner";
    owner.status = "approved";
    changed = true;
  }

  return changed;
}

function canAdminTeam(user: Pick<StoredUser, "role">): boolean {
  return user.role === "owner" || user.role === "admin";
}

function countOwners(store: StoreShape): number {
  return store.users.filter((user) => user.role === "owner" && user.status === "approved").length;
}

function normalizeUserRole(value: unknown): UserRole | null {
  return value === "owner" || value === "admin" || value === "member" ? value : null;
}

function normalizeUserStatus(value: unknown): UserStatus | null {
  return value === "pending" || value === "approved" || value === "suspended" ? value : null;
}

function statusWeight(status: UserStatus): number {
  if (status === "pending") return 0;
  if (status === "approved") return 1;
  return 2;
}

function publicUser(user: StoredUser): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt
  };
}

function publicTeamMember(user: StoredUser): TeamMember {
  return publicUser(user);
}

function publicApiKey(key: StoredApiKey): ApiKeySummary {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    permissions: key.permissions,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt
  };
}

function publicApiLink(link: SmartLink) {
  return {
    id: link.id,
    title: link.name,
    short_code: link.slug,
    destination_url: link.fallbackUrl || link.webUrl,
    is_deep_link: Boolean(link.isDeepLink || link.forceExternalBrowser || link.slug.startsWith("d-")),
    created_at: link.createdAt
  };
}

function normalizeApiKeyPermissions(value: unknown): ApiKeyPermission[] {
  const allowed = new Set<ApiKeyPermission>(["create_links", "create_deep_links", "get_stats"]);
  const source = Array.isArray(value) ? value : ["create_links", "create_deep_links", "get_stats"];
  return Array.from(new Set(source.filter((permission): permission is ApiKeyPermission => allowed.has(permission as ApiKeyPermission))));
}

function normalizeEmail(value: string | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const [method, salt, expected] = storedHash.split(":");
  if (method !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
}

function hashSessionId(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId).digest("base64url");
}

function hashApiKey(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("base64url");
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function pruneExpiredSessions(sessions: AuthSession[]): AuthSession[] {
  const now = Date.now();
  return sessions.filter((session) => new Date(session.expiresAt).getTime() > now);
}

function schedulePersist(store: StoreShape): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistStore(store).catch((error) => {
      console.error("Failed to persist click batch", error);
    });
  }, 500);
}

function withStats(links: SmartLink[], events: ClickEvent[]): LinkWithStats[] {
  return links.map((link) => {
    const linkEvents = events.filter((event) => event.linkId === link.id);
    return {
      ...link,
      clicks: linkEvents.length,
      uniqueVisitors: new Set(linkEvents.map((event) => event.visitorKey)).size,
      lastClickAt: linkEvents[0]?.occurredAt ?? null
    };
  });
}

function buildSeries(events: ClickEvent[], days: number) {
  const points = new Map<string, number>();
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(Date.now() - index * 24 * 60 * 60 * 1000);
    const label = date.toLocaleDateString("en", { month: "short", day: "numeric" });
    points.set(label, 0);
  }

  for (const event of events) {
    const label = new Date(event.occurredAt).toLocaleDateString("en", { month: "short", day: "numeric" });
    if (points.has(label)) {
      points.set(label, (points.get(label) || 0) + 1);
    }
  }

  return Array.from(points.entries()).map(([label, value]) => ({ label, value }));
}

function buildDailyBreakdown(events: ClickEvent[], days: number): DailyBreakdownPoint[] {
  const buckets = new Map<string, { label: string; clicks: number; visitors: Set<string> }>();

  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(Date.now() - index * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    buckets.set(key, {
      label: date.toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
      clicks: 0,
      visitors: new Set()
    });
  }

  for (const event of events) {
    const key = new Date(event.occurredAt).toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.clicks += 1;
    bucket.visitors.add(event.visitorKey);
  }

  return Array.from(buckets.values())
    .reverse()
    .map((bucket) => ({
      label: bucket.label,
      clicks: bucket.clicks,
      uniqueVisitors: bucket.visitors.size
    }));
}

function breakdown(labels: string[]) {
  const total = labels.length || 1;
  const counts = labels.reduce<Map<string, number>>((map, label) => {
    map.set(label, (map.get(label) || 0) + 1);
    return map;
  }, new Map());

  return Array.from(counts.entries())
    .map(([label, value]) => ({
      label,
      value,
      percentage: Math.round((value / total) * 100)
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

function getSlugIndex(store: StoreShape): Map<string, SmartLink> {
  if (!slugIndex) {
    slugIndex = new Map(store.links.map((link) => [link.slug, link]));
  }
  return slugIndex;
}

function invalidateIndexes(): void {
  slugIndex = null;
}

async function uniqueSlug(baseSlug: string, links: SmartLink[]): Promise<string> {
  const base = baseSlug || "link";
  const taken = new Set(links.map((link) => link.slug));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${cryptoRandom()}`;
}

function uniqueGroupId(baseId: string, groups: LinkGroup[]): string {
  const base = baseId || "group";
  const taken = new Set(groups.map((group) => group.id));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${cryptoRandom()}`;
}

function slugText(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 6);
  }
  if (typeof value === "string") {
    return value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 6);
  }
  return [];
}

function normalizeStatus(value: unknown): LinkStatus {
  return value === "paused" ? "paused" : "active";
}

function normalizeBlockedCountries(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value.split(/[,\s\n]+/)
      : [];
  const cleaned = Array.from(new Set(
    raw
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => /^[A-Z]{2}$/.test(entry))
  ));
  return cleaned.length ? cleaned.slice(0, 300) : undefined;
}

function normalizeCountryFilterMode(value: unknown): CountryFilterMode | undefined {
  if (value === "none" || value === "block" || value === "allow") return value;
  return undefined;
}

function buildSeedEvents(links: SmartLink[]): ClickEvent[] {
  const devices = ["iOS", "Android", "Desktop", "iOS", "Android"] as const;
  const countries = ["US", "AL", "GB", "DE", "CA", "IT"];
  const referrers = ["Direct", "Instagram", "TikTok", "Google", "Facebook", "YouTube"];
  const events: ClickEvent[] = [];

  for (let index = 0; index < 320; index += 1) {
    const link = links[index % (links.length - 1)];
    const device = devices[index % devices.length];
    const destination = device === "iOS" ? link.iosUrl : device === "Android" ? link.androidUrl : link.webUrl;
    events.push({
      id: `evt_seed_${index}`,
      linkId: link.id,
      slug: link.slug,
      occurredAt: hoursAgo(index * 2.1),
      device,
      browser: index % 4 === 0 ? "Safari" : index % 4 === 1 ? "Chrome" : index % 4 === 2 ? "Firefox" : "Unknown",
      country: countries[index % countries.length],
      referrer: referrers[index % referrers.length],
      visitorKey: `visitor_${index % 117}`,
      destination
    });
  }

  return events.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function cryptoRandom(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}
