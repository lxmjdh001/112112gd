import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountCleanup } from "../src/main/account-cleanup.ts";

test("interrupted account removal retries only after an authorized sync confirms absence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gd7-cleanup-"));
  try {
    const file = path.join(dir, "pending.json");
    const entry = { tenantId: randomUUID(), codeId: randomUUID(), accountId: randomUUID() };
    const failed = new AccountCleanup(file, async () => {
      throw Error("disk unavailable");
    });
    await failed.load();
    await failed.remember(entry);
    await assert.rejects(failed.finish(entry.tenantId, entry.accountId), /disk unavailable/);
    const cleared: string[][] = [];
    const restored = new AccountCleanup(file, async (tenant, account) => {
      cleared.push([tenant, account]);
    });
    await restored.load();
    await restored.reconcile(entry.tenantId, entry.codeId, new Set([entry.accountId]));
    await restored.reconcile(randomUUID(), entry.codeId, new Set());
    await restored.reconcile(entry.tenantId, randomUUID(), new Set());
    assert.deepEqual(cleared, []);
    await restored.reconcile(entry.tenantId, entry.codeId, new Set([randomUUID()]));
    assert.deepEqual(cleared, [[entry.tenantId, entry.accountId]]);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
    await restored.reconcile(entry.tenantId, entry.codeId, new Set());
    assert.equal(cleared.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
