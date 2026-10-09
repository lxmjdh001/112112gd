import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleFreeTranslator, parseGoogle } from "../src/main/translation.ts";
test("parses multiple translation segments and preserves punctuation", () => {
  assert.deepEqual(
    parseGoogle([
      [
        ["你好，", "Hello,"],
        ["世界！", "world!"],
      ],
      null,
      "en",
    ]),
    { text: "你好，世界！", sourceLanguage: "en" },
  );
  assert.throws(() => parseGoogle({}), /格式/);
});
test("encodes source text; caches and coalesces requests", async () => {
  let calls = 0;
  const t = new GoogleFreeTranslator(async (url) => {
    calls++;
    assert.equal(new URL(url).searchParams.get("q"), "a & b?");
    return new Response(JSON.stringify([[["甲和乙"]], null, "en"]));
  });
  const [a, b] = await Promise.all([
    t.translate("a & b?", "zh-CN"),
    t.translate("a & b?", "zh-CN"),
  ]);
  assert.equal(a.text, b.text);
  await t.translate("a & b?", "zh-CN");
  assert.equal(calls, 1);
  await t.translate("a & b?", "en");
  assert.equal(calls, 2);
});
test("rejects oversize/empty/unsupported requests before sending", async () => {
  const t = new GoogleFreeTranslator(async () => {
    throw Error("should not fetch");
  });
  for (const text of ["", "x".repeat(4001)]) await assert.rejects(t.translate(text, "en"), /4000/);
  await assert.rejects(t.translate("hello", "invalid"), /语言/);
});
test("handles rate limits and does not include source text in network errors", async () => {
  const t = new GoogleFreeTranslator(async () => new Response("", { status: 429 }));
  await assert.rejects(t.translate("private message", "en"), /限流/);
  const f = new GoogleFreeTranslator(async () => {
    throw Error("private message");
  });
  await assert.rejects(
    f.translate("private message", "en"),
    (e) => !(e as Error).message.includes("private message"),
  );
});
