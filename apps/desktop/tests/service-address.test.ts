import assert from "node:assert/strict";
import test from "node:test";
import { serviceAddress } from "../src/main/service-address.ts";

test("uses a configured server origin; only local development may use HTTP", () => {
  assert.equal(serviceAddress("https://admin.example.com/"), "https://admin.example.com");
  assert.equal(serviceAddress("http://127.0.0.1:18080"), "http://127.0.0.1:18080");
  for (const value of [
    "http://example.com",
    "file:///tmp/app",
    "https://user:pass@example.com",
    "https://example.com/api",
    "https://example.com/?token=secret",
    "https://example.com/#login",
    "bad",
  ]) {
    assert.throws(() => serviceAddress(value));
  }
});
