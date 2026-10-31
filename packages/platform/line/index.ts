import type { PlatformAdapter } from "../core/index.ts";
export const LINE_EXTENSION_ID = "ophjlpahpchlmihnnnihgmmeilfjmjjc";
export const LINE_ORIGIN = `chrome-extension://${LINE_EXTENSION_ID}`;
export const line: PlatformAdapter = {
  id: "line",
  name: "LINE",
  homeURL: `${LINE_ORIGIN}/index.html`,
  allowedOrigins: [LINE_ORIGIN],
  preload: "line-preload.cjs",
  capabilities: {
    nativeChat: true,
    selectionTranslation: true,
    accountIdentity: true,
    messageArchive: false,
  },
};

// This function runs in the official React application's main world. It only
// returns the signed-in profile MID and optional own portrait address, never
// contacts, credentials or message data.
export function readLineOwner(): { status: string; identifier: string | null; avatarURL?: string } {
  const root = document.getElementById("root") as (HTMLElement & Record<string, any>) | null;
  const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  const fiber = key && root![key];
  const queue = [fiber?.stateNode?.current || fiber];
  const visited = new Set();
  for (let count = 0; queue.length && count < 500; count++) {
    const node = queue.shift();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    const store = node.memoizedProps?.value?.store;
    if (store && typeof store.getState === "function") {
      const auth = store.getState()?.auth;
      if (auth?.loginState === "logged_in") {
        const mid = auth.profile?.mid;
        return {
          ...(typeof auth.profile?.pictureUrl === "string"
            ? { avatarURL: auth.profile.pictureUrl }
            : {}),
          status: "ready",
          identifier: typeof mid === "string" && /^u[0-9a-f]{32}$/.test(mid) ? mid : null,
        };
      }
      if (auth?.loginState === "logged_out") return { status: "qr_required", identifier: null };
      if (auth?.loginState === "log_in_progressing") return { status: "loading", identifier: null };
    }
    queue.push(node.child, node.sibling);
  }
  // Unknown DOM must never sign a user out or assign somebody else's identity.
  return {
    status: document.querySelector('[class*="loginPage-module__page_login"]:not(.is_loading)')
      ? "qr_required"
      : "unknown",
    identifier: null,
  };
}
