import crypto from "node:crypto";
export { classifyReferrer, detectBrowser, detectDevice, selectDestination } from "../shared/edge.js";

export function cleanSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function hashVisitor(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 24);
}
