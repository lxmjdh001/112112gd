import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  collectChatArchive,
  disposeChatArchive,
} from "../../../packages/platform/core/chat-archive.ts";

const seconds = Math.floor(Date.now() / 1000) - 10;
function sandbox(window: any, document: any = {}) {
  const ctx = vm.createContext({ window, document });
  return {
    read: (platform: string, ack: string[] = [], owner = "8613800000000") =>
      vm.runInContext(
        `(${collectChatArchive.toString()})(${JSON.stringify(platform)},${JSON.stringify(ack)},${JSON.stringify(owner)})`,
        ctx,
      ),
    dispose: () => vm.runInContext(`(${disposeChatArchive.toString()})()`, ctx),
    state: () => window.__d1ChatArchiveV1,
  };
}
function waFixture() {
  let owner = "8613800000000",
    ready = true;
  const models: any[] = [],
    listeners = new Map<string, Function>();
  let requires = 0;
  const messages = {
    getModelsArray: () => models,
    on: (name: string, fn: Function) => listeners.set(name, fn),
    off: (name: string) => listeners.delete(name),
  };
  const w = {
    localStorage: { getItem: (key: string) => (key === "last-wid-md" ? owner + "@c.us" : null) },
    require: () => {
      requires++;
      return { Msg: messages, Contact: { get: () => ({ name: "客户甲" }) } };
    },
  };
  const s = sandbox(w, { querySelector: (q: string) => (q === "#pane-side" && ready ? {} : null) });
  const msg = (
    id: string,
    fromMe = false,
    body = "你好",
    server = "c.us",
    customer = "447700900001",
  ) => ({
    id: { id, fromMe, remote: { user: customer, server } },
    t: seconds,
    ...(fromMe
      ? { from: { user: owner, server: "c.us" } }
      : { to: { user: owner, server: "c.us" } }),
    body,
    type: "chat",
  });
  return {
    ...s,
    models,
    listeners,
    msg,
    owner: (value: string) => (owner = value),
    ready: (value: boolean) => (ready = value),
    requires: () => requires,
  };
}

test("archive does not initialize WhatsApp before live owner and initialized conversation state agree", () => {
  const f = waFixture();
  f.ready(false);
  assert.equal(f.read("whatsapp").ready, false);
  assert.equal(f.requires(), 0);
  f.ready(true);
  assert.equal(f.read("whatsapp", [], "8613900000000").ready, false);
  assert.equal(f.requires(), 0);
  assert.equal(f.read("whatsapp").ready, true);
  assert.equal(f.requires(), 1);
});
test("WhatsApp archives cached history and incoming/outgoing text, never groups or service records", () => {
  const f = waFixture();
  f.models.push(
    f.msg("old-in"),
    f.msg("old-out", true, "回复"),
    f.msg("group", false, "group secret", "g.us"),
    { ...f.msg("system"), type: "notification_template" },
  );
  let result = f.read("whatsapp");
  assert.equal(result.historyScope, "loaded_only");
  assert.equal(result.messages.length, 2);
  assert.deepEqual([...result.messages.map((m: any) => m.direction)], ["in", "out"]);
  assert(result.messages.every((m: any) => m.name === "客户甲" && m.customer === "447700900001"));
  const ids = result.messages.map((m: any) => m.id);
  assert(ids[0].includes(":in:old-in"));
  assert.equal(f.read("whatsapp", ids).messages.length, 0);
  f.listeners.get("add")!(f.msg("live"));
  result = f.read("whatsapp");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].body, "你好");
  // Duplicate source IDs from separate conversations/directions must not collide.
  f.listeners.get("add")!(f.msg("live", true));
  f.listeners.get("add")!(f.msg("live", false, "other", "c.us", "447700900002"));
  assert.equal(f.read("whatsapp").messages.length, 3);
});
test("WhatsApp LID aliases are not mistaken for a different phone owner", () => {
  const f = waFixture();
  f.models.push(
    {
      ...f.msg("lid-self", true, "LID text", "lid", "123456789012345678"),
      from: { user: "999999999999999", server: "lid" },
    },
    { ...f.msg("foreign-self", true, "FOREIGN"), from: { user: "8613900000000", server: "c.us" } },
  );
  const r = f.read("whatsapp");
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].customer, "lid:123456789012345678");
  assert.equal(r.messages[0].body, "LID text");
});
test("owner switching isolates pending messages and stale callbacks; dispose unsubscribes and clears bodies", () => {
  const f = waFixture();
  f.models.push(f.msg("old-cache", false, "OLD CACHED SECRET"));
  f.read("whatsapp");
  const old = f.listeners.get("add")!;
  old(f.msg("private-old", false, "OLD SECRET"));
  f.owner("8613900000000");
  old(f.msg("between-owners", false, "MUST NOT LEAK"));
  let r = f.read("whatsapp", [], "8613900000000");
  assert.equal(r.messages.length, 0);
  assert.equal(r.owner, "8613900000000");
  old(f.msg("stale-callback", false, "OLD CALLBACK"));
  assert.equal(f.read("whatsapp", [], "8613900000000").messages.length, 0);
  f.listeners.get("add")!(f.msg("new", false, "NEW CONTENT"));
  r = f.read("whatsapp", [], "8613900000000");
  assert.equal(r.messages.length, 1);
  assert(!JSON.stringify(r).includes("OLD"));
  f.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.state(), undefined);
});
test("archive bounds long Unicode bodies, invalid dates, queue size and output payload without claiming full history", () => {
  const f = waFixture();
  f.read("whatsapp");
  const add = f.listeners.get("add")!;
  add({ ...f.msg("invalid"), t: 0 });
  add({ ...f.msg("future"), t: Date.now() / 1000 + 9999 });
  add(f.msg("long", false, "密".repeat(9000)));
  let r = f.read("whatsapp");
  assert.equal(r.messages.length, 1);
  assert.equal([...r.messages[0].body].length, 8000);
  assert.equal(r.messages[0].truncated, true);
  for (let i = 0; i < 5100; i++) add(f.msg("bounded-" + i, false, "密".repeat(8000)));
  r = f.read("whatsapp");
  assert(r.messages.length <= 100);
  assert(Buffer.byteLength(JSON.stringify(r), "utf8") < 1_000_000);
  assert.equal(r.limited, true);
  assert(f.state().pending.size <= 5000);
});
test("media emits explicit placeholders/captions only and never reads media loaders", () => {
  const f = waFixture();
  const media = {
    ...f.msg("image"),
    type: "image",
    body: undefined,
    caption: "商品图片",
    downloadMedia: () => assert.fail("media fetch"),
  };
  f.models.push(media, { ...f.msg("audio"), type: "ptt", body: undefined });
  const r = f.read("whatsapp");
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].kind, "image");
  assert.equal(r.messages[0].body, "商品图片");
  assert.equal(r.messages[1].body, "");
  assert.equal(r.messages[1].kind, "audio");
});
test("LINE loaded cache and subscriptions include both directions, excluding groups, drafts and system strings", () => {
  const owner = "u" + "a".repeat(32),
    peer = "u" + "b".repeat(32);
  let listener = () => {};
  const data: any = {
    auth: { loginState: "logged_in", profile: { mid: owner } },
    message: { entities: { messages: {} } },
    contact: { entities: { contacts: { [peer]: { displayName: "LINE 客户" } } } },
  };
  const msg = (id: string, from = peer, to = owner) => ({
    id,
    from,
    to,
    toType: 0,
    contentType: 0,
    text: "LINE 内容",
    createdTime: seconds * 1000,
  });
  data.message.entities.messages = {
    in: msg("100"),
    out: msg("101", owner, peer),
    group: { ...msg("102"), toType: 2 },
    draft: msg("local-123"),
    system: { ...msg("103"), contentMetadata: { LOC_KEY: "SYS" } },
  };
  const store = {
    getState: () => data,
    subscribe: (f: () => void) => {
      listener = f;
      return () => (listener = () => {});
    },
  };
  const s = sandbox(
    {},
    { getElementById: () => ({ __reactContainer$test: { memoizedProps: { value: { store } } } }) },
  );
  let r = s.read("line");
  assert.equal(r.messages.length, 2);
  assert(r.messages.every((m: any) => m.customer === peer && m.name === "LINE 客户"));
  s.read(
    "line",
    r.messages.map((m: any) => m.id),
  );
  data.message.entities.messages.live = msg("104");
  listener();
  assert.equal(s.read("line").messages.length, 1);
  data.auth.loginState = "logged_out";
  listener();
  r = s.read("line");
  assert.equal(r.owner, "");
  assert.equal(r.messages.length, 0);
  s.dispose();
  assert.equal(s.state(), undefined);
});
test("Telegram captures events and only resolves historical IDs already rendered/downloaded", async () => {
  const listeners = new Map<string, Function>(),
    lookups: any[] = [];
  const incoming = {
    _: "message",
    id: 12,
    peer_id: { user_id: 55555 },
    pFlags: {},
    date: seconds,
    message: "TG 历史",
  };
  const outgoing = { ...incoming, id: 13, pFlags: { out: true }, message: "TG 回复" };
  const root: any = {
    myId: 12345,
    addEventListener: (n: string, f: Function) => listeners.set(n, f),
    removeEventListener: (n: string) => listeners.delete(n),
    managers: {
      appMessagesManager: {
        getMessageByPeer: (peer: number, id: number) => {
          lookups.push([peer, id]);
          return id === 12 ? incoming : outgoing;
        },
      },
    },
  };
  const s = sandbox(
    { rootScope: root },
    {
      querySelector: () => null,
      querySelectorAll: () => [{ dataset: { peerId: "55555", mid: "12" } }],
    },
  );
  assert.equal(s.read("telegram").messages.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  let r = s.read("telegram");
  assert.equal(r.messages.length, 1);
  assert.deepEqual(lookups, [[55555, 12]]);
  listeners.get("history_append")!({ message: outgoing });
  listeners.get("history_update")!({
    ...incoming,
    id: 14,
    peer_id: { chat_id: 999 },
    message: "GROUP",
  });
  listeners.get("history_multiappend")!({ ...incoming, _: "messageService", id: 15 });
  r = s.read("telegram");
  assert.equal(r.messages.length, 2);
  assert(r.messages.some((m: any) => m.direction === "out" && m.body === "TG 回复"));
  const old = listeners.get("history_append")!;
  root.myId = 88888;
  old({ ...incoming, id: 16, message: "WRONG OWNER" });
  r = s.read("telegram");
  assert.equal(r.messages.length, 0);
  assert.equal(r.owner, "88888");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    s.read("telegram").messages.length,
    0,
    "Old cached history must not be relabeled under the new owner",
  );
  s.dispose();
  assert.equal(listeners.size, 0);
});
