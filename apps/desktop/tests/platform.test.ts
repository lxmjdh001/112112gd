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
test("WhatsApp startup database errors remain recoverable and never match a chat message", () => {
  const doc = {
    readyState: "complete" as const,
    querySelector: () => null,
    body: { innerText: "你的浏览器上发生了数据库错误。请重新连接你的设备。" },
  };
  assert.equal(observeWhatsApp(doc, true), "storage_error");
  doc.body.innerText = "A database error occurred on your browser. Please relink your device.";
  assert.equal(observeWhatsApp(doc, true), "storage_error");
  assert.equal(observeWhatsApp({ ...doc, querySelector: () => ({}) as Element }, true), "ready");
});
