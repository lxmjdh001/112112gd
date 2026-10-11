import type { Account, ViewState } from "../shared/types.ts";

export function accountCloseDialog(getState: () => ViewState, showError: (text: string) => void) {
  let modal: HTMLDialogElement | undefined;
  let opening = false,
    saving = false;
  async function dismiss() {
    if (!modal) return;
    modal.close();
    modal.remove();
    modal = undefined;
    await window.gongdan.toolsModal(false);
  }
  async function open(account: Account) {
    if (modal || opening) return;
    opening = true;
    try {
      const remove = !!account.paused,
        cloud = account.connectionType === "cloud";
      await window.gongdan.toolsModal(true);
      if (!getState().loggedIn) {
        await window.gongdan.toolsModal(false);
        return;
      }
      const title = remove
        ? cloud
          ? "从客户端移除"
          : "移除号位"
        : cloud
          ? "关闭 API 聊天"
          : "退出登录账号";
      const d = document.createElement("dialog");
      modal = d;
      d.className = "account-dialog account-close-dialog";
      d.setAttribute("aria-labelledby", "account-close-title");
      const details = remove
        ? cloud
          ? "<p>确认从当前客户端移除这个 API 号码吗？</p><ul><li>号码将从本设备的账号栏隐藏。</li><li>后台号码、登录码分配和其他客户端不受影响，后台仍会接收消息。</li><li>历史聊天、客户标签和备注保留；可从“已移除的 API 号码”重新添加。</li></ul>"
          : "<p>确认移除这个号位吗？移除后：</p><ul><li>本机该账号的登录资料、Cookie 和缓存将被清除，无法恢复。</li><li>号位从账号列表移除，释放其代理 IP 占用。</li><li>重新添加会创建新号位，需要重新扫码；团队客户记录、标签和备注保留。</li></ul><p>如果只是暂时不用，请取消并保留灰色账号，下次点击即可重新打开。</p>"
        : cloud
          ? "<p>确认关闭这个 API 号码的聊天吗？</p><ul><li>当前聊天会关闭，账号在左侧变灰。</li><li>后台继续接收消息，客户记录、标签和备注保留。当前未发送的聊天草稿会清空。</li><li>点击灰色账号即可重新打开；再次点击 × 才会进入移除确认。</li></ul>"
          : "<p>确认退出这个聊天账号吗？退出后：</p><ul><li>该账号的聊天页面会关闭，账号在左侧变灰。</li><li>保留本机登录资料、客户记录、标签和备注。</li><li>点击灰色账号即可重新打开；平台授权仍有效时无需重新扫码。</li></ul><p>账号与代理 IP 的绑定保留。再次点击灰色账号的 ×，可确认移除号位。</p>";
      d.innerHTML = `<div class="dialog-heading"><h2 id="account-close-title"></h2><button type="button" class="text-btn" data-cancel aria-label="关闭弹窗">×</button></div><p class="account-close-name"></p><div class="account-close-copy">${details}</div><p class="error" role="alert"></p><div class="account-close-actions"><button class="account-danger" type="button" data-confirm>${remove ? "确认移除" : cloud ? "确认关闭" : "确定退登"}</button><button class="secondary" type="button" data-cancel autofocus>取消</button></div>`;
      d.querySelector("h2")!.textContent = title;
      d.querySelector(".account-close-name")!.textContent = account.label;
      document.body.append(d);
      const cancel = () => {
        if (!saving) void dismiss().catch((e) => showError(String(e.message || e)));
      };
      d.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", cancel));
      d.addEventListener("cancel", (e) => {
        e.preventDefault();
        cancel();
      });
      d.addEventListener("click", (e) => {
        if (e.target === d) cancel();
      });
      d.querySelector("[data-confirm]")!.addEventListener("click", async () => {
        if (saving) return;
        saving = true;
        const controls = [...d.querySelectorAll("button")];
        controls.forEach((b) => (b.disabled = true));
        const error = d.querySelector(".error")!;
        error.textContent = "";
        try {
          const current = getState().accounts.find((a) => a.id === account.id);
          if (!current || current.hidden || !!current.paused !== remove)
            throw Error("账号状态已变化，请关闭弹窗后重试");
          if (remove) await window.gongdan.removeAccount(account.id);
          else await window.gongdan.closeAccount(account.id);
          await dismiss();
        } catch (e) {
          error.textContent = String((e as Error).message || e).replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          );
        } finally {
          saving = false;
          controls.forEach((b) => (b.disabled = false));
        }
      });
      d.showModal();
    } catch (e) {
      await window.gongdan.toolsModal(false);
      showError(String((e as Error).message || e));
    } finally {
      opening = false;
    }
  }
  return { open, dismiss };
}
