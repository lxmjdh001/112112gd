import { contextBridge, ipcRenderer } from "electron";
import { LINE_ORIGIN, readLineOwner } from "../../../../packages/platform/line/index.ts";
import { installNativeTranslation } from "./native-translation.ts";

if (location.href.startsWith(LINE_ORIGIN + "/") && window.top === window) {
  contextBridge.exposeInMainWorld("D1LineHost", {
    removeLoginCookie: () => ipcRenderer.invoke("line:remove-login-cookie"),
  });
  // Electron supplies runtime, i18n, storage and sandboxing. Scope the small
  // Chrome window compatibility layer to this account; expose no Node API.
  contextBridge.executeInMainWorld({
    func: () => {
      const api = (globalThis as any).chrome;
      const event = () => ({
        addListener() {},
        removeListener() {},
        hasListener() {
          return false;
        },
      });
      const result = (value: unknown, callback?: unknown) =>
        typeof callback === "function" ? (callback(value), undefined) : Promise.resolve(value);
      api.cookies = { remove: () => (window as any).D1LineHost.removeLoginCookie() };
      api.windows = {
        getCurrent: (options: unknown, callback: unknown) =>
          result(
            {
              id: 1,
              focused: document.hasFocus(),
              left: 0,
              top: 0,
              width: innerWidth,
              height: innerHeight,
            },
            typeof options === "function" ? options : callback,
          ),
        getAll: (options: unknown, callback: unknown) =>
          result([{ id: 1 }], typeof options === "function" ? options : callback),
        update: (id: number, options: { focused?: boolean }, callback: unknown) => {
          if (options?.focused) window.focus();
          return result({ id }, callback);
        },
      };
      api.tabs.getZoom = (id: unknown, callback: unknown) =>
        result(1, typeof id === "function" ? id : callback);
      api.extension.getViews = () => [window];
      api.action.setBadgeText = (_details: unknown, callback: unknown) =>
        result(undefined, callback);
      // System notifications are not enabled for embedded accounts.
      api.notifications = {
        onClicked: event(),
        onClosed: event(),
        create: (...args: unknown[]) => result("", args.at(-1)),
        clear: (_id: string, callback: unknown) => result(false, callback),
      };
    },
  });
  window.addEventListener("DOMContentLoaded", () => {
    installNativeTranslation();
    function report() {
      try {
        const owner = contextBridge.executeInMainWorld({ func: readLineOwner });
        ipcRenderer.send(
          "platform:status",
          navigator.onLine ? owner.status : "network_error",
          owner.identifier,
        );
      } catch {
        ipcRenderer.send("platform:status", "unknown", null);
      }
    }
    report();
    setInterval(report, 5000);
    window.addEventListener("online", report);
    window.addEventListener("offline", report);
  });
}
