import { installInboundStats } from "./inbound-stats.ts";
import { installAutomaticTranslation } from "./automatic-translation.ts";
import { installChatContext } from "./chat-context.ts";
import { currentWhatsAppCustomer } from "../../../../packages/platform/whatsapp/customer.ts";
import { installCustomerPanel } from "./customer.ts";
import { ipcRenderer } from "electron";
import { observeWhatsApp } from "../../../../packages/platform/whatsapp/index.ts";
import { currentWhatsAppAccount } from "../../../../packages/platform/whatsapp/self.ts";

// This preload runs in an isolated world. No privileged API is exposed to WhatsApp.
window.addEventListener("DOMContentLoaded", () => {
  if (location.origin !== "https://web.whatsapp.com") return;
  installCustomerPanel();
  installInboundStats("whatsapp");
  installChatContext();
  const automatic = installAutomaticTranslation(document, {
    translate: (text, target, source) =>
      ipcRenderer.invoke("wa:translate", { text, target, source }),
    loadOriginals: (identifier) => ipcRenderer.invoke("wa:translation-originals", { identifier }),
    saveOriginal: (id, value) => ipcRenderer.invoke("wa:translation-originals", { id, ...value }),
  });
  window.addEventListener("pagehide", () => automatic.dispose(), { once: true });
  const host = document.createElement("div");
  host.id = "gongdan-translation";
  host.style.cssText =
    "position:fixed;right:22px;bottom:100px;z-index:2147483646;font:13px system-ui;color:#17211f";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>*{box-sizing:border-box}button,select,textarea{font:inherit}button{cursor:pointer;border:0;border-radius:8px;padding:9px 12px;background:#e7f4ee;color:#087f5b}button:disabled{opacity:.5;cursor:wait}.trigger{box-shadow:0 3px 18px #0002;background:#07885f;color:white;padding:11px 16px}section{width:340px;max-height:65vh;overflow:auto;background:#fff;border:1px solid #dfe8e4;border-radius:14px;box-shadow:0 12px 45px #0002;padding:16px;margin-bottom:10px}header{display:flex;align-items:center;justify-content:space-between}h3{font-size:14px;margin:0}p{font-size:12px;line-height:1.6;color:#71807a}textarea{width:100%;height:86px;resize:vertical;border:1px solid #dce4e0;border-radius:8px;padding:10px;color:#17211f;background:#f8faf9;margin:8px 0}select{padding:7px;border:1px solid #dce4e0;border-radius:6px;background:white;color:#17211f}label{font-size:12px;display:block;margin:12px 0 5px}output{display:block;white-space:pre-wrap;line-height:1.6;margin:12px 0;max-height:150px;overflow:auto;user-select:text;overflow-wrap:anywhere}.actions{display:flex;justify-content:space-between;gap:8px}.error{color:#bc4d32}small{color:#8b9791;font-size:11px}.source{color:#8b9791;max-height:55px;overflow:auto;font-size:12px;white-space:pre-wrap}[hidden]{display:none!important}</style><section hidden><header><h3>免费翻译 · 自动切换</h3><button class="close" aria-label="关闭翻译">×</button></header><p>选中聊天文字后点击翻译，或输入想回复的内容。</p><div class="source"></div><label>目标语言 <select aria-label="翻译目标语言"><option value="zh-CN">简体中文</option><option value="en">英语</option><option value="zh-TW">繁体中文</option><option value="es">西班牙语</option><option value="pt">葡萄牙语</option><option value="ar">阿拉伯语</option><option value="ru">俄语</option><option value="fr">法语</option><option value="de">德语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="vi">越南语</option><option value="th">泰语</option><option value="id">印尼语</option><option value="hi">印地语</option></select></label><textarea maxlength="4000" placeholder="输入回复，翻译后复制到 WhatsApp…" aria-label="待翻译文字"></textarea><div class="actions"><button class="translate">翻译</button><button class="copy" disabled>复制译文</button></div><output aria-live="polite"></output><small>仅提交本次文字给 Google。译文请确认后自行发送。</small></section><button class="trigger">译 · 翻译</button>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const panel = $<HTMLElement>("section"),
    input = $<HTMLTextAreaElement>("textarea"),
    lang = $<HTMLSelectElement>("select"),
    output = $<HTMLOutputElement>("output"),
    copy = $<HTMLButtonElement>(".copy"),
    translate = $<HTMLButtonElement>(".translate");
  let version = 0;
  let selected = "";
  let lastResult = "";
  document.addEventListener("selectionchange", () => {
    const s = window.getSelection()?.toString().trim();
    if (s && s.length <= 4000 && !host.contains(window.getSelection()?.anchorNode || null))
      selected = s;
  });
  const invalidate = () => {
    version++;
    lastResult = "";
    copy.disabled = true;
    output.textContent = "";
  };
  ipcRenderer.on("wa:customer-language", (_event, payload) => {
    automatic.setLanguage(payload.identifier, payload.language);
    if (
      currentWhatsAppCustomer(document) === payload.identifier &&
      [...lang.options].some((o) => o.value === payload.language)
    ) {
      invalidate();
      lang.value = payload.language;
    }
  });
  input.addEventListener("input", invalidate);
  lang.addEventListener("change", invalidate);
  async function run() {
    const text = input.value.trim();
    if (!text) return;
    const current = ++version;
    translate.disabled = true;
    copy.disabled = true;
    output.className = "";
    output.textContent = "正在翻译…";
    try {
      const result = await ipcRenderer.invoke("wa:translate", { text, target: lang.value });
      if (current !== version) return;
      lastResult = result.text;
      output.textContent = result.text;

      copy.disabled = false;
    } catch {
      if (current === version) {
        output.className = "error";
        output.textContent =
          "翻译未完成，可能是代理连接、免费服务限流或登录权限已失效，请稍后重试。";
      }
    } finally {
      translate.disabled = false;
    }
  }
  function show(text?: string) {
    panel.hidden = false;
    if (text) {
      invalidate();
      input.value = text;
      $(".source").textContent = "选中文字 · 原文保留在聊天中";
      void run();
    }
  }
  $(".trigger").addEventListener("click", () => {
    if (panel.hidden) {
      show(selected || undefined);
      selected = "";
    } else panel.hidden = true;
  });
  $(".close").addEventListener("click", () => (panel.hidden = true));
  translate.addEventListener("click", () => void run());
  copy.addEventListener("click", async () => {
    if (lastResult) {
      try {
        await ipcRenderer.invoke("wa:copy", lastResult);
        copy.textContent = "已复制，请粘贴后发送";
        setTimeout(() => (copy.textContent = "复制译文"), 1800);
      } catch {
        output.textContent = "复制失败，请重新登录后再试。";
      }
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.composedPath().includes(host)) {
      panel.hidden = true;
      selected = "";
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") panel.hidden = true;
  });
  ipcRenderer.on("wa:selection", (_e, text) => show(String(text).slice(0, 4000)));
  document.body.append(host);
  // Conservative DOM observations; missing selectors never mean an invalid session.
  function report() {
    const status = observeWhatsApp(document, navigator.onLine);
    ipcRenderer.send(
      "wa:status",
      status,
      status === "ready" ? currentWhatsAppAccount(localStorage) : null,
    );
  }
  report();
  setInterval(report, 20000);
  window.addEventListener("online", report);
  window.addEventListener("offline", report);
});
