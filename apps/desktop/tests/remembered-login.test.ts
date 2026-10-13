import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { RememberedLogin } from "../src/main/remembered-login.ts";

test("remembered codes are encrypted, survive restart, replace on switch and clear without login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "d1-remember-"));
  const file = join(directory, "preferences.json");
  const key = randomBytes(32);
  const encrypt = (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  };
  const decrypt = (data: Buffer) => {
    const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString();
  };
  const create = (url = "https://api.example.test") =>
    new RememberedLogin(file, url, encrypt, decrypt);
  try {
    const store = create();
    assert.deepEqual(await store.read(), { remember: true, code: "" });
    const first = "GD7-fixture-secret-one",
      second = "GD7-fixture-secret-two";
    await store.save(first);
    const disk = await readFile(file, "utf8");
    assert(!disk.includes(first));
    assert.equal(decrypt(Buffer.from(JSON.parse(disk).encryptedCode, "base64")), first);
    assert.deepEqual(await create().read(), { remember: true, code: first });
    assert.deepEqual(await create("https://another.example.test").read(), {
      remember: true,
      code: "",
    });
    await store.save(second);
    assert.deepEqual(await create().read(), { remember: true, code: second });
    // Serialized clearing wins even if a successful save has not finished writing.
    await Promise.all([store.save(first), store.save(null)]);
    assert.deepEqual(await create().read(), { remember: false, code: "" });
    assert.equal(JSON.parse(await readFile(file, "utf8")).encryptedCode, undefined);
    // A corrupt file can still be forgotten, without decrypting it.
    await writeFile(file, "corrupt");
    await assert.rejects(create().read(), /无法读取/);
    await store.save(null);
    const unavailable = new RememberedLogin(
      file,
      "https://api.example.test",
      () => {
        throw Error("locked");
      },
      decrypt,
    );
    await assert.rejects(unavailable.save(second), /locked/);
    assert.deepEqual(await create().read(), { remember: false, code: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
