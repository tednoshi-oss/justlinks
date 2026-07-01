import assert from "node:assert/strict";
import test from "node:test";
import type { SmartLink } from "../shared/types.js";
import { AGE_GATE_ENABLED, androidExternalBrowserIntent, deepLinkEscapeUrl, effectiveCountryFilter, externalBrowserEscapeAttemptUrl, isCountryBlocked, isEscapedBrowserRequest, isInAppBrowser, isInstagramInAppBrowser, isIosInstagramInAppBrowser, isLinkPreviewBot, makeRedirectToken, normalizeCountryCode, parseHtmlMetadata, previewFetchUrl, renderCountryBlockedPage, renderDecoyPage, renderDeepLinkEscapePage, renderLinkPreviewPage, renderStealthInterstitialPage, shouldServeFastDeepLinkEscape, shouldShowAgeGate, shouldUseBrowserEscape, STEALTH_HEADERS, verifyRedirectToken } from "../shared/edge.js";
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

test("Instagram in-app browser is detected so its traffic skips the escape page (opens in-app)", () => {
  // The redirect handlers gate the escape page on !isInstagramInAppBrowser, so
  // Instagram traffic just opens in its in-app browser. Reddit/FB/TikTok don't match.
  assert.equal(isInstagramInAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 300.0.0.0"), true);
  assert.equal(isInstagramInAppBrowser("Mozilla/5.0 (Linux; Android 14; Pixel) Instagram 300.0.0.0"), true);
  assert.equal(isInstagramInAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Reddit/2026"), false);
  assert.equal(isInstagramInAppBrowser("Mozilla/5.0 (Linux; Android 14) FBAN/FB4A;FBAV/450"), false);
  assert.equal(isInstagramInAppBrowser("Mozilla/5.0 (iPhone) BytedanceWebview/d8a21c TikTok 32"), false);
  assert.equal(isInstagramInAppBrowser(""), false);
});

test("signed redirect tokens: round-trip, slug-bound, expiry, tamper, wrong secret", async () => {
  const secret = "unit-test-secret";
  const now = 1_700_000_000_000;
  const token = await makeRedirectToken(secret, "d-abc", now);
  assert.equal(await verifyRedirectToken(secret, "d-abc", token, now), true);
  assert.equal(await verifyRedirectToken(secret, "d-abc", token, now + 14 * 60 * 1000), true); // still inside 15m
  assert.equal(await verifyRedirectToken(secret, "d-abc", token, now + 16 * 60 * 1000), false); // expired
  assert.equal(await verifyRedirectToken(secret, "d-other", token, now), false); // bound to slug
  assert.equal(await verifyRedirectToken("wrong-secret", "d-abc", token, now), false); // bound to secret
  assert.equal(await verifyRedirectToken(secret, "d-abc", `${token}x`, now), false); // tampered signature
  assert.equal(await verifyRedirectToken(secret, "d-abc", "", now), false);
  assert.equal(await verifyRedirectToken(secret, "d-abc", "notatoken", now), false);
});

test("decoy page served to bots is benign: no destination, noindex, no adult signals", () => {
  const html = renderDecoyPage();
  assert.match(html, /noindex/);
  assert.doesNotMatch(html, /https?:\/\//); // no URLs at all
  assert.doesNotMatch(html, /fanvue|onlyfans|fv-/i); // no destination hints
});

test("stealth interstitial hides the destination behind a token; age gate is optional", async () => {
  const token = await makeRedirectToken("s", "d-abc", 1700000000000);
  // Common stealth properties regardless of the gate.
  const withGate = renderStealthInterstitialPage("d-abc", token, true);
  const noGate = renderStealthInterstitialPage("d-abc", token, false);
  for (const html of [withGate, noGate]) {
    assert.match(html, /noindex/); // #7
    assert.match(html, /history\.replaceState/); // #10 query wipe
    assert.match(html, /\/__open/); // resolves via POST, not in the HTML
    assert.ok(html.includes(token)); // carries the signed token
    assert.doesNotMatch(html, /fanvue|onlyfans/i); // never the real URL
  }
  // The visible gate prompt only appears when requested (#9 optional).
  assert.match(withGate, /Are you 18 or older\?/);
  assert.doesNotMatch(noGate, /Are you 18 or older\?/);
});

test("age gate is Instagram-only and follows the AGE_GATE_ENABLED switch", () => {
  // Instagram traffic mirrors the global switch; everything else is never gated.
  assert.equal(shouldShowAgeGate("Mozilla/5.0 (iPhone) Instagram 300.0.0.0"), AGE_GATE_ENABLED);
  assert.equal(shouldShowAgeGate("Mozilla/5.0 (iPhone) Reddit/2026"), false);
  assert.equal(shouldShowAgeGate("Mozilla/5.0 (Macintosh) Safari/605"), false); // escaped/external browser
  assert.equal(shouldShowAgeGate(""), false);
});

test("Instagram escape: iOS-only is excluded (stays in-app); Android Instagram escapes", () => {
  // The escape gate keys off isIosInstagramInAppBrowser, so only iOS Instagram is held back.
  assert.equal(isIosInstagramInAppBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Instagram 309.0.0"), true);
  assert.equal(isIosInstagramInAppBrowser("Mozilla/5.0 (iPad) Instagram 309"), true);
  assert.equal(isIosInstagramInAppBrowser("Mozilla/5.0 (Linux; Android 14; Pixel) Instagram 309.0.0"), false); // Android IG escapes
  assert.equal(isIosInstagramInAppBrowser("Mozilla/5.0 (iPhone) Reddit/2026"), false);
  assert.equal(isIosInstagramInAppBrowser("Mozilla/5.0 (iPhone) Safari/605"), false);
  // Android Instagram gets the manual escape card with a forced-Chrome intent.
  const androidIg = renderDeepLinkEscapePage("https://tapsocials.com/d-x?escaped=1", "Mozilla/5.0 (Linux; Android 14) Instagram 309");
  assert.match(androidIg, /package=com\.android\.chrome/);
  assert.match(androidIg, /Open in Chrome/);
});

test("STEALTH_HEADERS enforce no-referrer + noindex on redirect-path responses", () => {
  assert.equal(STEALTH_HEADERS["Referrer-Policy"], "no-referrer");
  assert.match(STEALTH_HEADERS["X-Robots-Tag"], /noindex/);
  assert.match(STEALTH_HEADERS["Cache-Control"], /no-store/);
});

test("Facebook/TikTok in-app browsers still get the manual escape card (never blank)", () => {
  // Android (Facebook): forced Chrome intent + auto-attempt on load.
  const fb = renderDeepLinkEscapePage("https://tapsocials.com/d-test?escaped=1", "Mozilla/5.0 (Linux; Android 14) FBAN/FB4A;FBAV/450");
  assert.doesNotMatch(fb, /document\.write\(freshHtml\)/);
  assert.match(fb, /onclick="openExternal\(\)"/);
  assert.match(fb, /attempt\(\);\s*<\/script>/);
  assert.match(fb, /package=com\.android\.chrome/);
  // iOS (TikTok): auto-attempt schemes on load + native share sheet on tap.
  const tiktok = renderDeepLinkEscapePage("https://tapsocials.com/d-test?escaped=1", "Mozilla/5.0 (iPhone) BytedanceWebview/d8a21c TikTok 32");
  assert.match(tiktok, /onclick="openExternal\(\)"/);
  assert.match(tiktok, /googlechromes:\/\//);
  assert.match(tiktok, /navigator\.share/);
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
