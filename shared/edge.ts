import type { DeviceType, LinkStatus, SmartLink } from "./types.js";

export interface EdgeLinkConfig {
  id: string;
  slug: string;
  status: LinkStatus;
  iosUrl: string;
  androidUrl: string;
  webUrl: string;
  fallbackUrl: string;
  forceExternalBrowser?: boolean;
}

export interface EdgeClickEvent {
  id: string;
  linkId: string;
  slug: string;
  occurredAt: string;
  device: DeviceType;
  browser: string;
  country: string;
  referrer: string;
  visitorKey: string;
  destination: string;
}

export const dashboardPathPrefixes = ["/dashboard", "/api", "/assets"] as const;
export const dashboardExactPaths = ["/", "/favicon.png", "/favicon.svg", "/tapsocials-logo.svg", "/robots.txt", "/manifest.webmanifest"] as const;

export function toEdgeLink(link: SmartLink): EdgeLinkConfig {
  return {
    id: link.id,
    slug: link.slug,
    status: link.status,
    iosUrl: link.iosUrl,
    androidUrl: link.androidUrl,
    webUrl: link.webUrl,
    fallbackUrl: link.fallbackUrl,
    forceExternalBrowser: Boolean(link.forceExternalBrowser)
  };
}

export function isDashboardPath(pathname: string): boolean {
  return dashboardExactPaths.includes(pathname as (typeof dashboardExactPaths)[number]) || dashboardPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function slugFromPath(pathname: string): string | null {
  const clean = pathname.replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  const parts = clean.split("/");
  if (parts[0] === "l" && parts[1] && parts.length === 2) return parts[1];
  if (parts.length === 1 && !parts[0].includes(".")) return parts[0];
  return null;
}

export function detectDevice(userAgent = "", target?: string): DeviceType {
  const override = target?.toLowerCase();
  if (override === "ios") return "iOS";
  if (override === "android") return "Android";
  if (override === "desktop" || override === "web") return "Desktop";

  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "iOS";
  if (/android/.test(ua)) return "Android";
  if (/macintosh|windows|linux|x11/.test(ua)) return "Desktop";
  return "Other";
}

export function detectBrowser(userAgent = ""): string {
  const ua = userAgent.toLowerCase();
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("firefox/")) return "Firefox";
  if (ua.includes("samsungbrowser/")) return "Samsung Internet";
  if (ua.includes("opr/") || ua.includes("opera/")) return "Opera";
  if (ua.includes("crios/") || (ua.includes("chrome/") && !ua.includes("edg/"))) return "Chrome";
  if (ua.includes("safari/")) return "Safari";
  return "Unknown";
}

export function selectDestination(link: EdgeLinkConfig, device: DeviceType): string {
  if (device === "iOS" && link.iosUrl) return link.iosUrl;
  if (device === "Android" && link.androidUrl) return link.androidUrl;
  if (device === "Desktop" && link.webUrl) return link.webUrl;
  return link.fallbackUrl || link.webUrl || link.iosUrl || link.androidUrl;
}

export function selectWebFallback(link: EdgeLinkConfig): string {
  return link.webUrl || link.fallbackUrl || link.iosUrl || link.androidUrl;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isInAppBrowser(userAgent = ""): boolean {
  return /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|Twitter|Pinterest|Snapchat|LinkedInApp|Reddit|wv\)|; wv/.test(userAgent);
}

export function androidExternalBrowserIntent(destination: string): string | null {
  if (!isHttpUrl(destination)) return null;
  const url = new URL(destination);
  const scheme = url.protocol.replace(":", "");
  return `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=${scheme};S.browser_fallback_url=${encodeURIComponent(destination)};end`;
}

export function externalBrowserRedirect(destination: string, device: DeviceType): string | null {
  if (device === "Android") return androidExternalBrowserIntent(destination);
  return null;
}

export function classifyReferrer(value?: string | null): string {
  if (!value) return "Direct";
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    if (host.includes("instagram")) return "Instagram";
    if (host.includes("tiktok")) return "TikTok";
    if (host.includes("facebook")) return "Facebook";
    if (host.includes("google")) return "Google";
    if (host.includes("youtube")) return "YouTube";
    return host;
  } catch {
    return "Direct";
  }
}
