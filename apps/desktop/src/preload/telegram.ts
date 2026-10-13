import { installNativeChat } from "./native-chat.ts";
import { installInboundStats } from "./inbound-stats.ts";
import { contextBridge, ipcRenderer } from "electron";
import { liveTelegramAccount } from "../../../../packages/platform/telegram/self.ts";
import {
  currentTelegramAccount,
  observeTelegram,
} from "../../../../packages/platform/telegram/index.ts";
import { installNativeTranslation } from "./native-translation.ts";
window.addEventListener("DOMContentLoaded", () => {
  if (location.origin !== "https://web.telegram.org") return;
  installNativeTranslation();
  installNativeChat("telegram");
  installInboundStats("telegram");
  function report() {
    const status = observeTelegram(document, navigator.onLine);
    let owner: string | null = null;
    if (status === "ready") {
      try {
        const live = contextBridge.executeInMainWorld({ func: liveTelegramAccount });
        // A present but uninitialized live owner must not fall back to an old
        // account in localStorage during login, logout or passcode unlock.
        owner = live === undefined ? currentTelegramAccount(localStorage, location.href) : live;
      } catch {
        /* A failed main-world observation is not an authenticated owner. */
      }
    }
    ipcRenderer.send("platform:status", status, owner);
  }
  report();
  setInterval(report, 5000);
  window.addEventListener("online", report);
  window.addEventListener("offline", report);
});
