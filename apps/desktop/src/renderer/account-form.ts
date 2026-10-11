import type { ViewState } from "../shared/types.ts";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const message = (error: unknown) =>
  String((error as Error).message || error).replace(
    /^Error invoking remote method '[^']+': Error: /,
    "",
  );

export function createAccountForm(getState: () => ViewState, showError: (text: string) => void) {
  let dialog: HTMLDialogElement | undefined;
  let opening = false;

  async function dismiss() {
    if (!dialog) return;
    dialog.close();
    dialog.remove();
    dialog = undefined;
    await window.gongdan.accountForm(false);
  }

  async function open() {
    if (dialog || opening) return;
    opening = true;
    try {
      const options = await window.gongdan.accountForm(true);
      if (!options || !getState().loggedIn) {
        await window.gongdan.accountForm(false);
        return;
      }
      const modal = document.createElement("dialog");
      dialog = modal;
      modal.className = "account-dialog";
      modal.setAttribute("aria-labelledby", "account-dialog-title");
      modal.innerHTML = `
        <div class="dialog-heading"><h2 id="account-dialog-title">是否设置独立 IP？</h2><button class="text-btn" type="button" data-cancel aria-label="关闭">✕</button></div>
        <div id="network-choice">
          <p class="network-intro">是否为新账号设置独立 IP？不设置就使用当前电脑网络。</p>
          <button class="primary network-default" type="button" id="use-system-network" autofocus>使用当前电脑网络（默认）</button>
          <button class="text-btn network-custom" type="button" id="use-proxy-network">设置独立 IP</button>
        </div>
        <form hidden>
          <p class="muted">在本机打开官方登录页面，扫码后开始聊天。</p>
          <div class="network-summary"><span id="network-summary"></span><button class="text-btn" type="button" id="change-network">更改</button></div>
          <label for="account-platform">平台</label><select id="account-platform" required>${options.platforms.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join("")}</select>
          <label for="account-label">账号名称</label><input id="account-label" placeholder="例如：投放 WhatsApp 01" maxlength="100" value="${escape(options.platforms[0]?.name || "平台账号")} ${getState().accounts.length + 1}" required />
          <div id="proxy-settings" hidden>
            <label for="account-proxy">选择独立 IP</label><select id="account-proxy"><option value="">请选择代理 IP</option></select>
            ${!options.proxies.length ? '<p class="error">暂无可用代理 IP，请联系管理员添加，或更改为当前电脑网络。</p>' : ""}
            <p class="error" id="proxy-limit-error"></p>
          </div>
          ${!options.platforms.length ? '<p class="error">当前登录码没有可用平台，请联系管理员在登录码设置中勾选。</p>' : ""}
          <p class="error" role="alert" id="account-error"></p>
          <div class="dialog-actions"><button class="secondary" type="button" data-cancel>取消</button><button class="primary" type="submit">添加并登录</button></div>
        </form>`;
      document.body.append(modal);
      let networkMode: "system" | "proxy" = "system";
      const form = modal.querySelector("form")!;
      const choice = modal.querySelector<HTMLElement>("#network-choice")!;
      const platformSelect = modal.querySelector<HTMLSelectElement>("#account-platform")!;
      const proxySelect = modal.querySelector<HTMLSelectElement>("#account-proxy")!;
      const renderProxies = () => {
        const previous = proxySelect.value;
        const available = options.proxies.some(
          (proxy) =>
            (proxy.platformUsage[platformSelect.value] || 0) < proxy.maxAccountsPerPlatform,
        );
        modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled =
          !options.platforms.length || (networkMode === "proxy" && !available);
        modal.querySelector("#proxy-limit-error")!.textContent =
          options.platforms.length && options.proxies.length && !available
            ? "当前平台的代理额度已用完，请选择其他代理或联系管理员调整代理上限。"
            : "";
        proxySelect.innerHTML =
          '<option value="">请选择代理 IP</option>' +
          options.proxies
            .map((proxy) => {
              const used = proxy.platformUsage[platformSelect.value] || 0;
              const full = used >= proxy.maxAccountsPerPlatform;
              return `<option value="${escape(proxy.id)}" ${full ? "disabled" : ""}>${escape(`${proxy.group || "未分组"} · ${proxy.protocol}://${proxy.host}:${proxy.port} · ${used}/${proxy.maxAccountsPerPlatform}${full ? "（已满）" : ""}`)}</option>`;
            })
            .join("");
        if (
          [...proxySelect.options].some((option) => option.value === previous && !option.disabled)
        )
          proxySelect.value = previous;
      };
      const chooseNetwork = (mode: "system" | "proxy") => {
        networkMode = mode;
        choice.hidden = true;
        form.hidden = false;
        modal.querySelector("#account-dialog-title")!.textContent = "添加账号";
        modal.querySelector("#network-summary")!.textContent =
          mode === "system" ? "当前电脑网络" : "独立 IP";
        modal.querySelector<HTMLElement>("#proxy-settings")!.hidden = mode === "system";
        proxySelect.required = mode === "proxy";
        renderProxies();
        modal.querySelector<HTMLInputElement>("#account-label")!.focus();
      };
      modal
        .querySelector("#use-system-network")!
        .addEventListener("click", () => chooseNetwork("system"));
      modal
        .querySelector("#use-proxy-network")!
        .addEventListener("click", () => chooseNetwork("proxy"));
      modal.querySelector("#change-network")!.addEventListener("click", () => {
        form.hidden = true;
        choice.hidden = false;
        modal.querySelector("#account-dialog-title")!.textContent = "是否设置独立 IP？";
        modal.querySelector<HTMLButtonElement>("#use-system-network")!.focus();
      });
      renderProxies();
      platformSelect.addEventListener("change", renderProxies);
      modal.showModal();
      let saving = false;
      const cancel = () => {
        if (!saving) void dismiss().catch((e) => showError(message(e)));
      };
      modal
        .querySelectorAll("[data-cancel]")
        .forEach((button) => button.addEventListener("click", cancel));
      modal.addEventListener("cancel", (event) => {
        event.preventDefault();
        cancel();
      });
      modal.addEventListener("click", (event) => {
        if (event.target === modal) cancel();
      });
      // A retry of this dialog's submission reuses its key, including after a timeout.
      const requestId = crypto.randomUUID();
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (saving || !options.platforms.length || (networkMode === "proxy" && !proxySelect.value))
          return;
        saving = true;
        const controls = [
          ...modal.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
            "input,select,button",
          ),
        ];
        const button = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        const error = modal.querySelector("#account-error")!;
        error.textContent = "";
        controls.forEach((control) => {
          control.disabled = true;
        });
        button.textContent = "正在添加…";
        try {
          const id = await window.gongdan.createAccount({
            label: modal.querySelector<HTMLInputElement>("#account-label")!.value,
            platform: modal.querySelector<HTMLSelectElement>("#account-platform")!.value,
            proxyId: networkMode === "proxy" ? proxySelect.value : "",
            requestId,
          });
          if (dialog !== modal || !getState().loggedIn) return;
          await dismiss();
          // Platform loading errors retain the new account for another attempt.
          try {
            await window.gongdan.open(id);
          } catch (e) {
            showError(message(e));
          }
        } catch (e) {
          error.textContent = message(e);
        } finally {
          saving = false;
          controls.forEach((control) => {
            control.disabled = false;
          });
          button.textContent = "添加并登录";
          renderProxies();
        }
      });
    } catch (e) {
      await window.gongdan.accountForm(false).catch(() => {});
      showError(message(e));
    } finally {
      opening = false;
    }
  }
  return { open, dismiss };
}
