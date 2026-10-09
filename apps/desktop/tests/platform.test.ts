import { test } from "node:test";
import assert from "node:assert/strict";
import { observeWhatsApp } from "../../../packages/platform/whatsapp/index.ts";
import { getPlatform } from "../../../packages/platform/registry.ts";
test("unknown DOM is never classified as logged out", () => {
  const doc = { readyState: "complete" as const, querySelector: () => null };
  assert.equal(observeWhatsApp(doc, true), "unknown");
  assert.equal(observeWhatsApp(doc, false), "network_error");
  assert.throws(() => getPlatform("unsupported"));
  assert.equal(getPlatform("whatsapp").capabilities.messageArchive, false);
});
