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
      const limit = options.usedAccounts >= options.maxAccounts;
      modal.innerHTML = `<form>
        <div class="dialog-heading"><h2 id="account-dialog-title">添加账号</h2><button class="text-btn" type="button" data-cancel aria-label="关闭">✕</button></div>
        <p class="muted">在本机打开官方登录页面，扫码后开始聊天。</p>
        <p class="quota">当前登录码账号额度：${options.usedAccounts} / ${options.maxAccounts}</p>
        <label for="account-platform">平台</label><select id="account-platform" required>${options.platforms.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join("")}</select>
        <label for="account-label">账号名称</label><input id="account-label" placeholder="例如：投放 WhatsApp 01" maxlength="100" value="WhatsApp ${getState().accounts.length + 1}" required />
        <label for="account-proxy">选择代理</label><select id="account-proxy" required><option value="">请选择代理</option></select>
        ${!options.proxies.length ? '<p class="error">暂无可用代理，请联系管理员在网站“代理管理”中添加后重试。</p>' : ""}
        ${limit ? '<p class="error">账号额度已用完，请联系管理员调整。</p>' : ""}
        <p class="error" role="alert" id="account-error"></p>
        <div class="dialog-actions"><button class="secondary" type="button" data-cancel>取消</button><button class="primary" type="submit" ${limit || !options.proxies.length ? "disabled" : ""}>添加并登录</button></div>
      </form>`;
      document.body.append(modal);
      const platformSelect = modal.querySelector<HTMLSelectElement>("#account-platform")!;
      const proxySelect = modal.querySelector<HTMLSelectElement>("#account-proxy")!;
      const renderProxies = () => {
        const previous = proxySelect.value;
        proxySelect.innerHTML =
          '<option value="">请选择代理</option>' +
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
      const form = modal.querySelector("form")!;
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (saving) return;
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
            proxyId: modal.querySelector<HTMLSelectElement>("#account-proxy")!.value,
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
