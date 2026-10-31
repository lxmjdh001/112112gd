import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatArchiveQueue,
  type ArchiveBatch,
  type ArchiveQueueOptions,
} from "../src/main/chat-archive-queue.ts";

const scope = { tenantId: "tenant-a", accountId: "account-a", deviceId: "device-a" };
const at = "2026-01-01T00:00:00.000Z";
const message = (id: string, body = "private message", observedAt = at) => ({
  id,
  customer: "8613900000000",
  direction: "in" as const,
  body,
  kind: "text",
  at,
  observedAt,
});
const batch = (owner = "8613800000000", ids = ["m1"]): ArchiveBatch => ({
  owner,
  ready: true,
  historyScope: "loaded_only",
  messages: ids.map((id) => message(id)),
});
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "d1-archive-queue-"));
  const file = join(directory, "outbox.bin");
  const key = randomBytes(32);
  const options: ArchiveQueueOptions = {
    file,
    scope,
    encrypt(plain) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decrypt(encrypted) {
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
  return {
    directory,
    file,
    options,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("chat outbox persists encrypted text, restores it and removes only acknowledged records", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    assert.deepEqual(await queue.enqueue(batch()), { accepted: 1, pending: 1 });
    assert(!(await readFile(f.file)).includes(Buffer.from("private message")));
    await queue.close();
    const restored = new ChatArchiveQueue(f.options);
    let observed: ArchiveBatch | undefined;
    assert.equal(
      await restored.flush(batch().owner, true, async (value) => {
        observed = value;
        return { accepted: 1, enabled: true };
      }),
      1,
    );
    assert.equal(observed?.messages[0].body, "private message");
    assert.equal(
      await restored.flush(batch().owner, true, async () => assert.fail("already acknowledged")),
      0,
    );
    const third = new ChatArchiveQueue(f.options);
    assert.equal(
      await third.flush(batch().owner, true, async () => assert.fail("disk was not cleared")),
      0,
    );
    await third.close();
    await restored.close();
  } finally {
    await f.cleanup();
  }
});

test("failed, partial and disabled-server acknowledgements retain all pending messages", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    await queue.enqueue(batch());
    await assert.rejects(
      queue.flush(batch().owner, true, async () => {
        throw Error("offline");
      }),
      /offline/,
    );
    await assert.rejects(
      queue.flush(batch().owner, true, async () => ({ accepted: 0, enabled: true })),
      /尚未全部确认/,
    );
    await assert.rejects(
      queue.flush(batch().owner, true, async () => ({ accepted: 0, enabled: false })),
      /尚未全部确认/,
    );
    await queue.close();
    const restored = new ChatArchiveQueue(f.options);
    assert.equal(
      await restored.flush(batch().owner, true, async (value) => ({
        accepted: value.messages.length,
        enabled: true,
      })),
      1,
    );
    await restored.close();
  } finally {
    await f.cleanup();
  }
});

test("only an explicit enabled acknowledgement with the exact count removes pending text", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    await queue.enqueue(batch());
    const persisted = await readFile(f.file);
    for (const acknowledgement of [
      undefined,
      null,
      false,
      {},
      { enabled: true },
      { accepted: 1 },
      { accepted: 1, enabled: false },
      { accepted: "1", enabled: true },
      { accepted: 2, enabled: true },
    ]) {
      await assert.rejects(
        queue.flush(batch().owner, true, async () => acknowledgement),
        /尚未全部确认/,
      );
      assert((await readFile(f.file)).equals(persisted));
    }
    await queue.close();
    const restored = new ChatArchiveQueue(f.options);
    assert.equal(
      await restored.flush(batch().owner, true, async (value) => {
        assert.equal(value.messages[0].body, "private message");
        return { accepted: value.messages.length, enabled: true };
      }),
      1,
    );
    await restored.close();
  } finally {
    await f.cleanup();
  }
});

test("body and name limits count Unicode code points and reject oversized text atomically", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    const body = "🙂".repeat(8000);
    const name = "🙂".repeat(150);
    await queue.enqueue({ ...batch(), messages: [{ ...message("unicode", body), name }] });
    const persisted = await readFile(f.file);
    for (const invalid of [
      { ...message("oversized-body", body + "🙂"), name },
      { ...message("oversized-name", "valid"), name: name + "🙂" },
      { ...message("oversized-ascii-name", "valid"), name: "a".repeat(151) },
    ]) {
      await assert.rejects(queue.enqueue({ ...batch(), messages: [invalid] }), /格式或长度/);
      assert((await readFile(f.file)).equals(persisted));
    }
    assert.deepEqual(await queue.enqueue({ ...batch(), messages: [] }), {
      accepted: 0,
      pending: 1,
    });
    await queue.close();
    const restored = new ChatArchiveQueue(f.options);
    assert.equal(
      await restored.flush(batch().owner, true, async (value) => {
        assert.equal(value.messages.length, 1);
        assert.equal(value.messages[0].body, body);
        assert.equal(value.messages[0].name, name);
        return { accepted: 1, enabled: true };
      }),
      1,
    );
    await restored.close();
  } finally {
    await f.cleanup();
  }
});

test("an edit queued while a previous version is being sent survives its acknowledgement", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    await queue.enqueue(batch());
    const entered = deferred();
    const accept = deferred();
    const sending = queue.flush(batch().owner, true, async () => {
      entered.resolve();
      await accept.promise;
      return { accepted: 1, enabled: true };
    });
    await entered.promise;
    await queue.enqueue({
      ...batch(),
      messages: [message("m1", "edited private text", "2026-01-02T00:00:00.000Z")],
    });
    // A second flush must not send concurrently or falsely claim an acknowledgement.
    assert.equal(
      await queue.flush(batch().owner, true, async () => assert.fail("concurrent send")),
      0,
    );
    accept.resolve();
    await sending;
    let text = "";
    assert.equal(
      await queue.flush(batch().owner, true, async (value) => {
        text = value.messages[0].body;
        return { accepted: value.messages.length, enabled: true };
      }),
      1,
    );
    assert.equal(text, "edited private text");
    await queue.close();
  } finally {
    await f.cleanup();
  }
});

test("older edits, duplicates and owner switches cannot overwrite a newer owner's data", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    await queue.enqueue({
      ...batch(),
      messages: [message("m1", "latest", "2026-01-02T00:00:00Z")],
    });
    await queue.enqueue({ ...batch(), messages: [message("m1", "old", at)] });
    await queue.enqueue({
      ...batch(),
      messages: [message("m1", "latest", "2026-01-03T00:00:00Z")],
    });
    await queue.enqueue(batch("8613700000000"));
    assert.equal(
      await queue.flush(batch().owner, false, async () => assert.fail("unready send")),
      0,
    );
    let seen: ArchiveBatch | undefined;
    assert.equal(
      await queue.flush("8613700000000", true, async (value) => {
        seen = value;
        return { accepted: value.messages.length, enabled: true };
      }),
      1,
    );
    assert.equal(seen?.owner, "8613700000000");
    assert.equal(seen?.messages[0].body, "private message");
    assert.equal(
      await queue.flush(batch().owner, true, async (value) => {
        seen = value;
        return { accepted: value.messages.length, enabled: true };
      }),
      1,
    );
    assert.equal(seen?.messages[0].body, "latest");
    await queue.close();
  } finally {
    await f.cleanup();
  }
});

test("tenant, account and device scope mismatches fail closed without replacing encrypted files", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    await queue.enqueue(batch());
    await queue.close();
    const original = await readFile(f.file);
    for (const field of ["tenantId", "accountId", "deviceId"] as const) {
      const wrong = new ChatArchiveQueue({ ...f.options, scope: { ...scope, [field]: "other" } });
      await assert.rejects(wrong.enqueue(batch()), /无法解密或校验/);
      await wrong.close().catch(() => {});
      assert((await readFile(f.file)).equals(original));
    }
    await writeFile(f.file, Buffer.from("corrupted ciphertext"));
    const corrupt = new ChatArchiveQueue(f.options);
    await assert.rejects(corrupt.enqueue(batch()), /无法解密或校验/);
    assert.equal((await readFile(f.file)).toString(), "corrupted ciphertext");
    await corrupt.close().catch(() => {});
  } finally {
    await f.cleanup();
  }
});

test("full discard erases corrupt or undecryptable files without using encryption callbacks", async () => {
  const f = await fixture();
  try {
    const original = new ChatArchiveQueue(f.options);
    await original.enqueue(batch());
    await original.close();
    const validCiphertext = await readFile(f.file);
    for (const encrypted of [Buffer.from("corrupted ciphertext"), validCiphertext]) {
      await writeFile(f.file, encrypted);
      const locked = new ChatArchiveQueue({
        ...f.options,
        encrypt: () => assert.fail("opt-out must not require encryption"),
        decrypt: () => assert.fail("opt-out must not require decryption"),
      });
      await locked.discard();
      await assert.rejects(readFile(f.file), { code: "ENOENT" });
      await locked.discard(); // Missing files are already fully erased.
      assert.equal(
        await locked.flush(batch().owner, true, async () => assert.fail("discarded text")),
        0,
      );
      await locked.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("full discard follows pending writes and an in-flight acknowledgement cannot recreate its file", async () => {
  const f = await fixture();
  try {
    let encryptions = 0;
    let locked = false;
    const queue = new ChatArchiveQueue({
      ...f.options,
      encrypt: (plain) => {
        assert.equal(locked, false, "discard acknowledgement must not require encryption");
        encryptions++;
        return f.options.encrypt(plain);
      },
    });
    const writing = queue.enqueue(batch());
    const discarded = queue.discard();
    await Promise.all([writing, discarded]);
    assert.equal(encryptions, 1);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
    assert.equal(
      await queue.flush(batch().owner, true, async () =>
        assert.fail("queued write survived erase"),
      ),
      0,
    );
    await queue.enqueue(batch());
    const entered = deferred();
    const release = deferred();
    const sending = queue.flush(batch().owner, true, async () => {
      entered.resolve();
      await release.promise;
      return { accepted: 1, enabled: true };
    });
    await entered.promise;
    locked = true;
    await queue.discard();
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
    release.resolve();
    await sending;
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
    assert.equal(encryptions, 2);
    await queue.close();
  } finally {
    await f.cleanup();
  }
});

test("queue limits reject the whole batch without evicting previously saved text", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue({
      ...f.options,
      limits: { maxMessages: 2, maxBytes: 4096, maxBodyLength: 50 },
    });
    await queue.enqueue(batch());
    const before = await readFile(f.file);
    await assert.rejects(queue.enqueue(batch(batch().owner, ["m2", "m3"])), /缓存已满/);
    assert((await readFile(f.file)).equals(before));
    await assert.rejects(
      queue.enqueue({ ...batch(), messages: [message("m2", "a".repeat(51))] }),
      /格式或长度/,
    );
    assert((await readFile(f.file)).equals(before));
    assert.equal(
      await queue.flush(batch().owner, true, async (value) => {
        assert.deepEqual(
          value.messages.map((m) => m.id),
          ["m1"],
        );
        return { accepted: value.messages.length, enabled: true };
      }),
      1,
    );
    await queue.close();
    const byteLimited = new ChatArchiveQueue({
      ...f.options,
      limits: { maxMessages: 20, maxBytes: 600 },
    });
    await assert.rejects(
      byteLimited.enqueue({ ...batch(), messages: [message("m2", "x".repeat(500))] }),
      /缓存已满/,
    );
    await byteLimited.close().catch(() => {});
  } finally {
    await f.cleanup();
  }
});

test("flush batches are capped at 100 and preserve truncation/history-limit metadata", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    await queue.enqueue({
      ...batch(
        batch().owner,
        Array.from({ length: 205 }, (_, i) => String(i)),
      ),
      limited: true,
      messages: Array.from({ length: 205 }, (_, i) => ({
        ...message(String(i)),
        truncated: i === 0,
      })),
    });
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++)
      await queue.flush(batch().owner, true, async (value) => {
        sizes.push(value.messages.length);
        assert.equal(value.historyScope, "loaded_only");
        assert.equal(value.limited, true);
        if (i === 0) assert.equal(value.messages[0].truncated, true);
        return { accepted: value.messages.length, enabled: true };
      });
    assert.deepEqual(sizes, [100, 100, 5]);
    await queue.close();
  } finally {
    await f.cleanup();
  }
});

test("failed encryption never acknowledges, mutates or writes plaintext; a later retry can recover", async () => {
  const f = await fixture();
  try {
    let fail = true;
    const queue = new ChatArchiveQueue({
      ...f.options,
      encrypt: (plain) => {
        if (fail) throw Error("keychain locked");
        return f.options.encrypt(plain);
      },
    });
    await assert.rejects(queue.enqueue(batch()), /keychain locked/);
    assert.deepEqual(await readdir(f.directory), []);
    fail = false;
    assert.deepEqual(await queue.enqueue(batch()), { accepted: 1, pending: 1 });
    await queue.close();
    assert(!(await readFile(f.file)).includes(Buffer.from("private message")));
    assert.deepEqual(await readdir(f.directory), ["outbox.bin"]);
  } finally {
    await f.cleanup();
  }
});

test("close waits for an in-flight send and queued writes; explicit discard keeps other owners", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    await queue.enqueue(batch());
    await queue.enqueue(batch("8613700000000"));
    await queue.discard("8613700000000");
    assert.equal(
      await queue.flush("8613700000000", true, async () => assert.fail("discarded owner")),
      0,
    );
    const entered = deferred();
    const release = deferred();
    const sending = queue.flush(batch().owner, true, async () => {
      entered.resolve();
      await release.promise;
      return { accepted: 1, enabled: true };
    });
    await entered.promise;
    let closed = false;
    const closing = queue.close().then(() => {
      closed = true;
    });
    await assert.rejects(queue.enqueue(batch()), /已关闭/);
    await assert.rejects(
      queue.flush(batch().owner, true, async () => {}),
      /已关闭/,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false);
    release.resolve();
    await sending;
    await closing;
    assert.equal(closed, true);
    assert.equal(queue.close(), queue.close());
    const reopened = new ChatArchiveQueue(f.options);
    assert.equal(
      await reopened.flush(batch().owner, true, async () => assert.fail("acknowledged on close")),
      0,
    );
    await reopened.enqueue(batch());
    await reopened.discard();
    assert.equal(
      await reopened.flush(batch().owner, true, async () => assert.fail("discarded all")),
      0,
    );
    await reopened.close();
  } finally {
    await f.cleanup();
  }
});

test("invalid batch and message identity changes cannot corrupt existing queue state", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    await queue.enqueue(batch());
    await assert.rejects(queue.enqueue({ ...batch(), ready: false }), /批次无效/);
    await assert.rejects(queue.enqueue({ ...batch(), historyScope: "unavailable" }), /批次无效/);
    await assert.rejects(
      queue.enqueue({ ...batch(), messages: [{ ...message("m1"), customer: "other-customer" }] }),
      /标识发生冲突/,
    );
    await assert.rejects(
      queue.enqueue({ ...batch(), messages: [{ ...message("m1"), direction: "out" }] }),
      /标识发生冲突/,
    );
    assert.equal(
      await queue.flush(batch().owner, true, async (value) => {
        assert.equal(value.messages[0].customer, "8613900000000");
        return { accepted: value.messages.length, enabled: true };
      }),
      1,
    );
    await queue.close();
  } finally {
    await f.cleanup();
  }
});

test("flush caps UTF-8 JSON payload bytes without losing the remaining long messages", async () => {
  const f = await fixture();
  try {
    const queue = new ChatArchiveQueue(f.options);
    const ids = Array.from({ length: 55 }, (_, i) => "long-" + i);
    await queue.enqueue({
      ...batch(),
      messages: ids.map((id) => message(id, "消息".repeat(3500))),
    });
    const received: string[] = [];
    const sizes: number[] = [];
    let acknowledged: number;
    do {
      acknowledged = await queue.flush(batch().owner, true, async (value) => {
        const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
        assert(bytes <= 512 * 1024);
        assert(value.messages.length < 100);
        sizes.push(value.messages.length);
        received.push(...value.messages.map((entry) => entry.id));
        return { accepted: value.messages.length, enabled: true };
      });
    } while (acknowledged > 0);
    assert(sizes.length >= 3);
    assert.deepEqual(received, ids);
    await queue.close();
  } finally {
    await f.cleanup();
  }
});
