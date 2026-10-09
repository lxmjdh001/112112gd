export interface Account {
  id: string;
  label: string;
  platform: string;
  proxyHost: string;
  proxyPort: number;
  available: boolean;
}
export interface ProxyConfig {
  protocol: "socks5" | "http" | "https";
  host: string;
  port: number;
  username: string;
  password: string;
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
  onState(fn: (s: ViewState) => void): void;
}
export const stateLabels: Record<string, string> = {
  loading: "加载中",
  qr_required: "等待扫码",
  ready: "网页已就绪",
  unknown: "状态待确认",
  network_error: "网络异常",
  closed: "已关闭",
};
