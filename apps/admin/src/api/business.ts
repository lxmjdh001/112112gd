import { requestClient } from "#/api/request";
export const api = requestClient;
export interface PlatformOption {
  id: string;
  name: string;
  available: boolean;
}
export interface LoginCode {
  allowedPlatforms: string[];
  id: string;
  label: string;
  groupId: string;
  groupName: string;
  maskedCode: string;
  canCopy: boolean;
  enabled: boolean;
  expiresAt: string;
  maxDevices: number;
  maxAccounts: number;
  deviceCount: number;
  accountCount: number;
}
export interface LoginCodeGroup {
  id: string;
  name: string;
  codeCount: number;
}
export interface ProxyItem {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username: string;
  group: string;
  groupId: string;
  enabled: boolean;
  maxAccountsPerPlatform: number;
  platformUsage: Record<string, number>;
}
export interface ProxyGroup {
  id: string;
  name: string;
  proxyCount: number;
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
  proxy_disabled: "代理已禁用",
  platform_not_allowed: "平台未授权",
};
export const date = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
