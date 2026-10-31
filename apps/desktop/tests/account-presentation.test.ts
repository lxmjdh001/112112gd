import { test } from "node:test";
import assert from "node:assert/strict";
import { accountPresence } from "../src/shared/account-presence.ts";
import { validAccountAvatar } from "../src/shared/account-avatar.ts";
import { createAccountSidebar } from "../src/renderer/account-sidebar.ts";
import type { Account, ViewState } from "../src/shared/types.ts";
const account: Account = {
  id: "a",
  label: "我的账号",
  platform: "whatsapp",
  proxyHost: "",
  proxyPort: 0,
  available: true,
};
const state: ViewState = {
  loggedIn: true,
  connection: "online",
  label: "本机",
  accounts: [account],
  platforms: [],
  activeId: "a",
  message: "",
  statuses: {},
  apiURL: "http://127.0.0.1",
};
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf8kAAAAASUVORK5CYII=";
test("account presence uses only three states without treating loading or unknown DOM as logged-in", () => {
  for (const [status, kind] of [
    ["ready", "online"],
    ["closed", "offline"],
    ["qr_required", "offline"],
    ["loading", "offline"],
    ["identity_pending", "offline"],
    ["unknown", "error"],
    ["network_error", "error"],
    ["storage_error", "error"],
  ])
    assert.equal(
      accountPresence(account, { ...state, statuses: { a: status } }).kind,
      kind,
      status,
    );
  assert.equal(
    accountPresence({ ...account, paused: true }, { ...state, statuses: { a: "ready" } }).kind,
    "offline",
  );
  assert.equal(
    accountPresence({ ...account, available: false, unavailableReason: "other_device" }, state)
      .kind,
    "offline",
  );
  assert.equal(
    accountPresence({ ...account, available: false, unavailableReason: "proxy_disabled" }, state)
      .kind,
    "error",
  );
  assert.equal(accountPresence({ ...account, connectionType: "cloud" }, state).kind, "online");
  assert.equal(
    accountPresence(
      { ...account, connectionType: "cloud" },
      { ...state, connection: "reconnecting" },
    ).kind,
    "error",
  );
});
test("avatar channel accepts bounded PNGs, rejecting URLs, executable formats, oversized dimensions and payloads", () => {
  assert(validAccountAvatar(png));
  for (const input of [
    "https://example.com/a.png",
    "data:image/svg+xml,<svg/>",
    "data:image/png;base64,AAAA",
    png + "A".repeat(24000),
    null,
    {},
    1,
  ])
    assert(!validAccountAvatar(input));
  const bytes = Buffer.from(png.slice(22), "base64");
  bytes.writeUInt32BE(10000, 16);
  assert(!validAccountAvatar("data:image/png;base64," + bytes.toString("base64")));
});
test("sidebar keeps account name, presents offline/online/error and only embeds raster snapshots", () => {
  const sidebar = createAccountSidebar(
    () => state,
    () => {},
    async (fn) => fn(),
  );
  const markup = sidebar.markup({
    ...state,
    statuses: { a: "ready" },
    accountProfiles: { a: { owner: "8613800000000", avatar: png } },
  });
  assert(markup.includes("account-self-avatar"));
  assert(markup.includes(">在线</span>"));
  assert(!markup.includes("网页已就绪"));
  const qr = sidebar.markup({ ...state, statuses: { a: "qr_required" } });
  assert(qr.includes("<b>我的账号</b>"));
  assert(qr.includes(">离线</span>"));
  assert(qr.includes("等待扫码"));
  const unsafe = sidebar.markup({
    ...state,
    accountProfiles: {
      a: { owner: "8613800000000", avatar: 'data:image/svg+xml,<svg onload="alert(1)"/>' },
    },
  });
  assert(!unsafe.includes("account-self-avatar"));
  assert(!unsafe.includes("onload="));
});

test("admin and client share terminology for API, stale and permission observations", async () => {
  const { observedPresence } = await import("../../../packages/platform/core/presence.ts");
  for (const [raw, label] of [
    ["ready", "在线"],
    ["api_connected", "在线"],
    ["stale", "离线"],
    ["closed", "离线"],
    ["qr_required", "离线"],
    ["api_auth_error", "异常"],
    ["api_disabled", "异常"],
    ["unknown", "异常"],
    ["proxy_disabled", "异常"],
    ["code_deleted", "异常"],
    ["unrecognized", "异常"],
  ]) {
    const result = observedPresence(raw);
    assert.equal(result.label, label);
    assert(!/网页|页面/.test(result.reason));
  }
});
