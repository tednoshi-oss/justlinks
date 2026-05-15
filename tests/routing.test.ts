import assert from "node:assert/strict";
import test from "node:test";
import type { SmartLink } from "../shared/types.js";
import { androidExternalBrowserIntent, deepLinkEscapeUrl, externalBrowserEscapeAttemptUrl, isEscapedBrowserRequest, isInAppBrowser, renderDeepLinkEscapePage, shouldServeFastDeepLinkEscape, shouldUseBrowserEscape } from "../shared/edge.js";
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
  assert.match(html, /document\.write\(freshHtml\)/);
  assert.match(html, /x-safari-https/);
  assert.match(html, /com-apple-mobilesafari-tab/);
  assert.match(html, /shortcuts:\/\/x-callback-url\/run-shortcut/);
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
