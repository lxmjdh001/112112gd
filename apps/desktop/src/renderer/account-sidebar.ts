import { accountPresence } from "../shared/account-presence.ts";
import type { Account, ViewState } from "../shared/types.ts";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const platforms = [
  { id: "whatsapp", name: "WhatsApp", icon: "whatsapp.svg", supported: true },
  { id: "whatsapp_cloud", name: "WhatsApp API", icon: "whatsapp.svg", supported: true },
  { id: "facebook", name: "Facebook", icon: "facebook.ico" },
  { id: "messenger", name: "Messenger", icon: "messenger.ico" },
  { id: "meta_business", name: "Meta Business", icon: "meta.svg" },
  { id: "instagram", name: "Instagram", icon: "instagram.webp" },
  { id: "tiktok", name: "TikTok", icon: "tiktok.ico" },
  { id: "line", name: "LINE", icon: "line.png", supported: true },
  { id: "telegram", name: "Telegram", icon: "telegram.svg", supported: true },
  { id: "x", name: "X", icon: "x.ico" },
];
type Platform = (typeof platforms)[number];
const icon = (platform: Platform, status = "") =>
  `<span class="platform-icon ${status ? "has-status" : ""}"><img class="platform-logo" src="assets/${platform.icon}" alt="" draggable="false" />${platform.id === "whatsapp_cloud" ? '<span class="api-icon-badge">API</span>' : ""}${status ? `<small class="platform-availability" aria-hidden="true">${escape(status === "连接恢复中" ? "重连中" : status)}</small>` : ""}</span>`;
const glyph = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const collapseIcon = glyph('<path d="M4 4v16M20 6H10m10 6H10m10 6H10M13 9l-3 3 3 3"/>');
const refreshIcon = glyph(
  '<path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
);
const logoutIcon = glyph('<path d="M9 4H4v16h5m6-12 4 4-4 4m-7-4h11"/>');
const accountPlatform = (account: Account) =>
  account.connectionType === "cloud" ? "whatsapp_cloud" : account.platform;
function accountMarkup(account: Account, state: ViewState, platform: Platform) {
  const presence = accountPresence(account, state);
  const initials = [...account.label.trim()].slice(0, 2).join("").toUpperCase() || "D1";
  const avatar = state.accountProfiles?.[account.id]?.avatar;
  const photo =
    typeof avatar === "string" &&
    avatar.length <= 24000 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(avatar)
      ? `<img class="account-self-avatar" src="${avatar}" alt="" draggable="false" />`
      : "";
  return `<div class="account-item">
    <button type="button" class="account ${account.id === state.activeId ? "active" : ""} ${account.paused ? "paused" : ""}" data-id="${escape(account.id)}" title="${escape(account.label)} · ${presence.label} · ${escape(presence.reason)}" aria-label="${escape(account.label)}，${presence.label}，${escape(presence.reason)}" ${account.id === state.activeId ? 'aria-current="true"' : ""} ${account.available ? "" : "disabled"}>
      <span class="account-avatar" aria-hidden="true">${escape(initials)}${photo}<span class="account-platform-badge">${icon(platform)}</span></span>
      <span class="account-info"><b>${escape(account.label)}</b><small><i class="account-status-dot ${presence.kind === "online" ? "is-ready" : presence.kind === "error" ? "is-error" : ""}"></i><span class="account-presence">${presence.label}</span></small></span>
    </button>
    ${account.unavailableReason === "other_device" ? "" : `<button class="account-close" type="button" data-close-id="${escape(account.id)}" title="${account.paused ? "移除号位" : "退出账号"}" aria-label="${account.paused ? "移除" : "退出"} ${escape(account.label)}"><svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg></button>`}
  </div>`;
}

export function createAccountSidebar(
  getState: () => ViewState,
  add: (platform?: string) => void,
  action: (fn: () => Promise<void>) => Promise<void>,
) {
  const folded = new Set<string>();
  let removedExpanded = false;
  let modal: HTMLDialogElement | undefined;
  let opening = false;
  function availability(platform: Platform, state: ViewState) {
    if (!platform.supported) return "未开放";
    if (!state.platforms.some((p) => p.id === platform.id)) return "未授权";
    if (state.connection !== "online") return "连接恢复中";
    return "";
  }
  function markup(state: ViewState) {
    const visible = state.accounts.filter((a) => !a.hidden);
    const counts = { online: 0, offline: 0, error: 0 };
    visible.forEach((a) => counts[accountPresence(a, state).kind]++);
    const added = platforms.filter((p) => state.accounts.some((a) => accountPlatform(a) === p.id));
    const unused = platforms.filter((p) => !added.includes(p));
    const group = (p: Platform) => {
      const accounts = state.accounts.filter((a) => accountPlatform(a) === p.id && !a.hidden);
      const hidden = state.accounts.filter((a) => accountPlatform(a) === p.id && a.hidden);
      const disabled = availability(p, state);
      const isFolded = folded.has(p.id);
      return `<section class="account-group ${accounts.some((a) => a.id === state.activeId) ? "is-active" : ""}" data-platform="${p.id}" aria-labelledby="group-${p.id}">
        <div class="platform-heading">
          <button class="platform-toggle" type="button" data-fold="${p.id}" aria-expanded="${!isFolded}" aria-controls="accounts-${p.id}" title="${p.name} · ${accounts.length} 个账号">${icon(p, disabled)}<h2 id="group-${p.id}">${p.name}</h2><span class="platform-count">${accounts.length}</span></button>
          <button class="platform-add" type="button" data-add-platform="${p.id}" aria-label="添加 ${p.name} 账号" title="${disabled || (p.id === "whatsapp_cloud" ? "查看 API 号码分配" : `添加 ${p.name} 账号`)}" ${disabled ? "disabled" : ""}>+</button>
          <button class="platform-fold" type="button" data-fold="${p.id}" aria-label="${isFolded ? "展开" : "收起"} ${p.name}" aria-expanded="${!isFolded}" aria-controls="accounts-${p.id}"><span class="sidebar-chevron"></span></button>
        </div>
        <div class="group-accounts" id="accounts-${p.id}" ${isFolded ? "hidden" : ""}>
          ${accounts.map((a) => accountMarkup(a, state, p)).join("")}
          ${hidden.length ? `<details class="removed-api" ${removedExpanded ? "open" : ""}><summary title="已移除的 API 号码">已移除的 API 号码（${hidden.length}）</summary>${hidden.map((a) => `<button class="text-btn" data-restore-id="${escape(a.id)}" title="重新添加 ${escape(a.label)}" ${a.available ? "" : "disabled"}>重新添加 ${escape(a.label)}</button>`).join("")}</details>` : ""}
        </div>
      </section>`;
    };
    return `<aside class="account-sidebar ${state.sidebarCollapsed ? "is-compact" : ""}" aria-label="平台与账号">
      <div class="sidebar-brand"><span class="sidebar-mark">D1</span><div class="sidebar-brand-info"><strong>D1 Scrm</strong><div class="sidebar-status"><span title="已登录的账号或可用的 API 通道"><i class="is-ready"></i>${counts.online} 在线</span><span title="尚未登录、已退出或绑定其他设备"><i></i>${counts.offline} 离线</span><span title="网络、账号数据或授权异常"><i class="is-error"></i>${counts.error} 异常</span></div></div><button class="sidebar-collapse icon-button" id="sidebar-toggle" type="button" title="${state.sidebarCollapsed ? "展开" : "收起"}左侧菜单" aria-label="${state.sidebarCollapsed ? "展开" : "收起"}左侧菜单" aria-expanded="${!state.sidebarCollapsed}">${collapseIcon}</button></div>
      <div class="account-list">${added.map(group).join("")}
        <div class="unused-platforms"><p class="unused-heading">添加平台</p>${unused
          .map((p) => {
            const disabled = availability(p, state);
            const title =
              disabled === "未开放"
                ? `${p.name} 尚未开放`
                : disabled === "未授权"
                  ? `请联系管理员授权 ${p.name}`
                  : disabled ||
                    (p.id === "whatsapp_cloud" ? "查看 API 号码分配" : `添加 ${p.name} 账号`);
            return `<button class="unused-platform" data-add-platform="${p.id}" type="button" title="${title}" aria-label="${title}" ${disabled ? "disabled" : ""}>${icon(p)}<span class="unused-name">${p.name}</span>${disabled ? `<span class="platform-state">${escape(disabled)}</span>` : '<span class="unused-plus" aria-hidden="true">+</span>'}</button>`;
          })
          .join("")}</div>
      </div>
      <div class="sidebar-actions"><button class="add-account" id="add-account" type="button" title="添加账号" ${state.platforms.some((p) => ["whatsapp", "telegram", "line"].includes(p.id)) && state.connection === "online" ? "" : "disabled"}><span aria-hidden="true">＋</span><span class="sidebar-button-label"> 添加账号</span></button><button class="icon-button" id="refresh" type="button" title="刷新账号" aria-label="刷新">${refreshIcon}</button></div>
      <div class="side-bottom"><span class="sidebar-user" title="${escape(state.label)}"><i class="connection-dot ${state.connection === "online" ? "is-ready" : ""}"></i><span>${escape(state.label)}</span></span><button class="icon-button" id="logout" type="button" title="退出客户端" aria-label="退出客户端">${logoutIcon}</button></div>
    </aside>`;
  }
  async function dismiss() {
    if (!modal) return;
    modal.close();
    modal.remove();
    modal = undefined;
    await window.gongdan.toolsModal(false);
  }
  async function explainAPI() {
    if (opening || modal) return;
    opening = true;
    try {
      await window.gongdan.toolsModal(true);
      if (!getState().loggedIn) {
        await window.gongdan.toolsModal(false);
        return;
      }
      modal = document.createElement("dialog");
      modal.className = "account-dialog";
      modal.setAttribute("aria-labelledby", "api-assignment-title");
      modal.innerHTML = `<div class="dialog-heading"><h2 id="api-assignment-title">添加 WhatsApp API 号码</h2><button class="text-btn" type="button" data-dismiss aria-label="关闭">×</button></div><p class="muted">请管理员在后台「WhatsApp API」中添加号码，并分配给当前登录码。分配完成后，点击下方按钮同步到客户端。</p><p class="muted">之前移除的号码，可展开左侧「已移除的 API 号码」重新添加。</p><div class="dialog-actions"><button class="secondary" type="button" data-dismiss>取消</button><button class="primary" type="button" data-sync>刷新已分配号码</button></div>`;
      modal
        .querySelectorAll("[data-dismiss]")
        .forEach((b) => b.addEventListener("click", () => void action(dismiss)));
      modal.addEventListener("cancel", (e) => {
        e.preventDefault();
        void action(dismiss);
      });
      modal.querySelector("[data-sync]")!.addEventListener(
        "click",
        () =>
          void action(async () => {
            await dismiss();
            await window.gongdan.refresh();
          }),
      );
      document.body.append(modal);
      modal.showModal();
    } finally {
      opening = false;
    }
  }
  function bind(aside: HTMLElement) {
    aside
      .querySelectorAll<HTMLImageElement>(".account-self-avatar")
      .forEach((img) => img.addEventListener("error", () => img.remove(), { once: true }));
    aside
      .querySelector("#sidebar-toggle")!
      .addEventListener(
        "click",
        () => void action(() => window.gongdan.setSidebarCollapsed(!getState().sidebarCollapsed)),
      );
    aside.querySelectorAll<HTMLButtonElement>("[data-fold]").forEach((button) =>
      button.addEventListener("click", () => {
        const id = button.dataset.fold!;
        if (folded.has(id)) folded.delete(id);
        else folded.add(id);
        const group = button.closest(".account-group")!;
        group.querySelector<HTMLElement>(".group-accounts")!.hidden = folded.has(id);
        group.querySelectorAll<HTMLButtonElement>("[data-fold]").forEach((b) => {
          b.setAttribute("aria-expanded", String(!folded.has(id)));
          if (b.classList.contains("platform-fold"))
            b.setAttribute(
              "aria-label",
              `${folded.has(id) ? "展开" : "收起"} ${platforms.find((p) => p.id === id)!.name}`,
            );
        });
      }),
    );
    aside.querySelector(".removed-api")?.addEventListener("toggle", (e) => {
      removedExpanded = (e.target as HTMLDetailsElement).open;
    });
    aside.querySelectorAll<HTMLButtonElement>("[data-add-platform]").forEach((button) =>
      button.addEventListener("click", () => {
        const platform = platforms.find((p) => p.id === button.dataset.addPlatform);
        if (!platform || availability(platform, getState())) return;
        if (platform.id === "whatsapp_cloud") void action(explainAPI);
        else add(platform.id);
      }),
    );
  }
  return { markup, bind, dismiss };
}
