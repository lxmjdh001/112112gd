export interface Account {
  id: string;
  label: string;
  platform: string;
  proxyHost: string;
  proxyPort: number;
  available: boolean;
  unavailableReason?: "proxy_disabled" | "other_device" | "";
}
export interface ProxyConfig {
  protocol: "socks5" | "http" | "https";
  host: string;
  port: number;
  username: string;
  password: string;
}
export interface AccountOptions {
  maxAccounts: number;
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
  label: string;
  platform: string;
  proxyId: string;
  requestId: string;
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
  loggedIn: boolean;
  label: string;
  accounts: Account[];
  activeId: string;
  message: string;
  statuses: Record<string, string>;
  apiURL: string;
}
export interface ShellAPI {
  state(): Promise<ViewState>;
  login(code: string, apiURL: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  reload(): Promise<void>;
  open(id: string): Promise<void>;
  accountForm(open: boolean): Promise<AccountOptions | undefined>;
  createAccount(account: NewAccount): Promise<string>;
  onState(fn: (s: ViewState) => void): void;
}
export const stateLabels: Record<string, string> = {
  loading: "加载中",
  qr_required: "等待扫码",
  ready: "网页已就绪",
  unknown: "状态待确认",
  network_error: "网络异常",
  closed: "已关闭",
  proxy_disabled: "代理已禁用",
};
