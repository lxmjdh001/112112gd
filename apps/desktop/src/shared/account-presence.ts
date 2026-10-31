import type { Account, ViewState } from "./types.ts";
import { observedPresence, presence } from "../../../../packages/platform/core/presence.ts";
export function accountPresence(account: Account, state: ViewState) {
  if (account.paused) return presence("offline", "账号已退出，点击重新打开");
  if (!account.available) return observedPresence(account.unavailableReason || "other_device");
  if (account.connectionType === "cloud")
    return state.connection === "online"
      ? observedPresence("api_connected")
      : presence("error", "管理服务连接恢复中，暂无法确认 API 通道");
  return observedPresence(state.statuses[account.id] || "");
}
