import { ipcRenderer } from "electron";

// Never inspect the selected conversation's avatar. Only explicit self controls
// or a Telegram avatar marked with the authenticated owner's peer ID qualify.
export function selfAvatarElement(
  doc: Pick<Document, "querySelectorAll">,
  platform: string,
  owner: string,
): HTMLImageElement | HTMLCanvasElement | null {
  const selectors =
    platform === "whatsapp"
      ? '[data-testid="menu-bar-profile"] img, #side > header img, [data-testid="chat-list-header"] img, button[aria-label="Profile"] img, button[aria-label="个人资料"] img, [role="button"][aria-label="Profile"] img, [role="button"][aria-label="个人资料"] img'
      : platform === "telegram" && /^[1-9][0-9]{0,15}$/.test(owner)
        ? `.avatar[data-peer-id="${owner}"] img, .avatar[data-peer-id="${owner}"] canvas, .Avatar[data-peer-id="${owner}"] img, .Avatar[data-peer-id="${owner}"] canvas`
        : "";
  if (!selectors) return null;
  for (const element of doc.querySelectorAll<HTMLImageElement | HTMLCanvasElement>(selectors)) {
    if (
      platform !== "whatsapp" ||
      !element.closest(
        '#main,[data-testid="conversation-header"],[data-testid="conversation-panel-wrapper"],[role="dialog"]',
      )
    )
      return element;
  }
  return null;
}
let pending = false,
  revision = 0,
  last = "";
export function resetSelfAvatar() {
  revision++;
  last = "";
}
export async function reportSelfAvatar(platform: string, owner: string, ownerURL?: string) {
  if (pending) return;
  pending = true;
  const generation = revision;
  try {
    const element = selfAvatarElement(document, platform, owner);
    let source: CanvasImageSource | null = null;
    if (element instanceof HTMLCanvasElement) source = element;
    else {
      const address =
        element instanceof HTMLImageElement
          ? element.currentSrc || element.src
          : platform === "line"
            ? ownerURL
            : undefined;
      if (!address) return;
      const url = new URL(address, location.href);
      const allowed =
        (url.protocol === "blob:" && url.origin === location.origin) ||
        (url.protocol === "https:" &&
          (url.origin === location.origin ||
            /(^|\.)(whatsapp\.net|whatsapp\.com|telegram\.org|line-scdn\.net|line\.naver\.jp)$/.test(
              url.hostname,
            )));
      if (!allowed) return;
      const response = await fetch(url.href, {
        signal: AbortSignal.timeout(5000),
        credentials: "same-origin",
      });
      if (!response.ok || Number(response.headers.get("content-length") || 0) > 2_000_000) return;
      const reader = response.body?.getReader();
      if (!reader) return;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) {
            await reader.cancel();
            return;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const blob = new Blob(chunks as BlobPart[]);
      source = await createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64 });
    }
    if (!source) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(source, 0, 0, 64, 64);
      const data = canvas.toDataURL("image/png");
      if (generation !== revision || data.length > 24000) return;
      const key = owner + ":" + data;
      if (key !== last) {
        last = key;
        ipcRenderer.send("platform:self-avatar", owner, data);
      }
    } finally {
      if (source instanceof ImageBitmap) source.close();
    }
  } catch {
    /* Missing/private photos keep the initials; never change login state. */
  } finally {
    pending = false;
  }
}
