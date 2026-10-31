import type { CustomerContext } from "./customer-tools.ts";
import type { Fingerprint } from "./fingerprint.ts";
export interface Account {
  paused?: boolean;
  hidden?: boolean;
  networkMode?: "system" | "proxy";
  connectionType?: "web" | "cloud";
  status?: string;
  id: string;
  label: string;
  platform: string;
  proxyHost: string;
  proxyPort: number;
  available: boolean;
  unavailableReason?:
    | "proxy_disabled"
    | "other_device"
    | "platform_not_allowed"
    | "api_disabled"
    | "";
}
export interface ProxyConfig {
  protocol: "socks5" | "http" | "https";
  host: string;
  port: number;
  username: string;
  password: string;
}
export interface AccountOptions {
  usedAccounts: number;
  platforms: { id: string; name: string }[];
  proxies: {
    id: string;
    label: string;
    protocol: string;
    host: string;
    port: number;
    group: string;
    maxAccountsPerPlatform: number;
    platformUsage: Record<string, number>;
  }[];
}
export interface NewAccount {
  fingerprint?: Fingerprint | null;
  label: string;
  platform: string;
  proxyId: string;
  requestId: string;
}
export interface NewProxy extends ProxyConfig {
  label: string;
}
export interface ClientAuth {
  accessToken: string;
  deviceId: string;
  tenantId: string;
  codeId: string;
  label: string;
  leaseSeconds: number;
}
export interface ViewState {
  teamArchiveEnabled?: boolean;
  teamArchiveError?: string;
  accountProfiles?: Record<string, { owner: string; avatar: string }>;
  billing?: { points: string; graceDaysRemaining: number; status: string };
  sidebarCollapsed?: boolean;
  customer?: CustomerContext;
  toolsCollapsed?: boolean;
  loggedIn: boolean;
  connection: "connecting" | "online" | "reconnecting";
  label: string;
  accounts: Account[];
  platforms: { id: string; name: string }[];
  activeId: string;
  message: string;
  statuses: Record<string, string>;
  apiURL: string;
}
export interface ShellAPI {
  setSidebarCollapsed(collapsed: boolean): Promise<void>;
  toolsModal(open: boolean): Promise<void>;
  toolsRequest<T>(method: string, path: string, body?: unknown): Promise<T>;
  setToolsCollapsed(collapsed: boolean): Promise<void>;
  prepareQuick(
    context: CustomerContext,
    content: { text?: string; assetId?: string },
  ): Promise<void>;
  customerTranslate(
    context: CustomerContext,
    text: string,
    language: string,
  ): Promise<{ text: string }>;
  customerLanguage(context: CustomerContext, language: string): Promise<void>;

  cloudRequest<T>(numberId: string, path: string, body?: unknown): Promise<T>;
  state(): Promise<ViewState>;
  loginPreference(): Promise<{ remember: boolean; code: string }>;
  forgetLoginCode(): Promise<void>;
  login(code: string, remember?: boolean): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  reload(): Promise<void>;
  repairAccount(id: string, resetLogin: boolean): Promise<void>;
  open(id: string): Promise<void>;
  closeAccount(id: string): Promise<void>;
  removeAccount(id: string): Promise<void>;
  accountForm(open: boolean): Promise<AccountOptions | undefined>;
  createAccount(account: NewAccount): Promise<string>;
  createProxy(proxy: NewProxy): Promise<{ id: string; options: AccountOptions }>;
  onState(fn: (s: ViewState) => void): void;
}
export const stateLabels: Record<string, string> = {
  identity_pending: "正在识别登录账号",
  loading: "加载中",
  qr_required: "等待扫码",
  ready: "账号已登录",
  unknown: "状态待确认",
  network_error: "网络异常",
  storage_error: "账号数据异常 · 点击修复登录",
  closed: "已关闭",
  proxy_disabled: "代理已禁用",
  platform_not_allowed: "平台未授权",
};
