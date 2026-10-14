import type { ChatAdapter, ChatMessage } from "./chat-adapter.ts";
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
  translate(text: string, target: string, source?: string): Promise<{ text: string }>;
  loadOriginals(identifier: string): Promise<Record<string, Original>>;
  saveOriginal(id: string, value: Original): Promise<void>;
}
const composerSelector = '#main footer [contenteditable="true"][role="textbox"]';
const errorText = (e: unknown) =>
  String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': Error: /, "");
export function installAutomaticTranslation(
  doc: Document,
  transport: Transport,
  adapter?: ChatAdapter,
) {
  const clean = (el: HTMLElement) =>
    adapter ? adapter.read(el) : el.innerText.replace(/\u00a0/g, " ").trim();
  const win = doc.defaultView!;
  const translator = new AutomaticTranslator(transport.translate);
  const languages = new Map<string, string>();
  const originals = new Map<string, Original>();
  const translated = new Map<string, { text?: string; error?: string; loading?: boolean }>();
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
  let composer: HTMLElement | undefined;
  let errorHost: HTMLElement | undefined, errorTimer: ReturnType<typeof setTimeout>;
  let prepared: { peer: string; source: string; text: string; target: string } | undefined;
  let composerAfterSend: typeof prepared;
  const notes = new WeakMap<HTMLElement, { text: HTMLElement; retry: HTMLButtonElement }>();
  const editor = () =>
    adapter ? adapter.editor() : doc.querySelector<HTMLElement>(composerSelector);
  const currentPeer = () =>
    (adapter ? adapter.customer()?.identifier : currentWhatsAppCustomer(doc)) || "";
  const sendButton = () => {
    if (adapter) return adapter.sendButton();
    const icon = doc.querySelector<HTMLElement>(
      '#main footer [data-icon="send"], #main footer [data-testid="send"], #main footer [aria-label="发送"], #main footer [aria-label="Send"]',
    );
    return icon?.closest<HTMLElement>('button, [role="button"]') || undefined;
  };
  function clearError() {
    clearTimeout(errorTimer);
    errorHost?.remove();
    errorHost = undefined;
  }
  function showError(text: string) {
    if (disposed) return;
    clearError();
    errorHost = doc.createElement("div");
    errorHost.dataset.gd7AutoTranslation = "error";
    errorHost.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 32px);z-index:2147483647;pointer-events:none;";
    const root = errorHost.attachShadow({ mode: "open" });
    root.innerHTML = `<style>p{margin:0;padding:9px 14px;border:1px solid #f1d2c8;border-radius:9px;background:#fff7f3;color:#a0432e;box-shadow:0 3px 14px #0001;font:12px/1.5 system-ui;white-space:pre-wrap;overflow-wrap:anywhere;max-height:72px;overflow:hidden}</style><p role="alert"></p>`;
    root.querySelector("p")!.textContent = text;
    doc.body.append(errorHost);
    errorTimer = setTimeout(clearError, 6000);
  }
  function schedulePreview() {
    if (disposed || replacing) return;
    clearError();
    const ticket = ++previewTicket;
    clearTimeout(previewTimer);
    prepared = undefined;
    const box = editor(),
      identifier = currentPeer(),
      target = languages.get(identifier);
    const source = box ? clean(box) : "";
    if (!source || !identifier || !target) return;
    if (composerAfterSend?.peer === identifier && composerAfterSend.text === source) {
      prepared = composerAfterSend;
      return;
    }
    previewTimer = setTimeout(() => {
      void translator
        .translate(source, target, "zh-CN")
        .then((text) => {
          if (disposed || ticket !== previewTicket || currentPeer() !== identifier) return;
          prepared = { peer: identifier, source, text, target };
        })
        // Keep background preparation quiet; an explicit send retries and reports failures.
        .catch(() => {});
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
  function messages(): ChatMessage[] {
    if (adapter) return adapter.messages();
    const identifier = currentPeer();
    return [...doc.querySelectorAll<HTMLElement>("#main [data-id]")].slice(-100).flatMap((row) => {
      const id = row.dataset.id || "";
      if (customerFromMessageIds([id]) !== identifier) return [];
      const textNode = [
        ...row.querySelectorAll<HTMLElement>(
          '.selectable-text.copyable-text, [data-testid="msg-text"], .selectable-text',
        ),
      ].find(
        (el) =>
          !el.closest('[data-testid="quoted-message"], [data-testid="quoted-message-container"]') &&
          el.closest("[data-id]") === row,
      );
      return textNode
        ? [{ row, textNode, id, text: clean(textNode), outgoing: id.startsWith("true_") }]
        : [];
    });
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
    const box = editor() || undefined;
    if (composer !== box) {
      composer = box;
      schedulePreview();
    }
    if (!identifier) return;
    for (const { row, textNode, id, text: source, outgoing } of messages().reverse()) {
      if (!source) continue;
      if (outgoing && !originals.has(id)) {
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
            .catch(() => showError("消息原文暂未保存到本机，请保持客户端打开"));
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
            translated.set(key, { text });
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
          ? "译：" + result.text
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
      if (box instanceof HTMLTextAreaElement) box.select();
      else {
        const range = doc.createRange();
        range.selectNodeContents(box);
        const selection = win.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
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
      showError("未识别到当前客户或翻译语言尚未加载，消息未发送");
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
    clearError();
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
      if (adapter ? !adapter.canSend() : !sendButton())
        throw Error("未找到官方发送入口，原文已保留");
      const before = new Set(messages().map((m) => m.id));
      replaceDraft(box, text);
      swapped = text.trim();
      composerAfterSend = { peer: identifier, source, text, target };
      await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
      if (!unchanged() || clean(box) !== text.trim()) throw Error("聊天内容已变化，本次未发送");
      const send = sendButton();
      if (
        (adapter ? !adapter.canSend() : !send) ||
        send?.getAttribute("aria-disabled") === "true" ||
        (send instanceof HTMLButtonElement && send.disabled)
      )
        throw Error("官方发送按钮暂不可用，请稍后重试");
      pending.push({ identifier, source, text: text.trim(), before, at: Date.now() });
      while (pending.length > 50) pending.shift();
      // Exactly one click after the user's own send action; no retry on ambiguous delivery.
      bypass = true;
      try {
        if (adapter) adapter.send();
        else send!.click();
        handedOff = true;
      } finally {
        bypass = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      scan();
    } catch (e) {
      if (currentPeer() === identifier && peerVersion === ticket) {
        if (!handedOff && swapped && box.isConnected && clean(box) === swapped) {
          try {
            replaceDraft(box, source);
            composerAfterSend = undefined;
          } catch {
            /* Keep the translated draft and its original available for the next send. */
          }
        }
        showError(errorText(e));
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
    if (
      bypass ||
      (adapter
        ? !adapter.isSendKey(e)
        : e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229)
    )
      return;
    const box = editor();
    if (
      !box ||
      (adapter
        ? !adapter.isComposerEvent(e)
        : !(e.target instanceof Node) || !box.contains(e.target)) ||
      !clean(box)
    )
      return;
    stop(e);
    if (!e.repeat) void sendTranslated();
  };
  const input = (e: Event) => {
    if (
      adapter
        ? adapter.isComposerEvent(e)
        : e.target instanceof Element && e.target.closest(composerSelector)
    )
      schedulePreview();
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
    attributeFilter: ["data-id", "data-peer-id", "data-mid", "data-message-id"],
  });
  win.addEventListener("click", click, true);
  win.addEventListener("keydown", keydown, true);
  doc.addEventListener("input", input, true);
  doc.addEventListener("scroll", queueScan, true);
  scan();
  const polling = adapter ? setInterval(scan, 1000) : undefined;
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
      clearInterval(polling);
      clearTimeout(scanTimer);
      clearTimeout(previewTimer);
      win.removeEventListener("click", click, true);
      win.removeEventListener("keydown", keydown, true);
      doc.removeEventListener("input", input, true);
      doc.removeEventListener("scroll", queueScan, true);
      clearError();
    },
  };
}
