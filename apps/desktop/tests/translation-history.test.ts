import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TranslationHistory } from "../src/main/translation-history.ts";
test("original replies survive restart, are encrypted, scoped to peer and reject writes after close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gd7-translations-"));
  const file = join(dir, "account.bin"),
    key = randomBytes(32);
  const encrypt = (s: string) => {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]);
  };
  const decrypt = (b: Buffer) => {
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(-16));
    return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
  };
  try {
    const store = new TranslationHistory(file, encrypt, decrypt);
    const record = { identifier: "15550000001", source: "原文报价", text: "Quote" };
    await Promise.all([
      store.put("one", record),
      store.put("two", { ...record, identifier: "15550000002" }),
    ]);
    assert(!(await readFile(file)).includes(Buffer.from(record.source)));
    await store.close();
    await assert.rejects(store.put("three", record), /关闭/);
    const restored = new TranslationHistory(file, encrypt, decrypt);
    assert.deepEqual(await restored.list("15550000001"), { one: record });
    assert.deepEqual(await restored.list("unknown"), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
