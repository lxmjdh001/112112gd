import { contextBridge, ipcRenderer } from "electron";
import type { ShellAPI } from "../shared/types.ts";
const api: ShellAPI = {
  setSidebarCollapsed: (collapsed) => ipcRenderer.invoke("shell:sidebar-collapsed", collapsed),
  toolsModal: (open) => ipcRenderer.invoke("shell:tools-modal", open),
  toolsRequest: (method, path, body) =>
    ipcRenderer.invoke("shell:tools-request", method, path, body),
  setToolsCollapsed: (collapsed) => ipcRenderer.invoke("shell:tools-collapsed", collapsed),
  prepareQuick: (context, content) => ipcRenderer.invoke("shell:prepare-quick", context, content),
  customerTranslate: (context, text, language) =>
    ipcRenderer.invoke("shell:customer-translate", context, text, language),
  customerLanguage: (context, language) =>
    ipcRenderer.invoke("shell:customer-language", context, language),
  cloudRequest: (numberId, path, body) =>
    ipcRenderer.invoke("shell:cloud-request", numberId, path, body),
  state: () => ipcRenderer.invoke("shell:state"),
  loginPreference: () => ipcRenderer.invoke("shell:login-preference"),
  forgetLoginCode: () => ipcRenderer.invoke("shell:forget-login-code"),
  login: (code, remember) => ipcRenderer.invoke("shell:login", code, remember),
  logout: () => ipcRenderer.invoke("shell:logout"),
  refresh: () => ipcRenderer.invoke("shell:refresh"),
  reload: () => ipcRenderer.invoke("shell:reload"),
  repairAccount: (id, resetLogin) => ipcRenderer.invoke("shell:repair-account", id, resetLogin),
  open: (id) => ipcRenderer.invoke("shell:open", id),
  closeAccount: (id) => ipcRenderer.invoke("shell:close-account", id),
  removeAccount: (id) => ipcRenderer.invoke("shell:remove-account", id),
  accountForm: (open) => ipcRenderer.invoke("shell:account-form", open),
  createAccount: (account) => ipcRenderer.invoke("shell:create-account", account),
  createProxy: (proxy) => ipcRenderer.invoke("shell:create-proxy", proxy),
  onState: (fn) => {
    ipcRenderer.on("shell:state", (_e, state) => fn(state));
  },
};
contextBridge.exposeInMainWorld("gongdan", api);
