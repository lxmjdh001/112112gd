import type { NewProxy, ViewState } from "../shared/types.ts";
import { mountFingerprintForm } from "./fingerprint-form.ts";

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

  async function open(preferredPlatform?: string) {
    if (dialog || opening) return;
    opening = true;
    try {
      const initialOptions = await window.gongdan.accountForm(true);
      if (!initialOptions || !getState().loggedIn) {
        await window.gongdan.accountForm(false);
        return;
      }
      let options = initialOptions;
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
        <form id="account-form" hidden>
          <p class="muted">在本机打开官方登录页面，扫码或按平台提示登录后开始聊天。</p>
          <div class="account-form-body">
          <section class="account-connection" aria-label="账号与网络">
          <h3 class="account-section-title">账号与网络</h3>
          <div class="network-summary"><span id="network-summary"></span><button class="text-btn" type="button" id="change-network">更改</button></div>
          <div class="account-basics"><div><label for="account-platform">平台</label><select id="account-platform" required>${options.platforms.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join("")}</select>
          </div><div><label for="account-label">账号名称</label><input id="account-label" placeholder="例如：客服账号 01" maxlength="100" value="${escape(options.platforms[0]?.name || "平台账号")} ${getState().accounts.length + 1}" required /></div></div>
          <div id="proxy-settings" hidden>
            <div class="proxy-picker-heading"><label for="account-proxy">选择独立 IP</label><button class="text-btn" type="button" id="add-proxy">＋ 添加代理 IP</button></div><select id="account-proxy"><option value="">请选择代理 IP</option></select>
            <p class="muted" id="proxy-empty"></p>
            <p class="error" id="proxy-limit-error"></p>
          </div>
          ${!options.platforms.length ? '<p class="error">当前登录码没有可用平台，请联系管理员在登录码设置中勾选。</p>' : ""}
          </section>
          <section id="account-fingerprint" aria-label="指纹配置"></section>
          </div>
          <p class="error" role="alert" id="account-error"></p>
          <div class="dialog-actions"><button class="secondary" type="button" data-cancel>取消</button><button class="primary" type="submit">添加并登录</button></div>
        </form>
        <form id="new-proxy-form" hidden autocomplete="off">
          <p class="muted">添加自己的代理 IP，保存后自动选中，也会同步到后台代理管理。</p>
          <label for="proxy-label">代理名称（可选）</label><input id="proxy-label" maxlength="100" placeholder="例如：新加坡客服 IP" />
          <div class="proxy-fields"><div><label for="proxy-protocol">协议类型</label><select id="proxy-protocol"><option value="socks5">SOCKS5</option><option value="http">HTTP</option><option value="https">HTTPS</option></select></div><div><label for="proxy-port">端口</label><input id="proxy-port" type="number" min="1" max="65535" step="1" placeholder="例如：1080" required /></div></div>
          <label for="proxy-host">主机 / IP</label><input id="proxy-host" maxlength="253" placeholder="IP 地址或代理域名" required />
          <div class="proxy-fields"><div><label for="proxy-username">用户名（可选）</label><input id="proxy-username" maxlength="256" autocomplete="off" /></div><div><label for="proxy-password">密码（可选）</label><input id="proxy-password" type="password" maxlength="1024" autocomplete="new-password" /></div></div>
          <p class="muted">新 IP 每平台默认最多登录 1 个账号；同一 IP 沿用已有上限，可由管理员调整。需要认证时，用户名和密码请同时填写。</p>
          <p class="error" role="alert" id="new-proxy-error"></p>
          <div class="dialog-actions"><button class="secondary" type="button" id="back-to-account">返回</button><button class="primary" type="submit">保存并选择</button></div>
        </form>`;
      document.body.append(modal);
      let networkMode: "system" | "proxy" = "system";
      const form = modal.querySelector<HTMLFormElement>("#account-form")!;
      const fingerprint = mountFingerprintForm(
        modal.querySelector<HTMLElement>("#account-fingerprint")!,
      );
      const proxyForm = modal.querySelector<HTMLFormElement>("#new-proxy-form")!;
      let saving = false;
      const choice = modal.querySelector<HTMLElement>("#network-choice")!;
      const platformSelect = modal.querySelector<HTMLSelectElement>("#account-platform")!;
      if (options.platforms.some((p) => p.id === preferredPlatform)) {
        platformSelect.value = preferredPlatform!;
        modal.querySelector<HTMLInputElement>("#account-label")!.value =
          `${options.platforms.find((p) => p.id === preferredPlatform)!.name} ${getState().accounts.length + 1}`;
      }
      const proxySelect = modal.querySelector<HTMLSelectElement>("#account-proxy")!;
      const renderProxies = () => {
        const previous = proxySelect.value;
        const available = options.proxies.some(
          (proxy) =>
            (proxy.platformUsage[platformSelect.value] || 0) < proxy.maxAccountsPerPlatform,
        );
        form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled =
          !options.platforms.length || (networkMode === "proxy" && !available);
        modal.querySelector<HTMLButtonElement>("#add-proxy")!.disabled = !options.platforms.length;
        modal.querySelector("#proxy-empty")!.textContent = options.proxies.length
          ? ""
          : "暂无可用代理 IP，可点击上方“添加代理 IP”，或更改为当前电脑网络。";
        modal.querySelector("#proxy-limit-error")!.textContent =
          options.platforms.length && options.proxies.length && !available
            ? "当前平台的代理额度已用完，请添加其他 IP 或联系管理员调整代理上限。"
            : "";
        proxySelect.innerHTML =
          '<option value="">请选择代理 IP</option>' +
          options.proxies
            .map((proxy) => {
              const used = proxy.platformUsage[platformSelect.value] || 0;
              const full = used >= proxy.maxAccountsPerPlatform;
              return `<option value="${escape(proxy.id)}" ${full ? "disabled" : ""}>${escape(`${proxy.label} · ${proxy.protocol}://${proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host}:${proxy.port} · ${proxy.group || "未分组"} · ${used}/${proxy.maxAccountsPerPlatform}${full ? "（已满）" : ""}`)}</option>`;
            })
            .join("");
        if (
          [...proxySelect.options].some((option) => option.value === previous && !option.disabled)
        )
          proxySelect.value = previous;
      };
      const backToAccount = () => {
        proxyForm.hidden = true;
        form.hidden = false;
        proxyForm.reset();
        modal.querySelector("#new-proxy-error")!.textContent = "";
        modal.querySelector("#account-dialog-title")!.textContent = "添加账号";
        proxySelect.focus();
      };
      modal.querySelector("#add-proxy")!.addEventListener("click", () => {
        if (saving) return;
        form.hidden = true;
        proxyForm.hidden = false;
        modal.querySelector("#account-dialog-title")!.textContent = "添加代理 IP";
        modal.querySelector<HTMLInputElement>("#proxy-host")!.focus();
      });
      modal.querySelector("#back-to-account")!.addEventListener("click", backToAccount);
      proxyForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (saving) return;
        const value = (id: string) =>
          modal.querySelector<HTMLInputElement | HTMLSelectElement>(id)!.value;
        const error = modal.querySelector("#new-proxy-error")!;
        const protocol = value("#proxy-protocol");
        if (protocol !== "socks5" && protocol !== "http" && protocol !== "https") {
          error.textContent = "请选择有效的代理协议";
          return;
        }
        const input: NewProxy = {
          label: value("#proxy-label"),
          protocol,
          host: value("#proxy-host"),
          port: Number(value("#proxy-port")),
          username: value("#proxy-username"),
          password: value("#proxy-password"),
        };
        if (!!input.username !== !!input.password) {
          error.textContent = "用户名和密码需要同时填写";
          return;
        }
        saving = true;
        error.textContent = "";
        const controls = [
          ...modal.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
            "input,select,button",
          ),
        ];
        controls.forEach((control) => {
          control.disabled = true;
        });
        const button = proxyForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        button.textContent = "正在保存…";
        try {
          const result = await window.gongdan.createProxy(input);
          if (dialog !== modal || !getState().loggedIn) return;
          options = result.options;
          renderProxies();
          const selected = [...proxySelect.options].find((option) => option.value === result.id);
          if (selected && !selected.disabled) proxySelect.value = result.id;
          backToAccount();
          modal.querySelector("#account-error")!.textContent =
            selected && !selected.disabled
              ? ""
              : "代理已保存，但当前不可用或该平台已满，请选择其他 IP。";
        } catch (e) {
          error.textContent = message(e);
        } finally {
          saving = false;
          controls.forEach((control) => {
            control.disabled = false;
          });
          button.textContent = "保存并选择";
          renderProxies();
        }
      });
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
        let profile;
        try {
          profile = fingerprint.value();
        } catch (error) {
          modal.querySelector("#account-error")!.textContent = message(error);
          return;
        }
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
            fingerprint: profile,
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
