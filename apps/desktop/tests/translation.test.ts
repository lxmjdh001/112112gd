import { test } from "node:test";
import assert from "node:assert/strict";
import { FreeTranslator, parseGoogle, splitTranslation } from "../src/main/translation.ts";
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
  const usage: unknown[] = [];
  const t = new FreeTranslator(
    async (url) => {
      calls++;
      assert.equal(new URL(url).searchParams.get("q"), "a & b?");
      return new Response(JSON.stringify([[["甲和乙"]], null, "en"]));
    },
    (event) => {
      usage.push(event);
    },
  );
  const [a, b] = await Promise.all([
    t.translate("a & b?", "zh-CN"),
    t.translate("a & b?", "zh-CN"),
  ]);
  assert.equal(a.text, b.text);
  await t.translate("a & b?", "zh-CN");
  assert.equal(calls, 1);
  assert.deepEqual(usage, [
    { inputChars: 6, outputChars: 3, targetLanguage: "zh-CN", provider: "google-free" },
  ]);
  await t.translate("a & b?", "en");
  assert.equal(calls, 2);
  assert.equal(usage.length, 2);
});
test("rejects oversize/empty/unsupported requests before sending", async () => {
  const t = new FreeTranslator(async () => {
    throw Error("should not fetch");
  });
  for (const text of ["", "x".repeat(4001)]) await assert.rejects(t.translate(text, "en"), /4000/);
  await assert.rejects(t.translate("hello", "invalid"), /语言/);
});
test("handles rate limits and does not include source text in network errors", async () => {
  const t = new FreeTranslator(async () => new Response("", { status: 429 }));
  await assert.rejects(t.translate("private message", "zh-CN"), /限流/);
  const f = new FreeTranslator(async () => {
    throw Error("private message");
  });
  await assert.rejects(
    f.translate("private message", "zh-CN"),
    (e) => !(e as Error).message.includes("private message"),
  );
});
test("rate-limited automatic requests pause without contacting Google again", async () => {
  let calls = 0;
  const translator = new FreeTranslator(async () => {
    calls++;
    return new Response("", { status: 429 });
  });
  await assert.rejects(translator.translate("first sample", "zh-CN"), /限流/);
  await assert.rejects(translator.translate("second sample", "zh-CN"), /限流/);
  assert.equal(calls, 2);
});

test("Google 429 falls back to MyMemory and keeps provider usage accurate", async () => {
  const urls: URL[] = [],
    usages: { provider: string }[] = [];
  const t = new FreeTranslator(
    async (value) => {
      const url = new URL(value);
      urls.push(url);
      if (url.hostname === "translate.googleapis.com") return new Response("", { status: 429 });
      assert.equal(url.hostname, "api.mymemory.translated.net");
      assert.equal(url.searchParams.get("langpair"), "zh-CN|pt");
      assert.ok(new TextEncoder().encode(url.searchParams.get("q")!).length <= 500);
      return Response.json({ responseStatus: 200, responseData: { translatedText: "Olá" } });
    },
    (usage) => usages.push(usage),
  );
  const result = await t.translate("你好", "pt");
  assert.equal(result.text, "Olá");
  assert.equal(result.provider, "mymemory");
  await t.translate("你好", "pt");
  await t.translate("谢谢", "pt");
  assert.equal(urls.filter((u) => u.hostname === "translate.googleapis.com").length, 1);
  assert.equal(urls.length, 3);
  assert.deepEqual(
    usages.map((u) => u.provider),
    ["mymemory", "mymemory"],
  );
});
test("segments long Unicode messages without exceeding the byte limit or losing content", async () => {
  const source = "你好🌍这是一个长句。\n".repeat(60).trim();
  const chunks = splitTranslation(source);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk.text) <= 500);
  assert.equal(chunks.map((c) => c.text + c.separator).join(""), source);
  let calls = 0;
  const t = new FreeTranslator(async (url) => {
    if (new URL(url).hostname === "translate.googleapis.com")
      return new Response("", { status: 429 });
    calls++;
    return Response.json({ responseStatus: 200, responseData: { translatedText: `part${calls}` } });
  });
  const result = await t.translate(source, "pt");
  assert.equal(calls, chunks.length);
  assert.ok(result.text.indexOf("part1") < result.text.indexOf("part2"));
});
test("a quota error returned as HTTP 200 must never become a chat message", async () => {
  let calls = 0;
  const t = new FreeTranslator(async (url) => {
    calls++;
    return new URL(url).hostname === "translate.googleapis.com"
      ? new Response("", { status: 429 })
      : Response.json({
          responseStatus: 429,
          quotaFinished: true,
          responseData: { translatedText: "MYMEMORY WARNING" },
        });
  });
  await assert.rejects(t.translate("你好", "en"), /额度/);
  await assert.rejects(t.translate("谢谢", "en"), /额度/);
  assert.equal(calls, 2);
});
