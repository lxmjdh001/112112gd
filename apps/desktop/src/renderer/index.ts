import type { ShellAPI, ViewState } from "../shared/types.ts";
import { stateLabels } from "../shared/types.ts";
import { createAccountForm } from "./account-form.ts";
declare global {
  interface Window {
    gongdan: ShellAPI;
  }
}
const container = document.querySelector<HTMLDivElement>("#app")!;
let current: ViewState;
let busy = false;
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
function render(state: ViewState) {
  const wasLoggedIn = current?.loggedIn;
  current = state;
  if (!state.loggedIn) {
    void accountForm.dismiss().catch(() => {});
    if (wasLoggedIn === false && container.querySelector("#login-code")) {
      const error = container.querySelector(".error")!;
      error.textContent = state.message;
      return;
    }
    container.innerHTML = `<main class="login-wrap"><form class="login"><div class="brand"><span class="mark">007</span>工单007</div><h1>使用登录码开始工作</h1><p class="muted">输入管理员分配的长期登录码。平台账号将保存在这台设备的独立环境中。</p><label for="login-code">登录码</label><input id="login-code" type="password" autocomplete="off" placeholder="GD7-…" required/><button class="primary" type="submit">进入工作台</button><div class="error" role="alert">${escape(state.message)}</div><details><summary>服务连接设置</summary><input id="api-url" aria-label="服务地址" value="${escape(state.apiURL)}" required/></details><p class="muted">首次使用请联系管理员获取登录码。</p></form></main>`;
    const form = container.querySelector("form")!;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      const button = form.querySelector("button")!;
      button.disabled = true;
      button.textContent = "正在验证…";
      try {
        await window.gongdan.login(
          (form.querySelector("#login-code") as HTMLInputElement).value,
          (form.querySelector("#api-url") as HTMLInputElement).value,
        );
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
  const allowedNames = state.platforms.map((p) => p.name).join("、");
  const hasPlatforms = state.platforms.length > 0;
  container.innerHTML = `<header class="topbar"><div class="brand"><span class="mark">007</span>工单007 <span class="badge">客户端</span></div><span class="notice">${escape(state.message)}</span><span class="muted">${state.activeId ? '<button class="text-btn" id="reload">重新加载账号</button>' : ""}原生平台 · 独立环境 · 翻译</span></header><div class="workspace"><aside><div class="side-title"><span>工作账号 · ${state.accounts.length}</span><button class="text-btn" id="refresh">刷新</button></div><p class="platform-grants">可用平台：${escape(allowedNames || "未分配")}</p><button class="add-account" id="add-account" ${hasPlatforms ? "" : "disabled"}>＋ 添加账号</button><div class="account-list">${state.accounts.map((a) => `<button class="account ${a.id === state.activeId ? "active" : ""}" data-id="${escape(a.id)}" ${a.available ? "" : "disabled"}><span class="wa">W</span><span><b>${escape(a.label)}</b><small>${a.available ? stateLabels[state.statuses[a.id] || ""] || "点击打开官方页面" : a.unavailableReason === "proxy_disabled" ? "代理已禁用" : a.unavailableReason === "platform_not_allowed" ? "平台未授权" : "已绑定其他设备"}</small></span></button>`).join("") || `<p class="muted">${hasPlatforms ? "点击上方添加已授权平台的账号。" : "请联系管理员为登录码勾选可用平台。"}</p>`}</div><div class="side-bottom"><span>${escape(state.label)}</span><button class="text-btn" id="logout">退出客户端</button></div></aside><main class="empty"><div><span class="wa">W</span><h2>${!hasPlatforms ? "尚未分配可用平台" : state.accounts.length ? "打开账号，开始工作" : "添加账号，开始工作"}</h2><p class="muted">${!hasPlatforms ? "请管理员在网站的登录码设置中勾选可用平台，再点击刷新。" : state.accounts.length ? "从左侧选择已授权的平台账号，在官方页面中登录。聊天右下角的翻译按钮可翻译选中文字和回复内容。" : "点击左侧“添加账号”，选择已授权的平台与代理，在官方页面登录。"}</p><p class="muted">登录资料仅保存在本机，切换账号不会共享 Cookie。</p></div></main></div>`;
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
