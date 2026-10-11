import { test } from "node:test";
import assert from "node:assert/strict";
import { currentTelegramAccount } from "../../../packages/platform/telegram/index.ts";
import { readLineOwner } from "../../../packages/platform/line/index.ts";
import {
  getPlatform,
  isPlatformURL,
  validAccountIdentity,
} from "../../../packages/platform/registry.ts";

function storage(values: Record<string, string | undefined>) {
  return { getItem: (key: string) => values[key] ?? null };
}
test("Telegram billing follows the slot owner and rejects stale, malformed or unsafe IDs", () => {
  assert.equal(
    currentTelegramAccount(storage({ account1: JSON.stringify({ userId: 12345 }) })),
    "12345",
  );
  assert.equal(
    currentTelegramAccount(
      storage({ current_account: "2", account1: '{"userId":111}', account2: '{"userId":222}' }),
    ),
    "111",
  );
  assert.equal(currentTelegramAccount(storage({ user_auth: '{"id":333}' })), "333");
  for (const values of [
    { account1: "{}", user_auth: '{"id":333}' },
    { account1: "broken", user_auth: '{"id":333}' },
    { account1: '{"userId":-123}' },
    { account1: '{"userId":9007199254740993}' },
    { account1: '{"username":"contact","peerId":333}' },
  ])
    assert.equal(currentTelegramAccount(storage(values)), null);
  for (const address of [
    "https://web.telegram.org/k/?account=2",
    "https://web.telegram.org/a/",
    "https://other.test/k/",
  ])
    assert.equal(currentTelegramAccount(storage({ account1: '{"userId":111}' }), address), null);
});
test("LINE only reads the authenticated owner's profile, never contacts or stale logged-out profiles", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const mid = "u" + "a".repeat(32);
  try {
    for (const [auth, expected] of [
      [
        { loginState: "logged_in", profile: { mid } },
        { status: "ready", identifier: mid },
      ],
      [
        { loginState: "logged_in", profile: { mid: "customer-name" } },
        { status: "ready", identifier: null },
      ],
      [
        { loginState: "logged_out", profile: { mid } },
        { status: "qr_required", identifier: null },
      ],
      [
        { loginState: "log_in_progressing", profile: { mid } },
        { status: "loading", identifier: null },
      ],
    ] as const) {
      const provider = {
        memoizedProps: {
          value: { store: { getState: () => ({ auth, contact: { mid: "u" + "b".repeat(32) } }) } },
        },
      };
      const root = { __reactContainer$test: { stateNode: { current: { child: provider } } } };
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { getElementById: () => root, querySelector: () => null },
      });
      assert.deepEqual(readLineOwner(), expected);
    }
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { getElementById: () => null, querySelector: () => null },
    });
    assert.deepEqual(readLineOwner(), { status: "unknown", identifier: null });
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
test("native IPC origins and billing identity formats stay platform-specific", () => {
  assert.equal(getPlatform("line").capabilities.accountIdentity, true);
  assert.equal(getPlatform("telegram").capabilities.nativeChat, true);
  assert.equal(
    isPlatformURL("line", "chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/index.html"),
    true,
  );
  assert.equal(isPlatformURL("line", "chrome-extension://other/index.html"), false);
  assert.equal(isPlatformURL("line", "file:///index.html"), false);
  assert.equal(isPlatformURL("telegram", "https://web.telegram.org/k/"), true);
  assert.equal(isPlatformURL("telegram", "https://web.telegram.org/k/?account=1#123"), true);
  assert.equal(isPlatformURL("telegram", "https://web.telegram.org/k/?account=2"), false);
  assert.equal(isPlatformURL("telegram", "https://web.telegram.org/a/"), false);
  assert.equal(isPlatformURL("telegram", "https://web.telegram.org.evil.test/k/"), false);
  assert.equal(isPlatformURL("whatsapp", "https://web.telegram.org/k/"), false);
  assert.equal(validAccountIdentity("line", "u" + "a".repeat(32)), true);
  assert.equal(validAccountIdentity("line", "15550000001"), false);
  assert.equal(validAccountIdentity("telegram", "12345"), true);
  assert.equal(validAccountIdentity("telegram", "@somebody"), false);
  assert.equal(validAccountIdentity("whatsapp", "12345"), false);
});
