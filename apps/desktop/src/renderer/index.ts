import { detectSource } from "../../../../packages/translation/source.ts";
import { mountCustomerTools } from "./customer-tools.ts";
import type { CustomerContext } from "../shared/customer-tools.ts";
import type { ShellAPI, ViewState } from "../shared/types.ts";
import { createAccountSidebar } from "./account-sidebar.ts";
import { createAccountForm } from "./account-form.ts";
import { accountCloseDialog } from "./account-close.ts";
import { mountCloudChat } from "../../../../packages/cloud-chat/index.ts";
declare global {
  interface Window {
    gongdan: ShellAPI;
  }
}
const container = document.querySelector<HTMLDivElement>("#app")!;
let current: ViewState;
let busy = false;
let tools: { host: HTMLElement; widget: ReturnType<typeof mountCustomerTools> } | undefined;
let cloudCustomer: CustomerContext | undefined;
function updateTools(state: ViewState) {
  if (!tools) {
    const host = document.createElement("section");
    const widget = mountCustomerTools(host, {
      toggle: (collapsed) => window.gongdan.setToolsCollapsed(collapsed),
      async prepare(context, asset, content, text) {
        if (context.chatId) {
          if (cloud?.id !== context.accountId) throw Error("当前账号已切换");
          await cloud.widget.prepareQuick(
            context.chatId,
            asset.kind === "image" ? { image: content } : { text },
          );
        } else
          await window.gongdan.prepareQuick(
            context,
            asset.kind === "image" ? { assetId: asset.id } : { text },
          );
      },
      async language(context, language) {
        if (context.chatId) cloud?.widget.setCustomerLanguage(context.chatId, language);
        else await window.gongdan.customerLanguage(context, language);
      },
      async translate(context, text, language) {
        if (context.chatId)
          return (
            await window.gongdan.cloudRequest<{ text: string }>(context.accountId, "/translate", {
              text,
              target: language,
              source: detectSource(text, "zh-CN"),
            })
          ).text;
        return (await window.gongdan.customerTranslate(context, text, language)).text;
      },
    });
    tools = { host, widget };
  }
  if (!tools.host.isConnected) container.querySelector(".workspace")!.append(tools.host);
  const context = cloudCustomer?.accountId === state.activeId ? cloudCustomer : state.customer;
  const platform = state.accounts.find((account) => account.id === state.activeId)?.platform;
  const nativeOnly =
    platform === "line" ? "LINE" : platform === "telegram" ? "Telegram" : undefined;
  tools.widget.update(context, state.toolsCollapsed === true, nativeOnly);
}

let cloud: { id: string; host: HTMLElement; widget: ReturnType<typeof mountCloudChat> } | undefined;
const accountForm = createAccountForm(
  () => current,
  (message) => {
    const notice = container.querySelector(".notice");
    if (notice) notice.textContent = message;
  },
);
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const accountClose = accountCloseDialog(
  () => current,
  (message) => {
    const notice = container.querySelector(".notice");
    if (notice) notice.textContent = message;
  },
);
const whatsappLogo =
  '<img class="platform-logo" src="assets/whatsapp.svg" alt="" aria-hidden="true" draggable="false" />';
const sidebar = createAccountSidebar(
  () => current,
  (platform) => void accountForm.open(platform),
  action,
);
function render(state: ViewState) {
  const wasLoggedIn = current?.loggedIn;
  current = state;
  const activeCloud = state.accounts.find(
    (a) =>
      a.id === state.activeId &&
      a.connectionType === "cloud" &&
      a.available &&
      !a.paused &&
      !a.hidden,
  );
  if (cloud && (!state.loggedIn || activeCloud?.id !== cloud.id)) {
    cloud.widget.dispose();
    cloud = undefined;
  }
  if (!state.loggedIn) {
    void sidebar.dismiss().catch(() => {});
    tools?.widget.dispose();
    tools = undefined;
    void accountClose.dismiss().catch(() => {});
    cloudCustomer = undefined;
    void accountForm.dismiss().catch(() => {});
    if (wasLoggedIn === false && container.querySelector("#login-code")) {
      const error = container.querySelector(".error")!;
      error.textContent = state.message;
      return;
    }
    container.innerHTML = `<main class="login-wrap"><form class="login"><div class="brand"><span class="mark">D1</span>D1 Scrm</div><h1>使用登录码开始工作</h1><p class="muted">输入管理员分配的长期登录码。平台账号将保存在这台设备的独立环境中。</p><label for="login-code">登录码</label><input id="login-code" type="password" autocomplete="off" placeholder="GD7-…" required/><button class="primary" type="submit">进入工作台</button><div class="error" role="alert">${escape(state.message)}</div><p class="muted">首次使用请联系管理员获取登录码。</p></form></main>`;
    const form = container.querySelector("form")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      const button = form.querySelector("button")!;
      button.disabled = true;
      button.textContent = "正在验证…";
      try {
        await window.gongdan.login((form.querySelector("#login-code") as HTMLInputElement).value);
      } catch (err) {
        form.querySelector(".error")!.textContent = String((err as Error).message).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        );
      } finally {
        busy = false;
        button.disabled = false;
        button.textContent = "进入工作台";
      }
    });
    return;
  }
  const hasPlatforms = state.platforms.length > 0;
  const hasNativePlatforms = state.platforms.some((p) => p.id !== "whatsapp_cloud");
  const reconnecting = state.connection !== "online";
  const identityPending = state.activeId && state.statuses[state.activeId] === "identity_pending";
  const emptyTitle = identityPending
    ? "正在识别登录账号"
    : reconnecting
      ? "登录已保留，正在恢复连接"
      : !hasPlatforms
        ? "尚未分配可用平台"
        : state.accounts.length
          ? "打开账号，开始工作"
          : hasNativePlatforms
            ? "添加账号，开始工作"
            : "等待分配 API 号码";
  const emptyHelp = identityPending
    ? "识别完成后自动打开聊天。若长时间未恢复，请点击上方重新加载账号。"
    : reconnecting
      ? "无需重新输入登录码，连接恢复后会自动同步账号。已打开的聊天页面会继续保留。"
      : !hasPlatforms
        ? "请管理员在网站的登录码设置中勾选可用平台，再点击刷新。"
        : state.accounts.length
          ? "从左侧选择账号开始工作。普通账号打开官方网页，API 号码直接进入在线聊天，两种模式都支持翻译。"
          : hasNativePlatforms
            ? "点击左侧“添加账号”，选择已授权的平台与代理，在官方页面登录。"
            : "请管理员在 WhatsApp API 号码管理中，将号码分配给当前登录码。";
  const shellMarkup = `<header class="topbar"><div class="brand">工作台 <span class="badge">客户端</span></div><span class="notice">${escape(state.message)}</span>${state.billing ? `<span class="billing-status ${state.billing.status === "normal" ? "" : "billing-low"}">剩余 ${escape(String(Number(state.billing.points)))} 点 · ${state.billing.status === "grace" ? `缓冲中，剩余 ${state.billing.graceDaysRemaining} 天 · 请联系平台充值` : state.billing.status === "low" ? "点数不足，请联系平台充值" : "翻译免费"}</span>` : ""}<span class="muted">${state.activeId && !activeCloud ? '<button class="text-btn" id="reload">重新加载账号</button>' : ""}原生平台 / 官方 API · 翻译</span></header><div class="workspace">${sidebar.markup(state)}<main class="empty"><div><span class="wa">${whatsappLogo}</span><h2>${emptyTitle}</h2><p class="muted">${emptyHelp}</p><p class="muted">登录资料仅保存在本机，切换账号不会共享 Cookie。</p></div></main></div>`;
  // Keep the mounted chat in place across heartbeat updates. Detaching it would
  // reset scroll/focus and remove an open template dialog from the modal layer.
  const keepCloud = !!activeCloud && !!cloud && cloud.host.isConnected;
  if (container.querySelector(".workspace")) {
    const updated = document.createElement("div");
    updated.innerHTML = shellMarkup;
    container.querySelector(".topbar")!.replaceWith(updated.querySelector(".topbar")!);
    const oldSidebar = container.querySelector<HTMLElement>(".account-sidebar")!;
    const scrollTop = oldSidebar.querySelector(".account-list")!.scrollTop;
    const focused = document.activeElement as HTMLElement | null;
    const focusAttribute =
      focused && oldSidebar.contains(focused)
        ? ["id", "data-id", "data-close-id", "data-add-platform", "data-fold"].find((name) =>
            focused.hasAttribute(name),
          )
        : undefined;
    const focusSelector = focusAttribute
      ? `[${focusAttribute}="${CSS.escape(focused!.getAttribute(focusAttribute)!)}"]`
      : undefined;
    const nextSidebar = updated.querySelector<HTMLElement>(".account-sidebar")!;
    oldSidebar.replaceWith(nextSidebar);
    nextSidebar.querySelector(".account-list")!.scrollTop = scrollTop;
    if (focusSelector)
      nextSidebar.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
    if (!keepCloud)
      container.querySelector(".workspace > main")!.replaceWith(updated.querySelector("main")!);
  } else container.innerHTML = shellMarkup;
  if (activeCloud && !keepCloud) {
    const main = container.querySelector<HTMLElement>("main.empty")!;
    main.className = "cloud-client-content";
    main.replaceChildren();
    if (!cloud) {
      const host = document.createElement("div");
      host.className = "cloud-client-widget";
      const id = activeCloud.id;
      cloud = {
        id,
        host,
        widget: mountCloudChat(
          host,
          {
            request: <T>(path: string, body?: unknown) =>
              window.gongdan.cloudRequest<T>(id, path, body),
          },
          {
            onCustomerChange: (chat) => {
              cloudCustomer = chat
                ? { accountId: id, identifier: chat.customerId, name: chat.name, chatId: chat.id }
                : undefined;
              if (current?.loggedIn) updateTools(current);
            },
          },
        ),
      };
    }
    main.append(cloud.host);
  }
  if (!activeCloud) cloudCustomer = undefined;
  updateTools(state);
  sidebar.bind(container.querySelector<HTMLElement>(".account-sidebar")!);
  container.querySelectorAll<HTMLButtonElement>("[data-close-id]").forEach((button) =>
    button.addEventListener("click", () => {
      const account = current.accounts.find((a) => a.id === button.dataset.closeId);
      if (account) void accountClose.open(account);
    }),
  );
  container
    .querySelectorAll<HTMLButtonElement>("[data-restore-id]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        action(() => window.gongdan.open(button.dataset.restoreId!)),
      ),
    );
  container.querySelector("#add-account")!.addEventListener("click", () => void accountForm.open());
  container
    .querySelectorAll<HTMLButtonElement>("[data-id]")
    .forEach((button) =>
      button.addEventListener("click", () => action(() => window.gongdan.open(button.dataset.id!))),
    );
  container
    .querySelector("#reload")
    ?.addEventListener("click", () => action(() => window.gongdan.reload()));
  container
    .querySelector("#refresh")!
    .addEventListener("click", () => action(() => window.gongdan.refresh()));
  container
    .querySelector("#logout")!
    .addEventListener("click", () => action(() => window.gongdan.logout()));
}
async function action(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    const notice = container.querySelector(".notice");
    if (notice)
      notice.textContent = (e as Error).message.replace(
        /^Error invoking remote method '[^']+': Error: /,
        "",
      );
  }
}
window.gongdan.onState(render);
void window.gongdan.state().then(render);

window.addEventListener("online", () => {
  if (current?.loggedIn) void window.gongdan.refresh().catch(() => {});
});
