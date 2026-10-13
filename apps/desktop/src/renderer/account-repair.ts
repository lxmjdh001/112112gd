import type { ViewState } from "../shared/types.ts";

export function accountRepairDialog(getState: () => ViewState, showError: (text: string) => void) {
  let modal: HTMLDialogElement | undefined;
  let opening = false;
  let saving = false;
  async function dismiss() {
    if (!modal) return;
    modal.close();
    modal.remove();
    modal = undefined;
    await window.gongdan.toolsModal(false);
  }
  async function open() {
    if (modal || opening) return;
    const account = getState().accounts.find((row) => row.id === getState().activeId);
    if (!account || account.connectionType === "cloud") return;
    opening = true;
    try {
      await window.gongdan.toolsModal(true);
      if (!getState().loggedIn) {
        await window.gongdan.toolsModal(false);
        return;
      }
      const d = document.createElement("dialog");
      modal = d;
      d.className = "account-dialog account-close-dialog";
      d.setAttribute("aria-labelledby", "account-repair-title");
      d.innerHTML = `<div class="dialog-heading"><h2 id="account-repair-title">修复账号登录</h2><button type="button" class="text-btn" data-cancel aria-label="关闭弹窗">×</button></div><p class="account-close-name"></p><div class="account-close-copy"><p data-copy>遇到数据库错误或页面加载异常时，可先刷新网页缓存，保留登录状态和本机聊天数据。</p><p>仅处理当前账号，后台客户记录、标签、备注和统计保留。</p></div><p class="error" role="alert"></p><div class="account-close-actions"><button class="account-repair-primary" type="button" data-cache>刷新网页缓存</button><button class="secondary" type="button" data-reset>重置本机登录…</button><button class="secondary" type="button" data-cancel autofocus>取消</button></div>`;
      d.querySelector(".account-close-name")!.textContent = account.label;
      document.body.append(d);
      const cancel = () => {
        if (!saving) void dismiss().catch((e) => showError(e.message));
      };
      d.querySelectorAll("[data-cancel]").forEach((button) =>
        button.addEventListener("click", cancel),
      );
      d.addEventListener("cancel", (event) => {
        event.preventDefault();
        cancel();
      });
      const run = async (resetLogin: boolean) => {
        if (saving) return;
        saving = true;
        d.querySelectorAll("button").forEach((button) => (button.disabled = true));
        const button = d.querySelector<HTMLButtonElement>(
          resetLogin ? "[data-reset]" : "[data-cache]",
        )!;
        button.textContent = "正在修复…";
        try {
          await window.gongdan.repairAccount(account.id, resetLogin);
          await dismiss();
        } catch (error) {
          d.querySelector(".error")!.textContent = String((error as Error).message).replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          );
          button.textContent = resetLogin ? "确认重置并重新登录" : "刷新网页缓存";
        } finally {
          saving = false;
          d.querySelectorAll("button").forEach((button) => (button.disabled = false));
        }
      };
      d.querySelector("[data-cache]")!.addEventListener("click", () => void run(false));
      let confirmed = false;
      d.querySelector<HTMLButtonElement>("[data-reset]")!.addEventListener("click", (event) => {
        if (confirmed) {
          void run(true);
          return;
        }
        confirmed = true;
        d.querySelector("h2")!.textContent = "重置此账号的本机登录？";
        d.querySelector("[data-copy]")!.textContent =
          "将清除这个账号在本机的登录资料和网页数据库，包括尚未发送的草稿，需要重新扫码或登录。其他账号不受影响。";
        d.querySelector<HTMLButtonElement>("[data-cache]")!.hidden = true;
        const button = event.currentTarget as HTMLButtonElement;
        button.textContent = "确认重置并重新登录";
        button.className = "account-danger";
        d.querySelector<HTMLButtonElement>(".account-close-actions [data-cancel]")!.focus();
      });
      d.showModal();
    } catch (error) {
      await dismiss();
      await window.gongdan.toolsModal(false);
      showError((error as Error).message);
    } finally {
      opening = false;
    }
  }
  return { open, dismiss };
}
