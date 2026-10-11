import type { WebContents } from "electron";
import { platformNames, type Fingerprint } from "../shared/fingerprint.ts";
import { installFingerprintPage } from "./fingerprint-page.ts";

export class FingerprintError extends Error {}
export async function applyFingerprint(
  wc: WebContents,
  p: Fingerprint,
  origins: readonly string[],
  lost: () => void,
) {
  let intentional = false;
  const detached = () => {
    if (!intentional && !wc.isDestroyed()) lost();
  };
  const cleanup = () => {
    intentional = true;
    wc.debugger.removeListener("detach", detached);
    if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
  };
  try {
    // Establish a document before CDP commands; this blank page contains no site code.
    await wc.loadURL("about:blank");
    wc.debugger.attach("1.3");
    wc.debugger.on("detach", detached);
    const send = (method: string, params: object = {}) => wc.debugger.sendCommand(method, params);
    const version = p.userAgent.match(/Chrome\/([\d.]+)/)![1];
    const major = version.split(".")[0];
    const system = { windows: "Windows", macos: "macOS", linux: "Linux" }[p.os];
    const language = [...new Set([p.language, p.language.split("-")[0]])].join(",");
    await send("Emulation.setUserAgentOverride", {
      userAgent: p.userAgent,
      acceptLanguage: language,
      platform: platformNames[p.os],
      userAgentMetadata: {
        brands: [
          { brand: "Chromium", version: major },
          { brand: "Google Chrome", version: major },
        ],
        fullVersionList: [
          { brand: "Chromium", version },
          { brand: "Google Chrome", version },
        ],
        platform: system,
        platformVersion: p.os === "windows" ? "10.0.0" : p.os === "macos" ? "10.15.7" : "",
        architecture: "x86",
        bitness: "64",
        model: "",
        mobile: false,
        wow64: false,
      },
    });
    await send("Emulation.setTimezoneOverride", { timezoneId: p.timezone });
    await send("Emulation.setLocaleOverride", { locale: p.language });
    await send("Emulation.setHardwareConcurrencyOverride", {
      hardwareConcurrency: p.hardwareConcurrency,
    });
    // Preserve D1's view dimensions and zoom; only the reported screen is changed.
    await send("Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: 0,
      mobile: false,
      screenWidth: p.screenWidth,
      screenHeight: p.screenHeight,
    });
    if (p.blockLocalFonts) {
      await send("DOM.enable");
      await send("CSS.enable");
      await send("CSS.setLocalFontsEnabled", { enabled: false });
    }
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${installFingerprintPage.toString()})(${JSON.stringify(p)},${JSON.stringify(origins)})`,
    });
    return cleanup;
  } catch {
    cleanup();
    throw new FingerprintError("指纹配置应用失败，请检查配置后重新打开账号");
  }
}
