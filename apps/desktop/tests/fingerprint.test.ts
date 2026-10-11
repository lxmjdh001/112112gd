import { test } from "node:test";
import assert from "node:assert/strict";
import {
  randomFingerprint,
  validateFingerprint,
  userAgentFor,
  type Fingerprint,
} from "../src/shared/fingerprint.ts";
const base: Fingerprint = {
  version: 1,
  seed: "0".repeat(32),
  os: "windows",
  userAgent: userAgentFor("windows", "144.0.0.0"),
  gpuVendor: "",
  gpuRenderer: "",
  screenWidth: 1920,
  screenHeight: 1080,
  timezone: "Asia/Shanghai",
  language: "zh-CN",
  hardwareConcurrency: 8,
  deviceMemory: 8,
  webrtc: "proxy",
  canvasNoise: false,
  audioNoise: false,
  webglNoise: false,
  blockLocalFonts: false,
};
test("random fingerprints are valid, unique and keep chosen region preferences", () => {
  const seeds = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const next = randomFingerprint(base);
    assert.deepEqual(validateFingerprint(next), next);
    assert.equal(next.timezone, base.timezone);
    assert.equal(next.language, base.language);
    seeds.add(next.seed);
  }
  assert.equal(seeds.size, 64);
  assert.equal(validateFingerprint(null), null);
  assert.equal(base.canvasNoise, false);
});
test("invalid and contradictory fingerprints cannot reach a page", () => {
  for (const bad of [
    { userAgent: base.userAgent + "\r\nBad: x" },
    { os: "macos" },
    { timezone: "bad/zone" },
    { language: "en\nBad" },
    { gpuVendor: "Intel" },
    { hardwareConcurrency: 0 },
    { screenWidth: 200 },
    { deviceMemory: 64 },
    { seed: "bad" },
    { canvasNoise: "true" },
  ])
    assert.throws(() => validateFingerprint({ ...base, ...bad }));
  assert.deepEqual(validateFingerprint({ ...base, untrusted: "discard" }), base);
});
