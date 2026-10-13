import { contextBridge, ipcRenderer } from "electron";
import { readNativeCustomer } from "../../../../packages/platform/core/native-customer.ts";
import { installChatContext } from "./chat-context.ts";
import { installAutomaticTranslation } from "./automatic-translation.ts";
import type { ChatAdapter, ChatMessage } from "./chat-adapter.ts";

export function installNativeChat(platform: "line" | "telegram") {
  const customer = (messages = false) => {
    try {
      return contextBridge.executeInMainWorld({
        func: readNativeCustomer,
        args: [platform, messages],
      });
    } catch {
      return null;
    }
  };
  const visible = (el: HTMLElement) => !!el.getClientRects().length;
  const lineHost = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[class*="chatroomEditor-module__editor_area"] textarea-ex',
      ),
    ].find(visible);
  const editor = (): HTMLElement | null => {
    if (platform === "line")
      return lineHost()?.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea") || null;
    return (
      [
        ...document.querySelectorAll<HTMLElement>(
          '.chat-input [contenteditable="true"][data-peer-id]',
        ),
      ].find(visible) || null
    );
  };
  const room = () =>
    platform === "line"
      ? lineHost()?.closest<HTMLElement>('[class*="chatroom-module__chatroom"]')
      : editor()?.closest<HTMLElement>(".chat");
  const read = (box: HTMLElement) =>
    (box instanceof HTMLTextAreaElement ? box.value : box.innerText).replace(/\u00a0/g, " ").trim();
  const sendButton = () =>
    platform === "telegram"
      ? room()?.querySelector<HTMLElement>(".btn-send") || undefined
      : undefined;
  const adapter: ChatAdapter = {
    name: platform === "line" ? "LINE" : "Telegram",
    customer,
    editor,
    read,
    footer: () =>
      platform === "line"
        ? lineHost()?.parentElement || null
        : editor()?.closest<HTMLElement>(".chat-input") || null,
    sendButton,
    canSend: () => !!editor() && (platform === "line" || !!sendButton()),
    send() {
      if (platform === "telegram") {
        sendButton()?.click();
        return;
      }
      const box = editor();
      if (!box) throw Error("未找到 LINE 输入框");
      const modifier = customer()?.sendMode === "modifier";
      const mac = /Mac/.test(navigator.platform);
      box.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
          composed: true,
          metaKey: modifier && mac,
          altKey: modifier && !mac,
        }),
      );
    },
    isComposerEvent: (event) => {
      const box = editor();
      return !!box && event.composedPath().includes(box);
    },
    isSendKey(event) {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229)
        return false;
      const mode = customer()?.sendMode;
      if (platform === "line") {
        const mac = /Mac/.test(navigator.platform);
        if (mac && event.ctrlKey) return false;
        return mode === "modifier" ? (mac ? event.metaKey : event.altKey) : !event.altKey;
      }
      if (mode === "unknown") return false;
      const mac = /Mac/.test(navigator.platform);
      return mode === "modifier"
        ? (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey
        : !event.ctrlKey && !event.metaKey && !event.altKey;
    },
    messages() {
      const context = customer(platform === "line"),
        container = room();
      if (!context || !container) return [];
      const output: ChatMessage[] = [];
      if (platform === "line") {
        for (const msg of context.messages || []) {
          const textNode = container.querySelector<HTMLElement>(`[data-message-id="${msg.id}"]`);
          if (!textNode) continue;
          output.push({
            ...msg,
            id: `line:${context.identifier}:${msg.id}`,
            row: textNode,
            textNode,
          });
        }
      } else {
        for (const row of [
          ...container.querySelectorAll<HTMLElement>(".bubble[data-mid][data-peer-id]"),
        ].slice(-100)) {
          if (
            row.dataset.peerId !== context.identifier ||
            !/^-?\d{1,20}$/.test(row.dataset.mid || "")
          )
            continue;
          const textNode = row.querySelector<HTMLElement>(".message");
          if (!textNode) continue;
          const copy = textNode.cloneNode(true) as HTMLElement;
          copy
            .querySelectorAll(
              ".time, .reply, .reply-content, .bubble-name, [data-gd7-auto-translation]",
            )
            .forEach((el) => el.remove());
          const text = copy.textContent?.trim() || "";
          if (!text || text.length > 4000) continue;
          output.push({
            id: `telegram:${context.identifier}:${row.dataset.mid}`,
            row,
            textNode,
            text,
            outgoing: row.classList.contains("is-out"),
          });
        }
      }
      return output;
    },
  };
  installChatContext(adapter);
  const automatic = installAutomaticTranslation(
    document,
    {
      translate: (text, target, source) =>
        ipcRenderer.invoke("wa:translate", { text, target, source }),
      loadOriginals: (identifier) => ipcRenderer.invoke("wa:translation-originals", { identifier }),
      saveOriginal: (id, value) => ipcRenderer.invoke("wa:translation-originals", { id, ...value }),
    },
    adapter,
  );
  ipcRenderer.on("wa:customer-language", (_event, payload) =>
    automatic.setLanguage(payload.identifier, payload.language),
  );
  window.addEventListener("pagehide", () => automatic.dispose(), { once: true });
}
