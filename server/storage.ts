import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type {
  AnalyticsPayload,
  AuthUser,
  ClickEvent,
  DashboardSummary,
  DailyBreakdownPoint,
  LinkGroup,
  LinkStatus,
  LinkWithStats,
  SmartLink
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

interface StoreShape {
  links: SmartLink[];
  groups: LinkGroup[];
  events: ClickEvent[];
  users: StoredUser[];
  sessions: AuthSession[];
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const dataFile = path.join(dataDir, "store.json");

let cachedStore: StoreShape | null = null;
let slugIndex: Map<string, SmartLink> | null = null;
let persistTimer: NodeJS.Timeout | null = null;

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

  try {
    const raw = await fs.readFile(dataFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    cachedStore = {
      links: parsed.links || seedLinks,
      groups: parsed.groups || seedGroups,
      events: parsed.events || [],
      users: parsed.users || [],
      sessions: pruneExpiredSessions(parsed.sessions || [])
    };
    migrateOwnedData(cachedStore);
  } catch {
    cachedStore = {
      links: seedLinks,
      groups: seedGroups,
      events: buildSeedEvents(seedLinks),
      users: [],
      sessions: []
    };
    await persistStore(cachedStore);
  }

  return cachedStore;
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

export async function addClickEvent(event: ClickEvent): Promise<void> {
  const store = await getStore();
  store.events.unshift(withEventOwner(store, event));
  store.events = store.events.slice(0, 100000);
  schedulePersist(store);
}

export async function addClickEvents(events: ClickEvent[]): Promise<void> {
  if (!events.length) return;
  const store = await getStore();
  store.events.unshift(...events.map((event) => withEventOwner(store, event)));
  store.events = store.events.slice(0, 100000);
  schedulePersist(store);
}

export async function createGroup(input: Partial<LinkGroup>, userId: string): Promise<LinkGroup> {
  const store = await getStore();
  const name = String(input.name || "").trim();
  const group: LinkGroup = {
    id: uniqueGroupId(slugText(name), groupsForUser(store, userId)),
    userId,
    name,
    color: String(input.color || "#6366f1")
  };
  store.groups.push(group);
  await persistStore(store);
  return group;
}

export async function createLink(input: Partial<SmartLink>, userId: string): Promise<LinkWithStats> {
  const store = await getStore();
  const isDeepLink = input.isDeepLink !== false;
  const requestedSlug = input.slug ? cleanSlug(input.slug) : isDeepLink ? `d-${cryptoRandom()}` : cleanSlug(input.name || "new-link");
  const slug = await uniqueSlug(isDeepLink && !requestedSlug.startsWith("d-") ? `d-${requestedSlug}` : requestedSlug, store.links);

  const now = new Date().toISOString();
  const link: SmartLink = {
    id: `lnk_${cryptoRandom()}`,
    userId,
    name: String(input.name || "Untitled Link").trim(),
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
    groupId: isGroupOwnedByUser(store, userId, input.groupId) ? input.groupId || null : null,
    tags: normalizeTags(input.tags),
    status: normalizeStatus(input.status),
    createdAt: now,
    updatedAt: now
  };

  store.links.unshift(link);
  invalidateIndexes();
  await persistStore(store);
  return withStats([link], store.events)[0];
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
  store.events = store.events.filter((event) => event.linkId !== id);
  invalidateIndexes();
  await persistStore(store);
  return store.links.length !== previousLength;
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

async function persistStore(store: StoreShape): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dataFile, JSON.stringify(store, null, 2));
}

function linksForUser(store: StoreShape, userId: string): SmartLink[] {
  return store.links.filter((link) => link.userId === userId);
}

function groupsForUser(store: StoreShape, userId: string): LinkGroup[] {
  return store.groups.filter((group) => group.userId === userId);
}

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

function publicUser(user: StoredUser): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt
  };
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
