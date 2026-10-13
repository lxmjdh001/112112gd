import type { PlatformAdapter, PlatformState } from "../core/index.ts";

export const telegram: PlatformAdapter = {
  id: "telegram",
  name: "Telegram",
  homeURL: "https://web.telegram.org/k/",
  allowedOrigins: ["https://web.telegram.org"],
  preload: "telegram-preload.cjs",
  capabilities: {
    nativeChat: true,
    selectionTranslation: true,
    accountIdentity: true,
    messageArchive: false,
  },
};

// A D1 slot has one owner and one proxy allocation. Web K's own multi-account
// switch navigates to ?account=2; additional owners must use separate D1 slots.
export function isTelegramAccountURL(address: string): boolean {
  try {
    const url = new URL(address);
    return (
      url.origin === "https://web.telegram.org" &&
      /^\/k\/?$/.test(url.pathname) &&
      url.searchParams.getAll("account").every((value) => value === "1")
    );
  } catch {
    return false;
  }
}

// Web K selects an owner from the URL, not the legacy current_account storage
// key (shared with Web A). Never use conversation peers or stale account keys.
export function currentTelegramAccount(
  storage: Pick<Storage, "getItem">,
  address = telegram.homeURL,
): string | null {
  try {
    if (!isTelegramAccountURL(address)) return null;
    const raw = storage.getItem("account1");
    let id: unknown;
    if (raw !== null) {
      if (raw.length > 100_000) return null;
      id = JSON.parse(raw)?.userId;
    } else {
      const legacy = storage.getItem("user_auth");
      if (!legacy || legacy.length > 1000) return null;
      id = JSON.parse(legacy)?.id;
    }
    if (typeof id === "number" && !Number.isSafeInteger(id)) return null;
    return /^(?:[1-9][0-9]{0,15})$/.test(String(id)) ? String(id) : null;
  } catch {
    return null;
  }
}

export function observeTelegram(
  doc: Pick<Document, "querySelector" | "readyState">,
  online: boolean,
): PlatformState {
  if (!online) return "network_error";
  // Web K can leave #page-chats mounted behind its passcode overlay. Keep the
  // unlock page visible; no owner is ready until the app finishes unlocking.
  if (doc.querySelector(".passcode-lock-screen")?.getClientRects().length) return "loading";
  if (doc.querySelector("#auth-pages")?.getClientRects().length) return "qr_required";
  if (doc.querySelector("#page-chats")?.getClientRects().length) return "ready";
  return doc.readyState === "complete" ? "unknown" : "loading";
}
