import assert from "node:assert/strict";
import test from "node:test";
import type { SmartLink } from "../shared/types.js";
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
