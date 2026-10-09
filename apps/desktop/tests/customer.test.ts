import { test } from "node:test";
import assert from "node:assert/strict";
import { customerFromMessageIds } from "../../../packages/platform/whatsapp/customer.ts";
test("native peer IDs identify direct chats without guessing from names or group participants", () => {
  assert.equal(
    customerFromMessageIds([
      "true_447410419512@s.whatsapp.net_MSG",
      "false_447410419512@c.us_REPLY",
    ]),
    "447410419512",
  );
  assert.equal(customerFromMessageIds(["false_47846556438532@lid_MSG"]), "47846556438532@lid");
  assert.equal(
    customerFromMessageIds([
      "false_447410419512@s.whatsapp.net_MSG",
      "false_47846556438532@lid_MSG",
    ]),
    null,
  );
  assert.equal(customerFromMessageIds(["false_123456@g.us_MSG_447410419512@s.whatsapp.net"]), null);
  assert.equal(customerFromMessageIds(["false_status@broadcast_MSG"]), null);
  assert.equal(customerFromMessageIds(["447410419512", "Zzzzz", "false_unknown@new_MSG"]), null);
  assert.equal(customerFromMessageIds([]), null);
});
