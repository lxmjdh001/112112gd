import { test } from "node:test";
import assert from "node:assert/strict";
import {
  randomFingerprint,
  compatibleFingerprint,
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
    const next = randomFingerprint(base, "152.0.7977.130");
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

test("browser compatibility bounds apply to manual input, random generation and saved identities", () => {
  for (const version of ["99.0.0.0", "119.0.0.0", "999.0.0.0"])
    assert.throws(
      () =>
        validateFingerprint(
          { ...base, userAgent: userAgentFor(base.os, version) },
          "152.0.7977.130",
        ),
      /浏览器版本/,
    );
  for (const version of ["120.0.0.0", "152.0.7977.130"])
    assert.ok(
      validateFingerprint({ ...base, userAgent: userAgentFor(base.os, version) }, "152.0.7977.130"),
    );
  const stale = { ...base, userAgent: userAgentFor(base.os, "99.0.0.0") };
  const repaired = compatibleFingerprint(stale, "152.0.7977.130")!;
  assert.equal(repaired.userAgent, userAgentFor(base.os, "152.0.7977.130"));
  assert.equal(repaired.seed, stale.seed);
  assert.equal(stale.userAgent, userAgentFor(base.os, "99.0.0.0"));
  assert.equal(
    randomFingerprint(stale, "152.0.7977.130").userAgent.match(/Chrome\/([\d.]+)/)?.[1],
    "152.0.7977.130",
  );
  assert.throws(() =>
    validateFingerprint({ ...base, userAgent: base.userAgent + " Electron/44.7.0" }),
  );
});
