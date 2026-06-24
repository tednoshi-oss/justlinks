import assert from "node:assert/strict";
import test from "node:test";
import type { SmartLink } from "../shared/types.js";
import { androidExternalBrowserIntent, deepLinkEscapeUrl, effectiveCountryFilter, externalBrowserEscapeAttemptUrl, isCountryBlocked, isEscapedBrowserRequest, isInAppBrowser, isLinkPreviewBot, normalizeCountryCode, parseHtmlMetadata, previewFetchUrl, renderCountryBlockedPage, renderDeepLinkEscapePage, renderLinkPreviewPage, shouldServeFastDeepLinkEscape, shouldUseBrowserEscape } from "../shared/edge.js";
import { cleanSlug, detectDevice, selectDestination } from "../server/routing.js";

const link: SmartLink = {
  id: "test",
  name: "Test",
  slug: "test",
  description: "",
  iosUrl: "myapp://test",
  androidUrl: "intent://test#Intent;scheme=myapp;end",
  webUrl: "https://example.com/web",
  fallbackUrl: "https://example.com/fallback",
  deepLinkPath: "/test",
  tags: [],
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

test("detectDevice handles common user agents and test overrides", () => {
  assert.equal(detectDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "iOS");
  assert.equal(detectDevice("Mozilla/5.0 (Linux; Android 14; Pixel)"), "Android");
  assert.equal(detectDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "Desktop");
  assert.equal(detectDevice("Unknown", "android"), "Android");
});

test("selectDestination chooses platform-specific URLs with fallback", () => {
  assert.equal(selectDestination(link, "iOS"), "myapp://test");
  assert.equal(selectDestination(link, "Android"), "intent://test#Intent;scheme=myapp;end");
  assert.equal(selectDestination(link, "Desktop"), "https://example.com/web");
  assert.equal(selectDestination({ ...link, webUrl: "" }, "Desktop"), "https://example.com/fallback");
});

test("cleanSlug creates compact URL-safe slugs", () => {
  assert.equal(cleanSlug("  Summer Drop 2026!!! "), "summer-drop-2026");
  assert.equal(cleanSlug("A/B Deep Link"), "a-b-deep-link");
});

test("androidExternalBrowserIntent wraps http destinations for social in-app browsers", () => {
  assert.equal(
    androidExternalBrowserIntent("https://example.com/path?x=1"),
    "intent://example.com/path?x=1#Intent;scheme=https;S.browser_fallback_url=https%3A%2F%2Fexample.com%2Fpath%3Fx%3D1;end"
  );
  assert.equal(androidExternalBrowserIntent("myapp://path"), null);
  assert.equal(isInAppBrowser("Mozilla/5.0 Reddit/2026 iPhone"), true);
});

test("deep link browser escape targets the same short link before final redirect", () => {
  const escaped = deepLinkEscapeUrl("https://tapsocials.com/d-test?utm=one");
  assert.equal(escaped, "https://tapsocials.com/d-test?utm=one&escaped=1");
  assert.equal(isEscapedBrowserRequest(new URL(escaped).searchParams), true);
  assert.equal(shouldUseBrowserEscape({ slug: "plain", isDeepLink: true }), true);
  assert.equal(shouldUseBrowserEscape({ slug: "d-prefixed" }), true);
  assert.equal(shouldUseBrowserEscape({ slug: "plain" }), false);
  assert.equal(
    externalBrowserEscapeAttemptUrl(escaped, "Android"),
    "intent://tapsocials.com/d-test?utm=one&escaped=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Ftapsocials.com%2Fd-test%3Futm%3Done%26escaped%3D1;end"
  );
  assert.equal(externalBrowserEscapeAttemptUrl(escaped, "iOS"), "x-safari-https://tapsocials.com/d-test?utm=one&escaped=1");
});

test("iOS deep link escape page uses fast Safari trampoline with fallback", () => {
  const html = renderDeepLinkEscapePage("https://tapsocials.com/d-test?escaped=1", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Reddit/2026");
  assert.match(html, /fastAnchor\.click\(\)/);
  assert.match(html, /document\.write\(freshHtml\)/);
  assert.match(html, /tapOpen\("x-safari-https/);
  assert.match(html, /x-safari-https/);
  // Dead schemes were removed in cleanup — Safari tab + Shortcuts hacks no longer fire.
  assert.doesNotMatch(html, /com-apple-mobilesafari-tab/);
  assert.doesNotMatch(html, /shortcuts:\/\/x-callback-url\/run-shortcut/);
});

test("Instagram iOS gets a never-blank manual escape card preferring Chrome then Safari", () => {
  const html = renderDeepLinkEscapePage(
    "https://tapsocials.com/d-test?escaped=1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 300.0.0.0"
  );
  // It is a real, rendered page (not the auto-escape trampoline) with a tap button.
  assert.doesNotMatch(html, /document\.write\(freshHtml\)/);
  assert.match(html, /onclick="openExternal\(\)"/);
  assert.match(html, /Open in browser/);
  // Tapping launches Chrome first, then falls back to Safari.
  assert.match(html, /googlechromes:\/\//);
  assert.match(html, /x-safari-https:\/\//);
  // No dead schemes.
  assert.doesNotMatch(html, /com-apple-mobilesafari-tab/);
  assert.doesNotMatch(html, /shortcuts:\/\/x-callback-url/);
});

test("Instagram Android gets a never-blank manual escape card with a forced Chrome intent", () => {
  const html = renderDeepLinkEscapePage(
    "https://tapsocials.com/d-test?escaped=1",
    "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Instagram 300.0.0.0"
  );
  // Never blank: it renders a tap button, not the aborted-trampoline blank page.
  assert.match(html, /onclick="openExternal\(\)"/);
  assert.match(html, /Open in Chrome/);
  assert.match(html, /intent:\/\//);
  assert.match(html, /package=com\.android\.chrome/);
  assert.match(html, /S\.browser_fallback_url/);
});

test("Facebook/TikTok in-app browsers also get the manual escape card (no blank page)", () => {
  const fb = renderDeepLinkEscapePage("https://tapsocials.com/d-test?escaped=1", "Mozilla/5.0 (Linux; Android 14) FBAN/FB4A;FBAV/450");
  assert.match(fb, /onclick="openExternal\(\)"/);
  assert.match(fb, /package=com\.android\.chrome/);
  const tiktok = renderDeepLinkEscapePage("https://tapsocials.com/d-test?escaped=1", "Mozilla/5.0 (iPhone) BytedanceWebview/d8a21c TikTok 32");
  assert.match(tiktok, /onclick="openExternal\(\)"/);
  assert.match(tiktok, /googlechromes:\/\//);
});

test("Android deep link escape page uses an anchor-click Chrome intent", () => {
  const html = renderDeepLinkEscapePage("https://tapsocials.com/d-test?escaped=1", "Mozilla/5.0 (Linux; Android 14; Pixel) Reddit/2026");
  assert.match(html, /fastAndroidAnchor\.click\(\)/);
  assert.match(html, /openAndroidChrome\(uniqueUrl\)/);
  assert.match(html, /intent:\/\//);
  assert.match(html, /action=android\.intent\.action\.VIEW/);
  assert.match(html, /category=android\.intent\.category\.BROWSABLE/);
  assert.match(html, /package=com\.android\.chrome/);
  assert.match(html, /S\.browser_fallback_url/);
});

test("fast deep link escape runs before link lookup for Reddit and Telegram style traffic", () => {
  const redditIos = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Reddit/2026";
  const telegramAndroid = "Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Telegram-Android/11 Chrome/120 Mobile Safari/537.36";

  assert.equal(shouldServeFastDeepLinkEscape({ pathname: "/d-PAXGfRB1", searchParams: new URLSearchParams(), userAgent: redditIos }), true);
  assert.equal(shouldServeFastDeepLinkEscape({ pathname: "/d-PAXGfRB1", searchParams: new URLSearchParams(), userAgent: telegramAndroid }), true);
  assert.equal(shouldServeFastDeepLinkEscape({ pathname: "/d-PAXGfRB1", searchParams: new URLSearchParams("escaped=1"), userAgent: redditIos }), false);
  assert.equal(shouldServeFastDeepLinkEscape({ pathname: "/plain-link", searchParams: new URLSearchParams(), userAgent: redditIos }), false);
  assert.equal(shouldServeFastDeepLinkEscape({ pathname: "/d-PAXGfRB1", searchParams: new URLSearchParams(), userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" }), false);
  assert.equal(shouldServeFastDeepLinkEscape({ pathname: "/d-PAXGfRB1", searchParams: new URLSearchParams(), userAgent: `${redditIos} Instagram` }), false);
  assert.equal(shouldServeFastDeepLinkEscape({ pathname: "/d-PAXGfRB1", searchParams: new URLSearchParams(), userAgent: "FBAN/FBIOS", referrer: "https://facebook.com/" }), false);
});

test("link preview helpers use rich destination metadata", () => {
  assert.equal(previewFetchUrl("https://www.fanvue.com/rileybabe/fv-22"), "https://www.fanvue.com/rileybabe");
  assert.equal(isLinkPreviewBot("TelegramBot (like TwitterBot)"), true);
  assert.equal(isLinkPreviewBot("Mozilla/5.0 Safari/605.1.15"), false);

  const metadata = parseHtmlMetadata(
    '<html><head><title>Fallback</title><meta property="og:title" content="Riley&#x27;s Fanvue"><meta property="og:description" content="Bio &amp; more"><meta property="og:image" content="/avatar.png"><meta property="og:site_name" content="Fanvue"></head></html>',
    "https://www.fanvue.com/rileybabe"
  );
  assert.equal(metadata.title, "Riley's Fanvue");
  assert.equal(metadata.description, "Bio & more");
  assert.equal(metadata.image, "https://www.fanvue.com/avatar.png");
  assert.equal(metadata.siteName, "Fanvue");

  const html = renderLinkPreviewPage(
    {
      title: "Riley's Fanvue",
      description: "Bio & more",
      image: "https://www.fanvue.com/avatar.png",
      siteName: "Fanvue",
      url: "https://www.fanvue.com/rileybabe"
    },
    "https://tapsocials.com/d-test",
    "https://www.fanvue.com/rileybabe/fv-22"
  );
  assert.match(html, /og:title/);
  assert.match(html, /Riley&#39;s Fanvue/);
  assert.match(html, /https:\/\/www\.fanvue\.com\/avatar\.png/);
});

test("country filter: block + allow modes, mode resolution, and backward compat", () => {
  assert.equal(normalizeCountryCode(" us "), "US");
  assert.equal(normalizeCountryCode(null), "");

  // Legacy: only blockedCountries set, no explicit mode -> resolves to block
  const legacyBlock = { blockedCountries: ["RU", "CN", "IR"] };
  assert.equal(isCountryBlocked(legacyBlock, "RU"), true);
  assert.equal(isCountryBlocked(legacyBlock, "ru"), true);
  assert.equal(isCountryBlocked(legacyBlock, " CN "), true);
  assert.equal(isCountryBlocked(legacyBlock, "US"), false);
  assert.equal(isCountryBlocked(legacyBlock, ""), false);
  assert.equal(isCountryBlocked(legacyBlock, undefined), false);

  // Explicit "none" mode -> never blocked even if list has codes
  assert.equal(isCountryBlocked({ countryFilterMode: "none", blockedCountries: ["RU"] }, "RU"), false);

  // Explicit "block" mode
  assert.equal(isCountryBlocked({ countryFilterMode: "block", blockedCountries: ["RU"] }, "RU"), true);
  assert.equal(isCountryBlocked({ countryFilterMode: "block", blockedCountries: ["RU"] }, "US"), false);
  assert.equal(isCountryBlocked({ countryFilterMode: "block", blockedCountries: [] }, "RU"), false);

  // Explicit "allow" mode -> only listed countries pass through
  const allowOnly = { countryFilterMode: "allow" as const, allowedCountries: ["US", "GB", "DE"] };
  assert.equal(isCountryBlocked(allowOnly, "US"), false);
  assert.equal(isCountryBlocked(allowOnly, "gb"), false);
  assert.equal(isCountryBlocked(allowOnly, "RU"), true);
  assert.equal(isCountryBlocked(allowOnly, "IN"), true);
  // Empty allow list -> nothing blocked (don't accidentally block everyone)
  assert.equal(isCountryBlocked({ countryFilterMode: "allow", allowedCountries: [] }, "US"), false);
  // Unknown country fails an allow check
  assert.equal(isCountryBlocked(allowOnly, ""), true);

  // Blocked page renders + escapes injection
  const html = renderCountryBlockedPage("RU");
  assert.match(html, /Not available in your region/);
  assert.match(html, /isn't available in RU/);
  assert.match(html, /<title>Not available in your region<\/title>/);
  const htmlWithInjection = renderCountryBlockedPage("<script>alert(1)</script>");
  assert.doesNotMatch(htmlWithInjection, /<script>alert/);
  assert.match(htmlWithInjection, /&lt;script&gt;/);
});

test("group country filter cascades to links when the link has no own filter", () => {
  const groupBlock = { countryFilterMode: "block" as const, blockedCountries: ["RU", "CN"] };
  const groupAllow = { countryFilterMode: "allow" as const, allowedCountries: ["US", "GB"] };
  const linkNoFilter = { countryFilterMode: undefined, blockedCountries: undefined, allowedCountries: undefined };
  const linkOwnBlock = { countryFilterMode: "block" as const, blockedCountries: ["DE"] };
  const linkOwnAllow = { countryFilterMode: "allow" as const, allowedCountries: ["JP"] };
  const linkExplicitNone = { countryFilterMode: "none" as const, blockedCountries: ["DE"] };

  // Link with no filter inherits from group
  const effective1 = effectiveCountryFilter(linkNoFilter, groupBlock);
  assert.deepEqual(effective1.blockedCountries, ["RU", "CN"]);
  assert.equal(isCountryBlocked(effective1, "RU"), true);
  assert.equal(isCountryBlocked(effective1, "US"), false);

  // Link with no filter inherits group allow-only
  const effective2 = effectiveCountryFilter(linkNoFilter, groupAllow);
  assert.equal(isCountryBlocked(effective2, "US"), false);
  assert.equal(isCountryBlocked(effective2, "RU"), true);

  // Link with its own block filter overrides group's
  const effective3 = effectiveCountryFilter(linkOwnBlock, groupBlock);
  assert.deepEqual(effective3.blockedCountries, ["DE"]);
  assert.equal(isCountryBlocked(effective3, "DE"), true);
  assert.equal(isCountryBlocked(effective3, "RU"), false); // not in link's list, group ignored

  // Link with its own allow filter overrides group's block filter
  const effective4 = effectiveCountryFilter(linkOwnAllow, groupBlock);
  assert.equal(isCountryBlocked(effective4, "JP"), false);
  assert.equal(isCountryBlocked(effective4, "US"), true); // not in link's allow list

  // No group → fall back to link's own filter (or none)
  const effective5 = effectiveCountryFilter(linkNoFilter, null);
  assert.equal(isCountryBlocked(effective5, "US"), false);

  // Explicit "none" on link falls back to group filter (same as no filter at all).
  // To opt out of a group filter for one link, set the link's mode to "block"
  // with an empty blockedCountries list — that wins and lets everyone through.
  const effective6 = effectiveCountryFilter(linkExplicitNone, groupBlock);
  assert.equal(isCountryBlocked(effective6, "RU"), true);
  assert.equal(isCountryBlocked(effective6, "DE"), false);

  const linkExplicitEmptyBlock = { countryFilterMode: "block" as const, blockedCountries: [] };
  const effective7 = effectiveCountryFilter(linkExplicitEmptyBlock, groupBlock);
  assert.equal(isCountryBlocked(effective7, "RU"), false); // link's empty list wins, no one blocked
});
