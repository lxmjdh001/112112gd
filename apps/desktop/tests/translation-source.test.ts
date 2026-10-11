import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSource } from "../../../packages/translation/source.ts";
test("local detection identifies scripts and does not label Latin replies as Chinese", () => {
  assert.equal(detectSource("Quero fazer um pedido de 500 unidades.", "en"), "pt");
  assert.equal(detectSource("你好，我想订购500件。", "en"), "zh-CN");
  assert.equal(detectSource("Price for 1000 pcs?", "zh-CN"), "en");
  assert.equal(detectSource("Hello", "zh-CN"), "en");
  assert.equal(detectSource("Bonjour", "en"), "fr");
  assert.equal(detectSource("これは日本語です。", "zh-CN"), "ja");
});
