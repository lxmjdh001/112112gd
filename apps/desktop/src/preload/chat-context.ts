import { ipcRenderer } from "electron";
import { currentWhatsAppCustomer } from "../../../../packages/platform/whatsapp/customer.ts";

export function installChatContext() {
  let previous = "";
  const observe = () => {
    const identifier = currentWhatsAppCustomer(document) || "";
    const name = identifier
      ? document.querySelector("#main header [title]")?.getAttribute("title")?.slice(0, 150) ||
        identifier
      : "";
    const key = identifier + "\n" + name;
    if (key !== previous) {
      previous = key;
      ipcRenderer.send("wa:customer-context", { identifier, name });
    }
  };
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      observe();
    }, 100);
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-id", "title"],
  });
  observe();
  setInterval(observe, 2000);
  ipcRenderer.on("wa:prepare-composer", (_event, payload) => {
    let error = "";
    try {
      if (!payload || currentWhatsAppCustomer(document) !== payload.identifier)
        throw Error("当前客户已切换，请重新选择");
      const boxes = [
        ...document.querySelectorAll<HTMLElement>(
          '#main footer [contenteditable="true"][role="textbox"]',
        ),
      ].filter((el) => el.getBoundingClientRect().width > 0);
      if (boxes.length !== 1) throw Error("请先打开客户聊天的输入框");
      const box = boxes[0]!;
      if (box.textContent?.trim()) throw Error("聊天输入框已有草稿，请先发送或清空草稿");
      box.focus();
      const range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch (e) {
      error = (e as Error).message;
    }
    ipcRenderer.send("wa:composer-ready", { requestId: payload?.requestId, error });
  });
}
