import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type {
  AnalyticsPayload,
  ClickEvent,
  DashboardSummary,
  DailyBreakdownPoint,
  LinkGroup,
  LinkStatus,
  LinkWithStats,
  SmartLink
} from "../shared/types.js";
import { cleanSlug } from "./routing.js";

interface StoreShape {
  links: SmartLink[];
  groups: LinkGroup[];
  events: ClickEvent[];
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
    androidUrl: "intent://collection/summer#Intent;scheme=myapp;package=com.linkpilot.demo;end",
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
    androidUrl: "intent://invite#Intent;scheme=myapp;package=com.linkpilot.demo;end",
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
    androidUrl: "intent://product/new#Intent;scheme=myapp;package=com.linkpilot.demo;end",
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
    androidUrl: "intent://qa#Intent;scheme=myapp;package=com.linkpilot.demo;end",
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
      events: parsed.events || []
    };
  } catch {
    cachedStore = {
      links: seedLinks,
      groups: seedGroups,
      events: buildSeedEvents(seedLinks)
    };
    await persistStore(cachedStore);
  }

  return cachedStore;
}

export async function listGroups(): Promise<LinkGroup[]> {
  const store = await getStore();
  return store.groups;
}

export async function listLinks(): Promise<LinkWithStats[]> {
  const store = await getStore();
  return withStats(store.links, store.events);
}

export async function listRawLinks(): Promise<SmartLink[]> {
  const store = await getStore();
  return store.links;
}

export async function findLinkById(id: string): Promise<SmartLink | undefined> {
  const store = await getStore();
  return store.links.find((link) => link.id === id);
}

export async function findLinkBySlug(slug: string): Promise<SmartLink | undefined> {
  const store = await getStore();
  return getSlugIndex(store).get(slug);
}

export async function addClickEvent(event: ClickEvent): Promise<void> {
  const store = await getStore();
  store.events.unshift(event);
  store.events = store.events.slice(0, 100000);
  schedulePersist(store);
}

export async function addClickEvents(events: ClickEvent[]): Promise<void> {
  if (!events.length) return;
  const store = await getStore();
  store.events.unshift(...events);
  store.events = store.events.slice(0, 100000);
  schedulePersist(store);
}

export async function createGroup(input: Partial<LinkGroup>): Promise<LinkGroup> {
  const store = await getStore();
  const name = String(input.name || "").trim();
  const group: LinkGroup = {
    id: uniqueGroupId(slugText(name), store.groups),
    name,
    color: String(input.color || "#6366f1")
  };
  store.groups.push(group);
  await persistStore(store);
  return group;
}

export async function createLink(input: Partial<SmartLink>): Promise<LinkWithStats> {
  const store = await getStore();
  const isDeepLink = input.isDeepLink !== false;
  const requestedSlug = input.slug ? cleanSlug(input.slug) : isDeepLink ? `d-${cryptoRandom()}` : cleanSlug(input.name || "new-link");
  const slug = await uniqueSlug(isDeepLink && !requestedSlug.startsWith("d-") ? `d-${requestedSlug}` : requestedSlug, store.links);

  const now = new Date().toISOString();
  const link: SmartLink = {
    id: `lnk_${cryptoRandom()}`,
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
    groupId: input.groupId || null,
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

export async function updateLink(id: string, input: Partial<SmartLink>): Promise<LinkWithStats | null> {
  const store = await getStore();
  const index = store.links.findIndex((link) => link.id === id);
  if (index === -1) return null;

  const current = store.links[index];
  let nextSlug = current.slug;
  if (typeof input.slug === "string" && cleanSlug(input.slug) !== current.slug) {
    nextSlug = await uniqueSlug(cleanSlug(input.slug), store.links.filter((link) => link.id !== id));
  }

  const updated: SmartLink = {
    ...current,
    ...input,
    slug: nextSlug,
    notes: typeof input.notes === "string" ? input.notes.trim() : current.notes,
    isDeepLink: typeof input.isDeepLink === "boolean" ? input.isDeepLink : current.isDeepLink,
    groupId: input.groupId !== undefined ? input.groupId : current.groupId,
    tags: input.tags ? normalizeTags(input.tags) : current.tags,
    status: input.status ? normalizeStatus(input.status) : current.status,
    updatedAt: new Date().toISOString()
  };

  store.links[index] = updated;
  invalidateIndexes();
  await persistStore(store);
  return withStats([updated], store.events)[0];
}

export async function deleteLink(id: string): Promise<boolean> {
  const store = await getStore();
  const previousLength = store.links.length;
  store.links = store.links.filter((link) => link.id !== id);
  store.events = store.events.filter((event) => event.linkId !== id);
  invalidateIndexes();
  await persistStore(store);
  return store.links.length !== previousLength;
}

export async function getSummary(): Promise<DashboardSummary> {
  const store = await getStore();
  const links = withStats(store.links, store.events);
  const activeLinks = store.links.filter((link) => link.status === "active").length;
  const totalClicks = store.events.length;
  const uniqueVisitors = new Set(store.events.map((event) => event.visitorKey)).size;
  const deepLinkedClicks = store.events.filter((event) => event.destination.startsWith("myapp://") || event.destination.startsWith("intent://")).length;

  return {
    totalClicks,
    activeLinks,
    uniqueVisitors,
    deepLinkRate: totalClicks ? Math.round((deepLinkedClicks / totalClicks) * 100) : 0,
    trend: buildSeries(store.events, 14),
    topLinks: links.sort((a, b) => b.clicks - a.clicks).slice(0, 5),
    recentEvents: store.events.slice(0, 7)
  };
}

export async function getAnalytics(days = 30): Promise<AnalyticsPayload> {
  const store = await getStore();
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const events = store.events.filter((event) => new Date(event.occurredAt).getTime() >= since);

  return {
    clicksOverTime: buildSeries(events, Math.min(days, 30)),
    deviceBreakdown: breakdown(events.map((event) => event.device)),
    countryBreakdown: breakdown(events.map((event) => event.country)),
    referrerBreakdown: breakdown(events.map((event) => event.referrer)),
    browserBreakdown: breakdown(events.map((event) => event.browser || "Unknown")),
    dailyBreakdown: buildDailyBreakdown(events, Math.min(days, 30)),
    linkPerformance: withStats(store.links, events).sort((a, b) => b.clicks - a.clicks),
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
