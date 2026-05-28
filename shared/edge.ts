import type { DeviceType, LinkGroup, LinkStatus, SmartLink } from "./types.js";

export type CountryFilterMode = "none" | "block" | "allow";

export interface EdgeLinkConfig {
  id: string;
  name?: string;
  slug: string;
  description?: string;
  status: LinkStatus;
  iosUrl: string;
  androidUrl: string;
  webUrl: string;
  fallbackUrl: string;
  isDeepLink?: boolean;
  forceExternalBrowser?: boolean;
  countryFilterMode?: CountryFilterMode;
  blockedCountries?: string[];
  allowedCountries?: string[];
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

export interface LinkPreviewMetadata {
  title: string;
  description: string;
  image?: string;
  siteName?: string;
  url: string;
}

export const dashboardPathPrefixes = ["/dashboard", "/api", "/assets"] as const;
export const dashboardExactPaths = ["/", "/reset", "/forgot", "/favicon.png", "/favicon.svg", "/tapsocials-logo.svg", "/robots.txt", "/manifest.webmanifest"] as const;

export function toEdgeLink(link: SmartLink, group?: Pick<LinkGroup, "countryFilterMode" | "blockedCountries" | "allowedCountries"> | null): EdgeLinkConfig {
  const filter = effectiveCountryFilter(link, group);
  return {
    id: link.id,
    name: link.name,
    slug: link.slug,
    description: link.description || link.notes,
    status: link.status,
    iosUrl: link.iosUrl,
    androidUrl: link.androidUrl,
    webUrl: link.webUrl,
    fallbackUrl: link.fallbackUrl,
    isDeepLink: Boolean(link.isDeepLink),
    forceExternalBrowser: Boolean(link.forceExternalBrowser),
    countryFilterMode: filter.countryFilterMode,
    blockedCountries: filter.blockedCountries && filter.blockedCountries.length ? filter.blockedCountries : undefined,
    allowedCountries: filter.allowedCountries && filter.allowedCountries.length ? filter.allowedCountries : undefined
  };
}

export function normalizeCountryCode(country: string | undefined | null): string {
  return String(country || "").trim().toUpperCase();
}

export function resolveCountryFilterMode(link: Pick<EdgeLinkConfig, "countryFilterMode" | "blockedCountries" | "allowedCountries">): CountryFilterMode {
  if (link.countryFilterMode === "block" || link.countryFilterMode === "allow" || link.countryFilterMode === "none") return link.countryFilterMode;
  if (link.allowedCountries && link.allowedCountries.length) return "allow";
  if (link.blockedCountries && link.blockedCountries.length) return "block";
  return "none";
}

// Resolves the effective country filter for a link, falling back to its group's
// filter when the link itself has no active filter. Used at sync time so the
// worker just sees the final effective filter in KV.
export function effectiveCountryFilter(
  link: Pick<EdgeLinkConfig, "countryFilterMode" | "blockedCountries" | "allowedCountries">,
  group?: Pick<EdgeLinkConfig, "countryFilterMode" | "blockedCountries" | "allowedCountries"> | null
): Pick<EdgeLinkConfig, "countryFilterMode" | "blockedCountries" | "allowedCountries"> {
  if (resolveCountryFilterMode(link) !== "none") {
    return {
      countryFilterMode: link.countryFilterMode,
      blockedCountries: link.blockedCountries,
      allowedCountries: link.allowedCountries
    };
  }
  if (group && resolveCountryFilterMode(group) !== "none") {
    return {
      countryFilterMode: group.countryFilterMode,
      blockedCountries: group.blockedCountries,
      allowedCountries: group.allowedCountries
    };
  }
  return {
    countryFilterMode: undefined,
    blockedCountries: undefined,
    allowedCountries: undefined
  };
}

export function isCountryBlocked(link: Pick<EdgeLinkConfig, "countryFilterMode" | "blockedCountries" | "allowedCountries">, country: string | undefined | null): boolean {
  const mode = resolveCountryFilterMode(link);
  if (mode === "none") return false;
  const code = normalizeCountryCode(country);

  if (mode === "block") {
    if (!link.blockedCountries || link.blockedCountries.length === 0) return false;
    if (!code) return false;
    return link.blockedCountries.some((blocked) => normalizeCountryCode(blocked) === code);
  }

  if (mode === "allow") {
    if (!link.allowedCountries || link.allowedCountries.length === 0) return false;
    if (!code) return true; // Unknown country fails an allow-only check
    return !link.allowedCountries.some((allowed) => normalizeCountryCode(allowed) === code);
  }

  return false;
}

export function renderCountryBlockedPage(country: string): string {
  const safeCountry = escapeHtml(country || "your region");
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Not available in your region</title>
      <style>
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #f2f2f3; }
        main { width: min(420px, calc(100vw - 32px)); border: 1px solid #27272f; border-radius: 12px; background: #0f0f12; padding: 28px; text-align: center; }
        h1 { margin: 0 0 8px; font-size: 22px; }
        p { margin: 0; color: #8d8d98; line-height: 1.5; }
        small { display: block; margin-top: 18px; color: #5f5f6c; font-size: 12px; }
      </style>
    </head>
    <body>
      <main>
        <h1>Not available in your region</h1>
        <p>This link isn't available in ${safeCountry}.</p>
        <small>If you believe this is a mistake, contact the link owner.</small>
      </main>
    </body>
  </html>`;
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

export function isLinkPreviewBot(userAgent = ""): boolean {
  return /TelegramBot|Twitterbot|facebookexternalhit|Facebot|WhatsApp|Slackbot|Discordbot|LinkedInBot|Pinterest|SkypeUriPreview|redditbot|Applebot|Googlebot|bingbot|bot|crawler|spider/i.test(userAgent);
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

export function previewFetchUrl(destination: string): string {
  try {
    const url = new URL(destination);
    const host = url.hostname.replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    if (host === "fanvue.com" && parts.length >= 2 && /^fv-[a-z0-9_-]+$/i.test(parts[1])) {
      return `${url.protocol}//${url.host}/${parts[0]}`;
    }
    return url.toString();
  } catch {
    return destination;
  }
}

export function parseHtmlMetadata(html: string, baseUrl: string): Partial<LinkPreviewMetadata> {
  const title = metaContent(html, "og:title") || metaContent(html, "twitter:title") || titleContent(html);
  const description = metaContent(html, "og:description") || metaContent(html, "twitter:description") || metaContent(html, "description");
  const image = metaContent(html, "og:image") || metaContent(html, "twitter:image");
  const siteName = metaContent(html, "og:site_name") || metaContent(html, "application-name");
  const canonical = linkHref(html, "canonical") || metaContent(html, "og:url");

  return {
    title: title ? decodeHtml(title).trim() : undefined,
    description: description ? decodeHtml(description).trim() : undefined,
    image: image ? absoluteUrl(decodeHtml(image).trim(), baseUrl) : undefined,
    siteName: siteName ? decodeHtml(siteName).trim() : undefined,
    url: canonical ? absoluteUrl(decodeHtml(canonical).trim(), baseUrl) : baseUrl
  };
}

export function renderLinkPreviewPage(metadata: LinkPreviewMetadata, shortUrl: string, destination: string): string {
  const title = escapeHtml(metadata.title);
  const description = escapeHtml(metadata.description);
  const image = metadata.image ? escapeHtml(metadata.image) : "";
  const siteName = escapeHtml(metadata.siteName || new URL(shortUrl).hostname.replace(/^www\./, ""));
  const safeShortUrl = escapeHtml(shortUrl);
  const safeDestination = escapeHtml(destination);
  const jsDestination = JSON.stringify(destination);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="description" content="${description}"><meta property="og:type" content="website"><meta property="og:url" content="${safeShortUrl}"><meta property="og:site_name" content="${siteName}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}">${image ? `<meta property="og:image" content="${image}"><meta name="twitter:image" content="${image}">` : ""}<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><link rel="canonical" href="${safeShortUrl}"><script>if(!/bot|crawler|spider|preview|telegram|twitter|facebook|whatsapp|discord|slack|reddit/i.test(navigator.userAgent||"")){window.location.replace(${jsDestination});}</script></head><body><main><a href="${safeDestination}" rel="nofollow noreferrer">Continue</a></main></body></html>`;
}

function renderFastBrowserTrampoline(targetUrl: string, browserName: string, isAndroid: boolean, safeTarget: string): string {
  void targetUrl;
  void browserName;
  void isAndroid;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening link</title></head><body style="background:#fff"><script>
    (function() {
      var ua = navigator.userAgent || '';
      var path = window.location.pathname;
      var search = window.location.search || '';
      if (search.indexOf('escaped=1') !== -1) return;
      var isIOS = /iPhone|iPad|iPod/i.test(ua);
      var isAndroid = /Android/i.test(ua);
      var isInstagram = /Instagram/i.test(ua);
      if (isInstagram && (isIOS || isAndroid)) return;
      var isDeepLink = /^\\/d-[a-zA-Z0-9_-]{3,64}$/.test(path);
      if (!isDeepLink) return;
      var code = path.substring(1);
      if (!isIOS && !isAndroid) return;
      var referrer = document.referrer || '';
      var metaReferrerPatterns = ['facebook.com', 'l.facebook.com', 'lm.facebook.com', 'm.facebook.com', 'threads.net', 'whatsapp.com', 'wa.me', 'web.whatsapp.com', 'tiktok.com', 'vm.tiktok.com'];
      var isMetaReferrer = metaReferrerPatterns.some(function(p) { return referrer.toLowerCase().indexOf(p) !== -1; });
      var isMetaUA = /FBAN|FBAV|FB_IAB|Threads|TikTok|BytedanceWebview/i.test(ua);
      var isMetaTraffic = isMetaReferrer || isMetaUA;
      if (isMetaTraffic) return;
      var escUrl = window.location.protocol + '//' + window.location.host + '/' + code + '?escaped=1';
      if (isIOS) {
        var fastUrl = escUrl + '&_t=' + Date.now() + Math.random().toString(36).substring(2,6);
        var fastAnchor = document.createElement('a');
        fastAnchor.href = 'x-safari-https://' + fastUrl.replace(/^https?:\\/\\//, '');
        fastAnchor.target = '_self';
        fastAnchor.rel = 'noreferrer';
        document.body.appendChild(fastAnchor);
        fastAnchor.click();
      }
      if (isAndroid) {
        var fastAndroidUrl = escUrl + '&_t=' + Date.now() + Math.random().toString(36).substring(2,6);
        var fastAndroidParsed = new URL(fastAndroidUrl);
        var fastAndroidAnchor = document.createElement('a');
        fastAndroidAnchor.href = 'intent://' + fastAndroidParsed.host + fastAndroidParsed.pathname + fastAndroidParsed.search + fastAndroidParsed.hash + '#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=com.android.chrome;S.browser_fallback_url=' + encodeURIComponent(fastAndroidUrl) + ';end';
        fastAndroidAnchor.target = '_self';
        fastAndroidAnchor.rel = 'noreferrer';
        document.body.appendChild(fastAndroidAnchor);
        fastAndroidAnchor.click();
      }
      var freshHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#fff">';
      freshHtml += '<div id="trampoline-overlay" style="position:fixed;inset:0;z-index:99999;background:#fff"></div>';
      freshHtml += '<' + 'script>';
      freshHtml += '(function(){';
      freshHtml += 'var escapeUrl="' + escUrl.replace(/"/g, '\\"') + '";';
      freshHtml += 'var uniqueUrl=escapeUrl+"&_t="+Date.now()+Math.random().toString(36).substring(2,6);';
      freshHtml += 'function tapOpen(url){var a=document.createElement("a");a.href=url;a.target="_self";a.rel="noreferrer";document.body.appendChild(a);a.click();}';
      freshHtml += 'function androidChromeIntent(url){var u=new URL(url);return "intent://"+u.host+u.pathname+u.search+u.hash+"#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=com.android.chrome;S.browser_fallback_url="+encodeURIComponent(url)+";end";}';
      freshHtml += 'function openAndroidChrome(url){var intent=androidChromeIntent(url);tapOpen(intent);setTimeout(function(){window.location.href=intent;},80);}';
      if (isIOS) {
        freshHtml += 'var w=uniqueUrl.replace(/^https?:\\\\/\\\\//,"");';
        freshHtml += 'tapOpen("x-safari-https://"+w);';
        freshHtml += 'setTimeout(function(){window.location.href="com-apple-mobilesafari-tab:"+uniqueUrl;},200);';
      } else {
        freshHtml += 'try{openAndroidChrome(uniqueUrl);}';
        freshHtml += 'catch(e){window.location.href=androidChromeIntent(escapeUrl);}';
      }
      var escapeTo = isIOS ? 'Safari' : 'Chrome';
      freshHtml += 'setTimeout(function(){';
      freshHtml += 'var o=document.getElementById("trampoline-overlay");if(!o)return;';
      freshHtml += 'var w2=document.createElement("div");w2.style.cssText="position:absolute;bottom:60px;left:0;right:0;text-align:center";';
      freshHtml += 'var b=document.createElement("a");b.href="#";';
      freshHtml += 'b.style.cssText="display:inline-block;padding:14px 32px;background:#000;color:#fff;font-weight:600;font-size:16px;border-radius:12px;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif";';
      freshHtml += 'b.textContent="Open in ' + escapeTo + '";';
      freshHtml += 'b.onclick=function(ev){ev.preventDefault();';
      freshHtml += 'var u2=escapeUrl+"&_t="+Date.now()+Math.random().toString(36).substring(2,6);';
      if (isIOS) {
        freshHtml += 'var rn=Math.random().toString(36).substring(2,10);';
        freshHtml += 'window.location.href="shortcuts://x-callback-url/run-shortcut?name="+rn+"&x-error="+encodeURIComponent(u2);';
        freshHtml += 'setTimeout(function(){tapOpen("x-safari-https://"+u2.replace(/^https?:\\\\/\\\\//,""));},100);';
        freshHtml += 'setTimeout(function(){window.location.href="com-apple-mobilesafari-tab:"+u2;},250);';
      } else {
        freshHtml += 'try{openAndroidChrome(u2);}catch(e2){window.location.href=androidChromeIntent(u2);}';
      }
      freshHtml += 'setTimeout(function(){window.open(u2,"_blank");},2000);};';
      freshHtml += 'w2.appendChild(b);o.appendChild(w2);';
      freshHtml += '},' + (isIOS ? '1500' : '700') + ');';
      freshHtml += '})();';
      freshHtml += '</' + 'script></body></html>';
      document.open();
      document.write(freshHtml);
      document.close();
    })();
    </script><div id="root"></div><noscript><p><a href="${safeTarget}">Open in ${escapeHtml("Safari")}</a></p></noscript></body></html>`;
}

function metaContent(html: string, key: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = attrValue(tag, "property") || attrValue(tag, "name");
    if (name?.toLowerCase() === key.toLowerCase()) return attrValue(tag, "content");
  }
  return undefined;
}

function linkHref(html: string, rel: string): string | undefined {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const value = attrValue(tag, "rel");
    if (value?.toLowerCase() === rel.toLowerCase()) return attrValue(tag, "href");
  }
  return undefined;
}

function attrValue(tag: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return tag.match(pattern)?.[2];
}

function titleContent(html: string): string | undefined {
  return html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
}

function absoluteUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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
