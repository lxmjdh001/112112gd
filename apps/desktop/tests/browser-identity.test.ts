import { test } from "node:test";
import assert from "node:assert/strict";
import { chromiumUserAgent } from "../src/main/browser-identity.ts";
test("preserves actual Chromium version and removes scoped application marker", () => {
  assert.equal(
    chromiumUserAgent(
      "Mozilla/5.0 @gongdan/desktop/0.1.0 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36",
      "@gongdan/desktop",
    ),
    "Mozilla/5.0 Chrome/152.0.7977.130 Safari/537.36",
  );
});
