import type { DeviceType, LinkStatus, SmartLink } from "./types.js";

export interface EdgeLinkConfig {
  id: string;
  slug: string;
  status: LinkStatus;
  iosUrl: string;
  androidUrl: string;
  webUrl: string;
  fallbackUrl: string;
  isDeepLink?: boolean;
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
    isDeepLink: Boolean(link.isDeepLink),
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

export function isMobileDevice(device: DeviceType): boolean {
  return device === "iOS" || device === "Android";
}

export function shouldUseBrowserEscape(link: Pick<EdgeLinkConfig, "slug" | "isDeepLink" | "forceExternalBrowser">): boolean {
  return Boolean(link.forceExternalBrowser || link.isDeepLink || link.slug.startsWith("d-"));
}

export function shouldServeFastDeepLinkEscape({
  pathname,
  searchParams,
  userAgent = "",
  referrer = ""
}: {
  pathname: string;
  searchParams: URLSearchParams;
  userAgent?: string;
  referrer?: string | null;
}): boolean {
  if (isEscapedBrowserRequest(searchParams)) return false;

  const slug = slugFromPath(pathname);
  if (!slug?.startsWith("d-")) return false;

  const device = detectDevice(userAgent);
  if (!isMobileDevice(device)) return false;

  const ua = userAgent.toLowerCase();
  if (ua.includes("instagram")) return false;

  const ref = (referrer || "").toLowerCase();
  const metaReferrers = ["facebook.com", "l.facebook.com", "lm.facebook.com", "m.facebook.com", "threads.net", "whatsapp.com", "wa.me", "web.whatsapp.com", "tiktok.com", "vm.tiktok.com"];
  if (metaReferrers.some((pattern) => ref.includes(pattern))) return false;
  if (/FBAN|FBAV|FB_IAB|Threads|TikTok|BytedanceWebview/i.test(userAgent)) return false;

  return true;
}

export function isEscapedBrowserRequest(searchParams: URLSearchParams): boolean {
  return searchParams.get("escaped") === "1";
}

export function deepLinkEscapeUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.searchParams.set("escaped", "1");
  return url.toString();
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

export function externalBrowserEscapeAttemptUrl(targetUrl: string, device: DeviceType): string | null {
  if (!isHttpUrl(targetUrl)) return null;
  const url = new URL(targetUrl);

  if (device === "Android") {
    const scheme = url.protocol.replace(":", "");
    return `intent://${url.host}${url.pathname}${url.search}${url.hash}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(targetUrl)};end`;
  }

  if (device === "iOS") {
    return `x-safari-https://${targetUrl.replace(/^https?:\/\//, "")}`;
  }

  return null;
}

export function renderDeepLinkEscapePage(targetUrl: string, userAgent = ""): string {
  const safeTarget = escapeHtml(targetUrl);
  const jsTarget = JSON.stringify(targetUrl);
  const isIos = /iphone|ipad|ipod/i.test(userAgent);
  const isAndroid = /android/i.test(userAgent);
  const browserName = isAndroid ? "Chrome" : "Safari";
  const instagramIos = isIos && /instagram/i.test(userAgent);

  if (instagramIos) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open in Safari</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#fff;font-family:-apple-system,BlinkMacSystemFont,Inter,ui-sans-serif,system-ui,sans-serif}main{width:min(360px,calc(100vw - 40px));border:1px solid rgb(255 255 255 / .12);border-radius:18px;background:#1a1a2e;padding:24px;text-align:center;box-shadow:0 24px 80px rgb(0 0 0 / .5)}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:rgb(255 255 255 / .62);font-size:14px;line-height:1.45}.primary,.secondary{display:flex;width:100%;min-height:46px;align-items:center;justify-content:center;border:0;border-radius:12px;font-weight:700;text-decoration:none}.primary{margin-top:20px;background:#3b82f6;color:#fff}.secondary{margin-top:12px;background:rgb(255 255 255 / .06);color:rgb(255 255 255 / .82);border:1px solid rgb(255 255 255 / .12)}small{display:block;margin-top:10px;color:rgb(255 255 255 / .42)}</style></head><body><main><h1>Open in Safari</h1><p>Instagram's browser can't open this link directly.</p><button class="primary" type="button" onclick="tapShareBrowser()">Share &amp; Open in Safari</button><button class="secondary" type="button" onclick="tapCopyLink()">Copy Link</button><small>Tap "Open in Safari" from the share menu</small></main><script>var tapTarget=${jsTarget};function tapShareBrowser(){if(navigator.share){navigator.share({url:tapTarget}).catch(function(){window.location.href=tapTarget;});return;}window.location.href=tapTarget;}function tapCopyLink(){function done(){var b=document.querySelector('.secondary');if(b)b.textContent='Copied!';}if(navigator.clipboard){navigator.clipboard.writeText(tapTarget).then(done).catch(copyFallback);return;}copyFallback();function copyFallback(){var t=document.createElement('textarea');t.value=tapTarget;t.style.cssText='position:fixed;opacity:0';document.body.appendChild(t);t.select();try{document.execCommand('copy');done();}catch(e){}document.body.removeChild(t);}}</script></body></html>`;
  }

  return renderFastBrowserTrampoline(targetUrl, browserName, isAndroid, safeTarget);
}

function renderFastBrowserTrampoline(targetUrl: string, browserName: string, isAndroid: boolean, safeTarget: string): string {
  const jsTarget = JSON.stringify(targetUrl);
  const jsBrowser = JSON.stringify(browserName);
  const jsIsAndroid = JSON.stringify(isAndroid);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening link</title></head><body style="background:#fff"><script>(function(){var escapeUrl=${jsTarget};var escapeTo=${jsBrowser};var isAndroid=${jsIsAndroid};var freshHtml='<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#fff">';freshHtml+='<div id="trampoline-overlay" style="position:fixed;inset:0;z-index:99999;background:#fff"></div>';freshHtml+='<scr'+'ipt>';freshHtml+='(function(){';freshHtml+='var escapeUrl='+JSON.stringify(escapeUrl)+';';freshHtml+='var escapeTo='+JSON.stringify(escapeTo)+';';freshHtml+='var isAndroid='+JSON.stringify(isAndroid)+';';freshHtml+='function fresh(url){return url+(url.indexOf("?")!==-1?"&":"?")+"_t="+Date.now()+Math.random().toString(36).substring(2,6);}';freshHtml+='var uniqueUrl=fresh(escapeUrl);';freshHtml+='if(isAndroid){try{var u=new URL(uniqueUrl);window.location.href="intent://"+u.host+u.pathname+u.search+u.hash+"#Intent;scheme="+u.protocol.replace(":","")+";package=com.android.chrome;S.browser_fallback_url="+encodeURIComponent(uniqueUrl)+";end";}catch(e){window.location.href=uniqueUrl;}}else{var w=uniqueUrl.replace(/^https?:\\\\/\\\\//,"");window.location.href="x-safari-https://"+w;setTimeout(function(){window.location.href="com-apple-mobilesafari-tab:"+uniqueUrl;},200);}';freshHtml+='setTimeout(function(){var o=document.getElementById("trampoline-overlay");if(!o)return;var w2=document.createElement("div");w2.style.cssText="position:absolute;bottom:60px;left:0;right:0;text-align:center";var b=document.createElement("a");b.href="#";b.style.cssText="display:inline-block;padding:14px 32px;background:#000;color:#fff;font-weight:600;font-size:16px;border-radius:12px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif";b.textContent="Open in "+escapeTo;b.onclick=function(ev){ev.preventDefault();var u2=fresh(escapeUrl);if(isAndroid){try{var u3=new URL(u2);window.location.href="intent://"+u3.host+u3.pathname+u3.search+u3.hash+"#Intent;scheme="+u3.protocol.replace(":","")+";package=com.android.chrome;end";}catch(e2){window.location.href=u2;}}else{var rn=Math.random().toString(36).substring(2,10);window.location.href="shortcuts://x-callback-url/run-shortcut?name="+rn+"&x-error="+encodeURIComponent(u2);setTimeout(function(){window.location.href="x-safari-https://"+u2.replace(/^https?:\\\\/\\\\//,"");},100);setTimeout(function(){window.location.href="com-apple-mobilesafari-tab:"+u2;},250);}setTimeout(function(){window.open(u2,"_blank");},2000);};w2.appendChild(b);o.appendChild(w2);},1500);';freshHtml+='})();';freshHtml+='</scr'+'ipt></body></html>';document.open();document.write(freshHtml);document.close();})();</script><noscript><p><a href="${safeTarget}">Open in ${escapeHtml(browserName)}</a></p></noscript></body></html>`;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === "\"") return "&quot;";
    return "&#39;";
  });
}
