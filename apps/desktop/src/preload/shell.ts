import { contextBridge, ipcRenderer } from "electron";
import type { ShellAPI } from "../shared/types.ts";
const api: ShellAPI = {
  state: () => ipcRenderer.invoke("shell:state"),
  login: (code, url) => ipcRenderer.invoke("shell:login", code, url),
  logout: () => ipcRenderer.invoke("shell:logout"),
  refresh: () => ipcRenderer.invoke("shell:refresh"),
  reload: () => ipcRenderer.invoke("shell:reload"),
  open: (id) => ipcRenderer.invoke("shell:open", id),
  onState: (fn) => {
    ipcRenderer.on("shell:state", (_e, state) => fn(state));
  },
};
contextBridge.exposeInMainWorld("gongdan", api);
