import { requestClient } from "#/api/request";
export const api = requestClient;
export interface LoginCode {
  id: string;
  label: string;
  maskedCode: string;
  enabled: boolean;
  expiresAt: string;
  maxDevices: number;
  maxAccounts: number;
  deviceCount: number;
  accountCount: number;
}
export interface ProxyItem {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username: string;
  group: string;
  enabled: boolean;
}
export interface Account {
  id: string;
  label: string;
  platform: string;
  codeLabel: string;
  proxyHost: string;
  proxyPort: number;
  status: string;
  deviceName: string;
  observedAt: string | null;
}
export const statusNames: Record<string, string> = {
  not_opened: "尚未打开",
  loading: "加载中",
  qr_required: "等待扫码",
  ready: "聊天页面已就绪",
  network_error: "网络异常",
  unknown: "状态待确认",
  stale: "状态已过期",
  closed: "客户端已关闭",
};
export const date = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
