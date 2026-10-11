import {
  currentWhatsAppCustomer,
  customerFromMessageIds,
} from "../../../../packages/platform/whatsapp/customer.ts";
import { AutomaticTranslator } from "../../../../packages/translation/automatic.ts";
interface Original {
  identifier: string;
  source: string;
  text: string;
}
interface Transport {
  translate(
    text: string,
    target: string,
    source?: string,
  ): Promise<{ text: string; provider?: string }>;
  loadOriginals(identifier: string): Promise<Record<string, Original>>;
  saveOriginal(id: string, value: Original): Promise<void>;
}
const composerSelector = '#main footer [contenteditable="true"][role="textbox"]';
const clean = (el: HTMLElement) => el.innerText.replace(/\u00a0/g, " ").trim();
const errorText = (e: unknown) =>
  String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': Error: /, "");
export function installAutomaticTranslation(doc: Document, transport: Transport) {
  const win = doc.defaultView!;
  const translator = new AutomaticTranslator(transport.translate);
  const languages = new Map<string, string>();
  const originals = new Map<string, Original>();
  const translated = new Map<
    string,
    { text?: string; error?: string; loading?: boolean; provider?: string }
  >();
  const pending: {
    source: string;
    text: string;
    identifier: string;
    before: Set<string>;
    at: number;
  }[] = [];
  let peer = "",
    peerVersion = 0,
    disposed = false,
    running = 0,
    sending = false,
    bypass = false,
    replacing = false;
  let previewTicket = 0,
    previewTimer: ReturnType<typeof setTimeout>,
    scanTimer: ReturnType<typeof setTimeout>;
  let footerHost: HTMLElement | undefined, preview: HTMLElement | undefined;
  let prepared: { peer: string; source: string; text: string; target: string } | undefined;
  let composerAfterSend: typeof prepared;
  const notes = new WeakMap<HTMLElement, { text: HTMLElement; retry: HTMLButtonElement }>();
  const editor = () => doc.querySelector<HTMLElement>(composerSelector);
  const currentPeer = () => currentWhatsAppCustomer(doc) || "";
  const sendButton = () => {
    const icon = doc.querySelector<HTMLElement>(
      '#main footer [data-icon="send"], #main footer [data-testid="send"], #main footer [aria-label="发送"], #main footer [aria-label="Send"]',
    );
    return icon?.closest<HTMLElement>('button, [role="button"]') || undefined;
  };
  function show(text: string) {
    if (preview && preview.textContent !== text) preview.textContent = text;
  }
  function mountPreview() {
    const footer = doc.querySelector<HTMLElement>("#main footer");
    if (!footer || footerHost?.parentElement === footer) return;
    footerHost?.remove();
    footerHost = doc.createElement("div");
    footerHost.dataset.gd7AutoTranslation = "composer";
    footerHost.style.cssText = "flex:0 0 100%;width:100%;order:-1;";
    const root = footerHost.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block}div{font:12px/1.55 system-ui;background:#eef8f2;color:#476c59;border-top:1px solid #d9e9df;padding:7px 12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:130px;overflow:auto}button{font:inherit;color:#07885f;background:none;border:0;cursor:pointer;padding:3px 0}</style><div><p style="margin:0" role="status"></p><button type="button">重新翻译</button></div>`;
    preview = root.querySelector("p")!;
    root.querySelector("button")!.addEventListener("click", schedulePreview);
    footer.prepend(footerHost);
    schedulePreview();
  }
  function schedulePreview() {
    if (disposed || replacing) return;
    const ticket = ++previewTicket;
    clearTimeout(previewTimer);
    prepared = undefined;
    const box = editor(),
      identifier = currentPeer(),
      target = languages.get(identifier);
    const source = box ? clean(box) : "";
    if (!source) {
      show("接收自动译成中文 · 输入中文后自动翻译，点击原发送按钮发送译文");
      return;
    }
    if (!identifier || !target) {
      show("正在识别客户和加载翻译语言，请稍候…");
      return;
    }
    if (composerAfterSend?.peer === identifier && composerAfterSend.text === source) {
      prepared = composerAfterSend;
      show("原文：" + prepared.source + "\n译文：" + prepared.text);
      return;
    }
    show("正在自动翻译…");
    previewTimer = setTimeout(() => {
      void translator
        .translate(source, target, "zh-CN")
        .then((text) => {
          if (disposed || ticket !== previewTicket || currentPeer() !== identifier) return;
          prepared = { peer: identifier, source, text, target };
          show(
            "将发送：" +
              text +
              (translator.provider(source, target, "zh-CN")
                ? "\n翻译服务：" + translator.provider(source, target, "zh-CN")
                : ""),
          );
        })
        .catch((e) => {
          if (!disposed && ticket === previewTicket) show("翻译失败，原文未发送：" + errorText(e));
        });
    }, 650);
  }
  function annotate(
    row: HTMLElement,
    textNode: HTMLElement,
    key: string,
    value: string,
    failure: boolean,
  ) {
    let note = notes.get(row);
    if (!note || !note.text.isConnected) {
      const host = doc.createElement("div");
      host.dataset.gd7AutoTranslation = "message";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>:host{display:block;border-top:1px dashed #a2b4aa66;margin:5px 0 2px;padding-top:5px}p{font:12px/1.55 system-ui;color:#6b8276;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}button{border:0;background:none;color:#07885f;font:12px system-ui;padding:4px 0;cursor:pointer}[hidden]{display:none!important}</style><p></p><button type="button" hidden>重试翻译</button>`;
      note = { text: root.querySelector("p")!, retry: root.querySelector("button")! };
      // Append outside the official selectable text, so copies and forwards keep the original.
      textNode.parentElement!.append(host);
      notes.set(row, note);
    }
    if (note.text.textContent !== value) note.text.textContent = value;
    note.retry.hidden = !failure;
    note.retry.onclick = () => {
      translated.delete(key);
      scan();
    };
  }
  function scan() {
    if (disposed) return;
    const identifier = currentPeer();
    if (peer !== identifier) {
      peer = identifier;
      peerVersion++;
      composerAfterSend = undefined;
      schedulePreview();
      if (peer)
        void transport
          .loadOriginals(peer)
          .then((values) => {
            if (disposed) return;
            for (const [id, value] of Object.entries(values)) originals.set(id, value);
            scan();
          })
          .catch(() => {});
    }
    mountPreview();
    if (!identifier) return;
    const rows = [...doc.querySelectorAll<HTMLElement>("#main [data-id]")].slice(-100).reverse();
    for (const row of rows) {
      const id = row.dataset.id || "";
      if (customerFromMessageIds([id]) !== identifier) continue;
      const textNode = [
        ...row.querySelectorAll<HTMLElement>(
          '.selectable-text.copyable-text, [data-testid="msg-text"], .selectable-text',
        ),
      ].find(
        (el) =>
          !el.closest('[data-testid="quoted-message"], [data-testid="quoted-message-container"]') &&
          el.closest("[data-id]") === row,
      );
      if (!textNode) continue;
      const source = clean(textNode);
      if (!source) continue;
      if (id.startsWith("true_") && !originals.has(id)) {
        const at = pending.findIndex(
          (p) =>
            p.identifier === identifier &&
            p.text === source &&
            !p.before.has(id) &&
            Date.now() - p.at < 120000,
        );
        if (at >= 0) {
          const item = pending.splice(at, 1)[0]!;
          const original = { identifier, source: item.source, text: item.text };
          originals.set(id, original);
          void transport
            .saveOriginal(id, original)
            .catch(() => show("消息原文暂未保存到本机，请保持客户端打开"));
        }
      }
      const original = originals.get(id);
      const sourceHint = languages.get(identifier);
      const key = id + "\0" + source + "\0" + (sourceHint || "");
      if (original?.text === source && original.identifier === identifier) {
        annotate(row, textNode, key, "原文：" + original.source, false);
        continue;
      }
      if (!sourceHint) {
        annotate(row, textNode, key, "正在加载客户翻译语言…", false);
        continue;
      }
      let result = translated.get(key);
      if (!result && running < 2) {
        // Only translate rows near the viewport; virtualized history is handled when scrolled in.
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom < 0 || bounds.top > win.innerHeight + 100) continue;
        result = { loading: true };
        translated.set(key, result);
        running++;
        void translator
          .translate(source, "zh-CN", sourceHint)
          .then((text) => {
            translated.set(key, {
              text,
              provider: translator.provider(source, "zh-CN", sourceHint),
            });
          })
          .catch((e) => {
            translated.set(key, { error: errorText(e) });
          })
          .finally(() => {
            running--;
            scan();
          });
      }
      annotate(
        row,
        textNode,
        key,
        result?.text
          ? "译：" + result.text + (result.provider ? "\n翻译服务：" + result.provider : "")
          : result?.error
            ? "翻译失败：" + result.error
            : "正在自动翻译…",
        !!result?.error,
      );
    }
  }
  function replaceDraft(box: HTMLElement, text: string) {
    replacing = true;
    try {
      box.focus();
      const range = doc.createRange();
      range.selectNodeContents(box);
      const selection = win.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (!doc.execCommand("insertText", false, text) || clean(box) !== text.trim())
        throw Error("无法更新官方输入框，消息未发送");
    } finally {
      replacing = false;
    }
  }
  async function sendTranslated() {
    if (sending) return;
    const box = editor(),
      identifier = currentPeer(),
      target = languages.get(identifier),
      ticket = peerVersion;
    if (!box || !clean(box)) return;
    if (!identifier || !target) {
      show("未识别到当前客户或翻译语言尚未加载，消息未发送");
      return;
    }
    const input = clean(box);
    const source =
      composerAfterSend?.peer === identifier && composerAfterSend.text === input
        ? composerAfterSend.source
        : input;
    sending = true;
    clearTimeout(previewTimer);
    previewTicket++;
    show("正在翻译并发送…");
    let swapped: string | undefined;
    let handedOff = false;
    try {
      const text =
        prepared?.source === source && prepared.target === target && prepared.peer === identifier
          ? prepared.text
          : await translator.translate(source, target, "zh-CN");
      const unchanged = () =>
        !disposed &&
        box.isConnected &&
        editor() === box &&
        currentPeer() === identifier &&
        peerVersion === ticket &&
        languages.get(identifier) === target;
      if (!unchanged() || clean(box) !== input) throw Error("客户、语言或草稿已变化，本次未发送");
      if (!sendButton()) throw Error("未找到官方发送按钮，原文已保留");
      const before = new Set(
        [...doc.querySelectorAll<HTMLElement>("#main [data-id]")].map((el) => el.dataset.id || ""),
      );
      replaceDraft(box, text);
      swapped = text.trim();
      composerAfterSend = { peer: identifier, source, text, target };
      await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
      if (!unchanged() || clean(box) !== text.trim()) throw Error("聊天内容已变化，本次未发送");
      const send = sendButton();
      if (
        !send ||
        send.getAttribute("aria-disabled") === "true" ||
        (send instanceof HTMLButtonElement && send.disabled)
      )
        throw Error("官方发送按钮暂不可用，请稍后重试");
      pending.push({ identifier, source, text: text.trim(), before, at: Date.now() });
      while (pending.length > 50) pending.shift();
      // Exactly one click after the user's own send action; no retry on ambiguous delivery.
      bypass = true;
      try {
        send.click();
        handedOff = true;
      } finally {
        bypass = false;
      }
      show("已交给 WhatsApp 发送，请以消息旁的发送状态为准");
      await new Promise((resolve) => setTimeout(resolve, 500));
      scan();
    } catch (e) {
      if (currentPeer() === identifier && peerVersion === ticket) {
        if (!handedOff && swapped && box.isConnected && clean(box) === swapped) {
          try {
            replaceDraft(box, source);
            composerAfterSend = undefined;
          } catch {
            /* Keep the translated draft and original preview available. */
          }
        }
        show(errorText(e));
      }
    } finally {
      sending = false;
    }
  }
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const click = (e: MouseEvent) => {
    const send = sendButton();
    if (bypass || !send || !(e.target instanceof Node) || !send.contains(e.target)) return;
    if (!editor() || !clean(editor()!)) return;
    stop(e);
    void sendTranslated();
  };
  const keydown = (e: KeyboardEvent) => {
    if (bypass || e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229)
      return;
    const box = editor();
    if (!box || !(e.target instanceof Node) || !box.contains(e.target) || !clean(box)) return;
    stop(e);
    if (!e.repeat) void sendTranslated();
  };
  const input = (e: Event) => {
    if (e.target instanceof Element && e.target.closest(composerSelector)) schedulePreview();
  };
  const queueScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 100);
  };
  const observer = new MutationObserver(queueScan);
  observer.observe(doc.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-id"],
  });
  win.addEventListener("click", click, true);
  win.addEventListener("keydown", keydown, true);
  doc.addEventListener("input", input, true);
  doc.addEventListener("scroll", queueScan, true);
  scan();
  return {
    setLanguage(identifier: string, language: string) {
      if (languages.get(identifier) === language) return;
      languages.set(identifier, language);
      if (currentPeer() === identifier) {
        schedulePreview();
        scan();
      }
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      clearTimeout(scanTimer);
      clearTimeout(previewTimer);
      win.removeEventListener("click", click, true);
      win.removeEventListener("keydown", keydown, true);
      doc.removeEventListener("input", input, true);
      doc.removeEventListener("scroll", queueScan, true);
      footerHost?.remove();
    },
  };
}
