import { contextBridge, ipcRenderer } from "electron";
import { currentWhatsAppAccount } from "../../../../packages/platform/whatsapp/self.ts";

import { collectInbound } from "../../../../packages/platform/core/inbound-stats.ts";
export function installInboundStats(platform: string) {
  let busy = false;
  let ack: string[] = [];
  async function sync() {
    if (busy) return;
    busy = true;
    try {
      const batch = contextBridge.executeInMainWorld({
        func: collectInbound,
        args: [
          platform,
          ack,
          platform === "whatsapp" ? currentWhatsAppAccount(localStorage) || "" : "",
        ],
      });
      ack = [];
      if (!batch.owner) return;
      await ipcRenderer.invoke("platform:inbound-events", batch);
      ack = batch.events.map((event: { id: string }) => event.id);
    } catch {
      /* The main process retains encrypted pending events; retry on the next tick. */
    } finally {
      busy = false;
    }
  }
  void sync();
  setInterval(() => void sync(), 5000);
}
