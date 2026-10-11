import { test } from "node:test";
import assert from "node:assert/strict";
import { currentWhatsAppAccount } from "../../../packages/platform/whatsapp/self.ts";

test("billing reads the session owner's phone, never the chat peer or LID", () => {
  const storage = (items: Record<string, string>) => ({
    getItem: (key: string) => items[key] ?? null,
  });
  assert.equal(
    currentWhatsAppAccount(storage({ "last-wid-md": '"15550000001:7@c.us"' })),
    "15550000001",
  );
  assert.equal(
    currentWhatsAppAccount(storage({ "last-wid": "15550000002@s.whatsapp.net" })),
    "15550000002",
  );
  assert.equal(
    currentWhatsAppAccount(
      storage({ "last-wid-md": "15550000001@c.us", "last-wid": "15550000002@c.us" }),
    ),
    "15550000001",
  );
  assert.equal(
    currentWhatsAppAccount(
      storage({ "last-wid-md": "123456789@lid", "last-wid": "15550000001@c.us" }),
    ),
    null,
  );
  for (const value of [
    "12345678901@lid",
    "01234567890@c.us",
    "15550000001",
    "wrong",
    '"bad-json',
    "1".repeat(101),
  ]) {
    assert.equal(currentWhatsAppAccount(storage({ "last-wid-md": value })), null);
  }
  assert.equal(currentWhatsAppAccount(storage({ "chat-peer": "15550000003@c.us" })), null);
  assert.equal(
    currentWhatsAppAccount({
      getItem() {
        throw new Error("storage unavailable");
      },
    }),
    null,
  );
});
