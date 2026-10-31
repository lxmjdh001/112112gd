import { contextBridge, ipcRenderer } from "electron";
import {
  collectChatArchive,
  disposeChatArchive,
} from "../../../../packages/platform/core/chat-archive.ts";
import { currentWhatsAppAccount } from "../../../../packages/platform/whatsapp/self.ts";
export function installChatArchive(platform: string) {
  let busy = false,
    ack: string[] = [],
    generation = 0;
  const dispose = () => {
    generation++;
    ack = [];
    try {
      contextBridge.executeInMainWorld({ func: disposeChatArchive });
    } catch {}
  };
  async function sync() {
    if (busy) return;
    busy = true;
    const version = generation;
    try {
      const policy = await ipcRenderer.invoke("team:archive-policy");
      if (version !== generation) return;
      if (!policy?.enabled) {
        dispose();
        return;
      }
      const batch = contextBridge.executeInMainWorld({
        func: collectChatArchive,
        args: [
          platform,
          ack,
          platform === "whatsapp" ? currentWhatsAppAccount(localStorage) || "" : "",
        ],
      }) as ReturnType<typeof collectChatArchive>;
      ack = [];
      if (version !== generation) return;
      const result = await ipcRenderer.invoke("platform:chat-archive", batch);
      if (version === generation && result?.stored) ack = batch.messages.map((m) => m.id);
    } catch {
      /* Preserve unacknowledged records; the next tick retries safely. */
    } finally {
      busy = false;
    }
  }
  const policy = (_event: unknown, value: { enabled?: boolean }) => {
    if (!value?.enabled) dispose();
    else void sync();
  };
  ipcRenderer.on("team:archive-policy", policy);
  const timer = setInterval(() => void sync(), 5000);
  void sync();
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(timer);
      ipcRenderer.removeListener("team:archive-policy", policy);
      dispose();
    },
    { once: true },
  );
}
