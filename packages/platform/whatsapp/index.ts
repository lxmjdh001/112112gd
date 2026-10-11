import type { PlatformAdapter, PlatformState } from "../core/index.ts";
export const whatsapp: PlatformAdapter = {
  id: "whatsapp",
  name: "WhatsApp",
  homeURL: "https://web.whatsapp.com/",
  allowedOrigins: ["https://web.whatsapp.com"],
  preload: "whatsapp-preload.cjs",
  capabilities: {
    nativeChat: true,
    selectionTranslation: true,
    accountIdentity: true,
    messageArchive: false,
  },
};
// DOM changes can invalidate selectors. Unknown is not logged out and must never
// trigger deletion of a persistent browser profile or an automatic re-login.
export function observeWhatsApp(
  doc: Pick<Document, "querySelector" | "readyState">,
  online: boolean,
): PlatformState {
  if (!online) return "network_error";
  if (doc.querySelector("#pane-side")) return "ready";
  if (doc.querySelector('[data-ref] canvas,canvas[aria-label*="QR"],[data-testid="qrcode"]'))
    return "qr_required";
  return doc.readyState === "complete" ? "unknown" : "loading";
}
