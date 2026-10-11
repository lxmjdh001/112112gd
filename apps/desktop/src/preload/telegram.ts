import { ipcRenderer } from "electron";
import {
  currentTelegramAccount,
  observeTelegram,
} from "../../../../packages/platform/telegram/index.ts";
import { installNativeTranslation } from "./native-translation.ts";
window.addEventListener("DOMContentLoaded", () => {
  if (location.origin !== "https://web.telegram.org") return;
  installNativeTranslation();
  function report() {
    const status = observeTelegram(document, navigator.onLine);
    ipcRenderer.send(
      "platform:status",
      status,
      status === "ready" ? currentTelegramAccount(localStorage, location.href) : null,
    );
  }
  report();
  setInterval(report, 5000);
  window.addEventListener("online", report);
  window.addEventListener("offline", report);
});
