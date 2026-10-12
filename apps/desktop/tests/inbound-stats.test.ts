import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInbound } from "../../../packages/platform/core/inbound-stats.ts";
import { InboundQueue } from "../src/main/inbound-queue.ts";
const sec = Math.floor(Date.now() / 1000) - 5;
function sandbox(window: any, document: any = {}) {
  const context = vm.createContext({ window, document });
  return (platform: string, ack: string[] = [], owner = "8613800000000") =>
    vm.runInContext(
      `(${collectInbound.toString()})(${JSON.stringify(platform)},${JSON.stringify(ack)},${JSON.stringify(owner)})`,
      context,
    );
}
test("WhatsApp observes unopened personal messages, retries until ack, ignores groups and outgoing", () => {
  const listeners = new Map();
  const messages: any[] = [];
  const Msg = {
    getModelsArray: () => messages,
    on: (k: any, f: any) => listeners.set(k, f),
    off: (k: any) => listeners.delete(k),
  };
  const read = sandbox({ require: () => ({ Msg }) });
  assert.equal(read("whatsapp").ready, true);
  const msg = (id: string, fromMe = false, server = "c.us") => ({
    id: { id, fromMe, remote: { user: "447700900001", server } },
    t: sec,
    type: "chat",
    body: "PRIVATE CONTENT",
  });
  listeners.get("add")(msg("in"));
  listeners.get("add")(msg("out", true));
  listeners.get("add")(msg("group", false, "g.us"));
  listeners.get("add")({ ...msg("system"), type: "notification_template" });
  let b = read("whatsapp");
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].customer, "447700900001");
  assert(!JSON.stringify(b).includes("PRIVATE"));
  assert.equal(read("whatsapp").events.length, 1);
  assert.equal(read("whatsapp", [b.events[0].id]).events.length, 0);
  listeners.get("add")(msg("in"));
  assert.equal(read("whatsapp").events.length, 0);
  read("whatsapp", [], "8613900000000");
  listeners.get("add")(msg("new-owner"));
  b = read("whatsapp", [], "8613900000000");
  assert(b.events[0].id.startsWith("8613900000000:"));
});
test("Telegram events count only incoming user messages, not groups/services/outgoing", () => {
  const listeners = new Map();
  const root = {
    myId: 12345,
    addEventListener: (k: any, f: any) => listeners.set(k, f),
    removeEventListener: (k: any) => listeners.delete(k),
  };
  const read = sandbox({ rootScope: root });
  assert.equal(read("telegram").ready, true);
  const msg = {
    _: "message",
    id: 10,
    peerId: 55555,
    peer_id: { user_id: 55555 },
    pFlags: {},
    date: sec,
    message: "PRIVATE",
  };
  listeners.get("history_multiappend")(msg);
  listeners.get("history_append")({ message: msg });
  listeners.get("history_update")({ message: { ...msg, id: 11, pFlags: { out: true } } });
  listeners.get("history_multiappend")({ ...msg, id: 12, _: "messageService" });
  listeners.get("history_multiappend")({ ...msg, id: 13, peer_id: { chat_id: 55555 } });
  const b = read("telegram");
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].customer, "55555");
  assert(!JSON.stringify(b).includes("PRIVATE"));
});
test("LINE Redux subscription reads incoming personal messages regardless of opened chat", () => {
  const owner = "u" + "a".repeat(32),
    peer = "u" + "b".repeat(32);
  let listener = () => {};
  const data = {
    auth: { loginState: "logged_in", profile: { mid: owner } },
    message: { entities: { messages: {} as any } },
  };
  const store = {
    getState: () => data,
    subscribe: (f: any) => {
      listener = f;
      return () => {
        listener = () => {};
      };
    },
  };
  const document = {
    getElementById: () => ({ __reactContainer$test: { memoizedProps: { value: { store } } } }),
  };
  const read = sandbox({}, document);
  assert.equal(read("line").ready, true);
  data.message.entities.messages = {
    one: { id: "123", from: peer, to: owner, toType: 0, createdTime: sec * 1000 },
    group: { id: "124", from: peer, to: owner, toType: 2, createdTime: sec * 1000 },
    out: { id: "125", from: owner, to: peer, toType: 0, createdTime: sec * 1000 },
  };
  listener();
  assert.equal(read("line").events.length, 1);
});
test("outbox survives network failure and restart, removes only acknowledged batch and isolates owners", async () => {
  const dir = await mkdtemp(join(tmpdir(), "d1-inbound-"));
  const file = join(dir, "queue.bin");
  const encrypt = (s: string) => Buffer.from(Buffer.from(s).map((b) => b ^ 91));
  const decrypt = (b: Buffer) => Buffer.from(Buffer.from(b).map((b) => b ^ 91)).toString();
  try {
    const a = new InboundQueue(file, encrypt, decrypt);
    const e = { id: "owner:one", customer: "447700900001", at: new Date().toISOString() };
    await a.enqueue({ owner: "owner", ready: true, events: [e] });
    await assert.rejects(
      a.flush("owner", true, async () => {
        throw Error("offline");
      }),
    );
    assert(!(await readFile(file)).includes(e.customer));
    const b = new InboundQueue(file, encrypt, decrypt);
    let uploaded: any;
    await b.flush("other", true, async (data) => {
      assert.equal(data.events.length, 0);
    });
    await b.flush("owner", true, async (data) => {
      uploaded = data;
      await b.enqueue({ owner: "owner", ready: true, events: [{ ...e, id: "owner:two" }] });
    });
    assert.equal(uploaded.events.length, 1);
    await b.flush("owner", true, async (data) => {
      assert.equal(data.events.length, 1);
      assert.equal(data.events[0].id, "owner:two");
    });
    await b.close();
    const c = new InboundQueue(file, encrypt, decrypt);
    await c.flush("owner", true, async (data) => {
      assert.equal(data.events.length, 0);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WhatsApp keeps LID stable and includes a resolved phone as an alias", () => {
  const Msg = {
    getModelsArray: () => [
      {
        id: { id: "lid", fromMe: false, remote: { user: "12345678901234", server: "lid" } },
        t: sec,
        type: "chat",
      },
    ],
    on() {},
    off() {},
  };
  const read = sandbox({
    require: () => ({ Msg, Contact: { get: () => ({ phoneNumber: { user: "447700900001" } }) } }),
  });
  const event = read("whatsapp").events[0];
  assert.equal(event.customer, "lid:12345678901234");
  assert.equal(event.phone, "447700900001");
});
