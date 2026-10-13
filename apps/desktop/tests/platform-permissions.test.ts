import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session, WebContents } from "electron";
import { installPlatformPermissions } from "../src/main/platform-permissions.ts";

type RequestHandler = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
type CheckHandler = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
const whatsapp = "https://web.whatsapp.com";

function fixture(origins: string[] = [whatsapp], address = whatsapp + "/") {
  let request: RequestHandler;
  let check: CheckHandler;
  const ses = {
    setPermissionRequestHandler(handler: RequestHandler) { request = handler; },
    setPermissionCheckHandler(handler: CheckHandler) { check = handler; },
  } as unknown as Session;
  const contents = {
    session: ses,
    isDestroyed: () => false,
    getURL: () => address,
  } as unknown as WebContents;
  installPlatformPermissions(ses, origins);
  return {
    contents,
    ses,
    request(
      permission: Parameters<RequestHandler>[1] = "persistent-storage",
      details: Parameters<RequestHandler>[3] = { isMainFrame: true, requestingUrl: address },
      wc: WebContents = contents,
    ) {
      const decisions: boolean[] = [];
      request(wc, permission, (decision) => decisions.push(decision), details);
      assert.equal(decisions.length, 1, "each permission request must settle exactly once");
      return decisions[0];
    },
    check(
      permission: Parameters<CheckHandler>[1] = "persistent-storage",
      origin: string = address,
      details: Parameters<CheckHandler>[3] = { isMainFrame: true, requestingUrl: address },
      wc: WebContents | null = contents,
    ) {
      return check(wc, permission, origin, details);
    },
  };
}

test("persistent storage is granted only to the live platform's own main frame", () => {
  for (const origin of [whatsapp, "https://web.telegram.org", "chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc"]) {
    const f = fixture([origin], origin + "/k/?fixture=1");
    assert.equal(f.request(), true);
    assert.equal(f.check(), true);
    assert.equal(f.check("persistent-storage", origin), true);
  }
  const configured = [whatsapp];
  const f = fixture(configured, "https://other.example/");
  configured.push("https://other.example");
  assert.equal(f.request(), false, "later caller mutations cannot broaden permission scope");
  assert.equal(f.check(), false);
});

test("unrelated permissions stay denied for trusted pages", () => {
  const f = fixture();
  for (const permission of ["media", "notifications", "geolocation", "clipboard-read", "clipboard-sanitized-write", "storage-access", "top-level-storage-access", "fileSystem", "openExternal", "unknown"] as const) {
    assert.equal(f.request(permission), false, permission);
    assert.equal(f.check(permission), false, permission);
  }
});

test("subframes, unknown frames and requesting-origin mismatches cannot inherit a grant", () => {
  const f = fixture();
  for (const address of ["https://web.whatsapp.com.evil.example/", "https://web.whatsapp.com:8443/", "https://web.whatsapp.com@evil.example/", "https://user:password@web.whatsapp.com/", "http://web.whatsapp.com/", "https://web.telegram.org/", "blob:https://web.whatsapp.com/fixture", "file:///fixture", "null", ""]) {
    const details = { isMainFrame: true, requestingUrl: address };
    assert.equal(f.request("persistent-storage", details), false, address);
    assert.equal(f.check("persistent-storage", address), false, address);
    assert.equal(f.check("persistent-storage", whatsapp, details), false, address);
  }
  for (const isMainFrame of [false, undefined]) {
    const details = { isMainFrame, requestingUrl: whatsapp + "/" };
    assert.equal(f.request("persistent-storage", details as Parameters<RequestHandler>[3]), false);
    assert.equal(f.check("persistent-storage", whatsapp, details as Parameters<CheckHandler>[3]), false);
  }
  assert.equal(f.check("persistent-storage", whatsapp, { isMainFrame: true }), false,
    "checks with no document URL (such as service workers) must not be granted implicitly");
});

test("closed, foreign-session and navigated WebContents cannot receive a storage grant", () => {
  const f = fixture();
  const details = { isMainFrame: true, requestingUrl: whatsapp + "/" };
  assert.equal(f.check("persistent-storage", whatsapp, details, null), false);
  for (const wc of [
    { ...f.contents, session: {} },
    { ...f.contents, isDestroyed: () => true },
    { ...f.contents, getURL: () => "https://other.example/" },
    { ...f.contents, getURL: () => "about:blank" },
    { ...f.contents, getURL: () => { throw Error("Object has been destroyed"); } },
  ]) {
    assert.equal(f.request("persistent-storage", details, wc as WebContents), false);
    assert.equal(f.check("persistent-storage", whatsapp, details, wc as WebContents), false);
  }
});
