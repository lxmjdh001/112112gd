import { ipcRenderer } from "electron";
import { currentWhatsAppCustomer } from "../../../../packages/platform/whatsapp/customer.ts";
interface Match {
  duplicateAccount: boolean;
  duplicateIP: boolean;
  baselineMatch: boolean;
  historyMatch: boolean;
}
export function installCustomerPanel() {
  const host = document.createElement("div");
  host.id = "gongdan-customer";
  host.style.cssText =
    "position:fixed;right:22px;top:76px;z-index:2147483645;font:13px system-ui;color:#17211f";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>*{box-sizing:border-box}[hidden]{display:none!important}button,input{font:inherit}button{border:0;border-radius:8px;background:#e7f4ee;color:#087f5b;padding:9px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:default}.trigger{box-shadow:0 3px 16px #0002;background:#fff;border:1px solid #dfe8e4}.trigger.repeat{background:#fff4de;color:#93651c}section{width:320px;max-height:65vh;overflow:auto;padding:16px;margin-top:8px;border:1px solid #dfe8e4;border-radius:12px;background:#fff;box-shadow:0 10px 35px #0002}header{display:flex;justify-content:space-between;align-items:center;font-weight:600}p,small{color:#7a8580;font-size:12px;line-height:1.65}label{display:block;margin-top:12px}input{width:100%;padding:9px;border:1px solid #dfe8e4;border-radius:7px;background:#fff;color:#17211f;margin:6px 0 3px}output{display:block;padding:12px 0;line-height:1.7;overflow-wrap:anywhere}.actions{display:flex;gap:8px}.save{background:#07885f;color:#fff}</style><button class="trigger">客户查重</button><section hidden><header>客户查重<button class="close" aria-label="关闭查重">×</button></header><p>同一团队、同一平台跨客服账号查重。</p><label>客户账号<input class="identifier" placeholder="含国家区号的手机号或完整 LID" maxlength="100" aria-label="客户查重账号"></label><small class="identity-hint"></small><label>客户实际网络 IP（选填）<input class="ip" placeholder="手动填写公网 IPv4 / IPv6" maxlength="60" aria-label="客户查重IP"></label><small>WhatsApp 聊天页不提供客户真实 IP。</small><output aria-live="polite"></output><div class="actions"><button class="check">查重</button><button class="save">登记对话</button></div><p>仅在实际接待后登记。同一客服与客户只计一次，打开历史聊天不会自动计数。</p></section>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const panel = $("section"),
    trigger = $<HTMLButtonElement>(".trigger"),
    input = $<HTMLInputElement>(".identifier"),
    ip = $<HTMLInputElement>(".ip"),
    output = $("output"),
    save = $<HTMLButtonElement>(".save"),
    check = $<HTMLButtonElement>(".check");
  let detected: string | null = null,
    version = 0,
    busy = false,
    lastCheck = 0,
    manual = false,
    context = "";
  function clear() {
    version++;
    lastCheck = 0;
    output.textContent = "";
    trigger.textContent = "客户查重";
    trigger.classList.remove("repeat");
  }
  function render(m: Match, prefix = "") {
    const repeat = m.duplicateAccount || m.duplicateIP;
    const reasons = [
      m.duplicateAccount ? "账号重复" : "",
      m.duplicateIP ? "IP 重复" : "",
      m.baselineMatch ? "命中底库" : "",
      m.historyMatch ? "命中在先对话" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    trigger.textContent = repeat ? "重复用户 · 查重" : "未命中 · 查重";
    trigger.classList.toggle("repeat", repeat);
    output.textContent =
      prefix + (repeat ? "重复用户：" + reasons : "新用户：未命中底库与在先对话");
  }
  async function run(record = false) {
    if (busy || (!input.value.trim() && !ip.value.trim())) return;
    const current = version;
    busy = true;
    check.disabled = true;
    save.disabled = true;
    output.textContent = record ? "正在登记…" : "正在查重…";
    try {
      const payload = { identifier: input.value.trim(), ip: ip.value.trim() };
      if (record) {
        const result = await ipcRenderer.invoke("wa:conversation", payload);
        if (current === version)
          render(result.match, result.existing ? "已登记，未重复计数。" : "登记成功。");
      } else {
        const result = await ipcRenderer.invoke("wa:customer-check", payload);
        if (current === version) render(result);
      }
      if (current === version) lastCheck = Date.now();
    } catch {
      if (current === version) {
        output.textContent = "操作未完成，请检查客户账号、公网 IP 和管理服务连接后重试。";
        trigger.textContent = "查重待重试";
        trigger.classList.remove("repeat");
      }
    } finally {
      busy = false;
      check.disabled = false;
      save.disabled = !input.value.trim();
    }
  }
  function observe() {
    host.hidden = !document.querySelector("#pane-side");
    const next = currentWhatsAppCustomer(document);
    const chatContext =
      next || document.querySelector("#main header [title]")?.getAttribute("title") || "";
    if (next !== detected || chatContext !== context) {
      context = chatContext;
      detected = next;
      manual = false;
      clear();
      input.value = next || "";
      ip.value = "";
      save.disabled = !next;
      $(".identity-hint").textContent = next
        ? "从当前聊天识别，请核对后登记。"
        : "未能可靠识别客户账号，请手动填写；不会按昵称猜测。";
      if (next) void run();
    } else if (next && !manual && !busy && Date.now() - lastCheck > 30000) {
      void run();
    }
  }
  input.addEventListener("input", () => {
    manual = true;
    clear();
    save.disabled = !input.value.trim();
  });
  ip.addEventListener("input", () => {
    manual = true;
    clear();
  });
  trigger.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      observe();
      if (!input.value)
        $(".identity-hint").textContent = "请填写客户真实平台账号，不使用昵称查重。";
    }
  });
  $(".close").addEventListener("click", () => (panel.hidden = true));
  check.addEventListener("click", () => void run());
  save.addEventListener("click", () => void run(true));
  document.addEventListener("pointerdown", (e) => {
    if (!e.composedPath().includes(host)) panel.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") panel.hidden = true;
  });
  document.body.append(host);
  observe();
  setInterval(observe, 2000);
}
