import { observedPresence } from "../../../../packages/platform/core/presence";
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
  connectionType?: "web" | "cloud";
  id: string;
  label: string;
  platform: string;
  codeLabel: string;
  networkMode?: "system" | "proxy";
  proxyHost: string;
  proxyPort: number;
  status: string;
  deviceName: string;
  observedAt: string | null;
}
export { observedPresence } from "../../../../packages/platform/core/presence";
export function accountListStatus(row: Account, now = Date.now()) {
  const observed = row.observedAt ? Date.parse(row.observedAt) : NaN;
  const expired = row.status === "ready" && (!Number.isFinite(observed) || now - observed > 90_000);
  return observedPresence(expired ? "stale" : row.status);
}
export const date = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
