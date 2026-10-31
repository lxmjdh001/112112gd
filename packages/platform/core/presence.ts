export type PresenceKind = "online" | "offline" | "error";
export interface AccountPresence {
  kind: PresenceKind;
  label: string;
  reason: string;
}
const offline: Record<string, string> = {
  not_opened: "尚未打开账号",
  loading: "账号连接中",
  qr_required: "等待扫码登录",
  identity_pending: "正在识别登录账号",
  closed: "客户端已关闭",
  other_device: "已绑定其他设备",
  stale: "超过 90 秒未收到状态更新",
};
const errors: Record<string, string> = {
  network_error: "网络异常",
  storage_error: "账号数据异常，请尝试修复登录",
  unknown: "状态待确认",
  proxy_disabled: "代理已禁用",
  platform_not_allowed: "平台未授权",
  code_deleted: "登录码已删除",
  api_auth_error: "API 授权需检查",
  api_disabled: "API 已停用",
};
export function presence(kind: PresenceKind, reason: string): AccountPresence {
  return { kind, label: { online: "在线", offline: "离线", error: "异常" }[kind], reason };
}
export function observedPresence(status: string): AccountPresence {
  if (status === "ready") return presence("online", "账号已登录，可正常使用");
  if (status === "api_connected") return presence("online", "API 通道可用");
  if (offline[status]) return presence("offline", offline[status]);
  if (errors[status]) return presence("error", errors[status]);
  return status ? presence("error", "暂无法确认账号状态") : presence("offline", "尚未打开账号");
}
