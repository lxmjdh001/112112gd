import { ChatArchiveQueue, type ArchiveBatch } from "./chat-archive-queue.ts";
import { validAccountAvatar } from "../shared/account-avatar.ts";
import { validCustomerIdentity } from "../shared/customer-identity.ts";
import { RememberedLogin } from "./remembered-login.ts";
import { InboundQueue, type InboundBatch } from "./inbound-queue.ts";
import { TranslationHistory } from "./translation-history.ts";
import type { CustomerContext, AssetContent } from "../shared/customer-tools.ts";
import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  Menu,
  clipboard,
  ClipboardItem,
  nativeImage,
  safeStorage,
  powerMonitor,
  net,
  screen,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import { readFile, writeFile, mkdir, rm, rename, readdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import type {
  Account,
  AccountOptions,
  ClientAuth,
  NewAccount,
  NewProxy,
  ProxyConfig,
  ViewState,
} from "../shared/types.ts";
import { serviceAddress } from "./service-address.ts";
import { readServiceResult, serviceConnectionError } from "./service-response.ts";
import { AccountCleanup } from "./account-cleanup.ts";
import { repairAccountStorage } from "./account-repair.ts";
import { installPlatformPermissions } from "./platform-permissions.ts";

declare const __GONGDAN_API_URL__: string;

import { FreeTranslator } from "./translation.ts";
import { chromiumUserAgent } from "./browser-identity.ts";
import { socksBridge, type Bridge } from "./proxy.ts";
import { throughSession, type ProxyAuth } from "./network.ts";
import {
  getPlatform,
  isPlatformURL,
  validAccountIdentity,
} from "../../../../packages/platform/registry.ts";
import { LINE_EXTENSION_ID } from "../../../../packages/platform/line/index.ts";
import { ensureLineComponent, LineComponentError } from "./line-component.ts";
import {
  compatibleFingerprint,
  validateFingerprint,
  type Fingerprint,
} from "../shared/fingerprint.ts";
import { applyFingerprint, FingerprintError } from "./fingerprint.ts";

// Keep the existing profile when the display name changes, including saved logins.
app.setPath(
  "userData",
  process.env.GONGDAN_USER_DATA
    ? path.resolve(process.env.GONGDAN_USER_DATA)
    : path.join(app.getPath("appData"), "@gongdan/desktop"),
);
app.setName("D1 Scrm");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
app.commandLine.appendSwitch("disable-quic");
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
const baseDir = __dirname;
const shellFile = path.join(baseDir, "index.html");
let win: BrowserWindow;
let auth: ClientAuth | undefined;
let rememberedLogin: RememberedLogin;
let loginPending = false;
let deviceIdentity = "";
let epoch = 0;
let opening = false;
let restoringAccount = "";
let accountFormOpen = false;
let creatingAccount = false;
let changingAccount = false;
let accountsRevision = 0;
let cleanup: AccountCleanup;
let quitting = false;
let readyToQuit = false;
let windowLoggedIn: boolean | undefined;
const apiURL = serviceAddress(
  (!app.isPackaged && process.env.GONGDAN_API_URL) || __GONGDAN_API_URL__,
);
const backgroundTest = !app.isPackaged && process.env.GONGDAN_E2E === "1";
const state: ViewState = {
  loggedIn: false,
  connection: "connecting",
  label: "",
  accounts: [],
  platforms: [],
  activeId: "",
  statuses: {},
  accountProfiles: {},
  message: "",
  apiURL,
  toolsCollapsed: false,
};
interface Runtime {
  owner?: string;
  archiveOwner?: string;
  inbound?: InboundQueue;
  archive?: ChatArchiveQueue;
  archiveLastSync?: number;
  fingerprintCleanup?: () => void;
  platform: string;
  customer?: CustomerContext;
  id: string;
  view: WebContentsView;
  ses: Session;
  translator: FreeTranslator;
  history: TranslationHistory;
  bridge?: Bridge;
  proxyAuth?: ProxyAuth;
  status: string;
}
const runtimes = new Map<string, Runtime>();
const runtimeClosures = new WeakMap<Runtime, Promise<void>>();
const closingAccounts = new Map<string, Promise<void>>();
// Reopening an account must reuse its outbox while an earlier upload is finishing.
const inboundQueues = new Map<string, InboundQueue>();
const archiveQueues = new Map<string, ChatArchiveQueue>();
let archivePolicyRequest: { epoch: number; promise: Promise<void> } | undefined;
const historyFile = (tenant: string, account: string) =>
  path.join(app.getPath("userData"), "translation-history", tenant, account + ".bin");
const credentialsFile = () => path.join(app.getPath("userData"), "authorization.bin");
function windowBounds(loggedIn: boolean) {
  const { workArea } = win
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(loggedIn ? 1360 : 480, workArea.width - 32);
  const height = Math.min(loggedIn ? 900 : 560, workArea.height - 32);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}
function syncWindowMode(force = false) {
  if (!win || win.isDestroyed()) return;
  const loggedIn = !!auth;
  // Only resize at the login boundary; heartbeats must preserve the user's window size.
  if (!force && windowLoggedIn === loggedIn) return;
  windowLoggedIn = loggedIn;
  if (win.isFullScreen()) {
    win.once("leave-full-screen", () => syncWindowMode(true));
    win.setFullScreen(false);
    return;
  }
  if (win.isMaximized()) {
    win.once("unmaximize", () => syncWindowMode(true));
    win.unmaximize();
    return;
  }
  const size = windowBounds(loggedIn);
  win.setResizable(loggedIn);
  win.setMaximizable(loggedIn);
  win.setFullScreenable(loggedIn);
  win.setMinimumSize(
    loggedIn ? Math.min(960, size.width) : size.width,
    loggedIn ? Math.min(640, size.height) : size.height,
  );
  win.setBounds(size);
}
function emit() {
  state.customer = runtimes.get(state.activeId)?.customer;
  state.loggedIn = !!auth;
  state.apiURL = apiURL;
  if (win && !win.isDestroyed()) {
    syncWindowMode();
    win.webContents.send("shell:state", state);
  }
}
function requireShell(event: IpcMainInvokeEvent) {
  if (event.sender !== win.webContents || event.senderFrame?.url !== pathToFileURL(shellFile).href)
    throw new Error("请求来源无效");
}
function requireRuntime(event: {
  sender: Electron.WebContents;
  senderFrame: Electron.WebFrameMain | null;
}) {
  const runtime = [...runtimes.values()].find((r) => r.view.webContents === event.sender);
  if (
    quitting ||
    !runtime ||
    event.senderFrame !== event.sender.mainFrame ||
    !isPlatformURL(runtime.platform, event.senderFrame?.url || "") ||
    !auth
  )
    throw new Error("账号授权不可用");
  return runtime;
}
async function request<T>(
  route: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const requestAuth = auth;
  // Chromium follows the OS proxy and certificate settings, unlike Node's fetch.
  // Account-specific proxies live in separate sessions and must not affect login.
  const res = await net
    .fetch(apiURL + "/api/v1" + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `D1scrm-desktop/${app.getVersion()} (${process.platform}; ${process.arch})`,
        ...(requestAuth ? { Authorization: "Bearer " + requestAuth.accessToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(route.includes("/whatsapp-cloud/") ? 30000 : 10000),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    })
    .catch((error) => {
      throw serviceConnectionError(error, apiURL);
    });
  // A confirmed revocation is different from an unreachable management service.
  if (res.status === 401 && auth && auth === requestAuth)
    await terminate("登录权限已失效，请联系管理员或重新输入登录码");
  const result = await readServiceResult<T>(res);
  if (res.status === 402 && auth && auth === requestAuth)
    await terminate(result.message || "点数不足且缓冲已到期，请联系平台充值后重新登录");
  if (!res.ok) {
    throw new Error(result.message || "请求未完成");
  }
  return result.data;
}
let saving = Promise.resolve();
function saveAuth() {
  const generation = epoch;
  const pending = saving
    .catch(() => {})
    .then(async () => {
      if (!auth || generation !== epoch || !safeStorage.isEncryptionAvailable()) return;
      const encrypted = safeStorage.encryptString(
        JSON.stringify({
          apiURL,
          auth,
          accounts: state.accounts,
          accountProfiles: state.accountProfiles,
          platforms: state.platforms,
          activeId: state.activeId || restoringAccount,
          toolsCollapsed: state.toolsCollapsed,
          sidebarCollapsed: state.sidebarCollapsed,
        }),
      );
      const temporary = credentialsFile() + ".tmp";
      await writeFile(temporary, encrypted, { mode: 0o600 });
      if (!auth || generation !== epoch) {
        await rm(temporary, { force: true });
        return;
      }
      await rename(temporary, credentialsFile());
    });
  saving = pending;
  return pending;
}
function persistSession() {
  void saveAuth().catch(() => {
    if (auth) {
      state.message = "登录状态暂未保存到本机，请检查磁盘可用空间";
      emit();
    }
  });
}
function closeRuntime(runtime: Runtime): Promise<void> {
  const previous = runtimeClosures.get(runtime);
  if (previous) return previous;
  const current = runtimes.get(runtime.id);
  if (current && current !== runtime) return Promise.resolve();
  const closing = (async () => {
    runtimes.delete(runtime.id);
    runtime.translator.clear();
    if (!runtime.view.webContents.isDestroyed()) {
      runtime.view.webContents.stop();
      runtime.view.webContents.close();
    }
    runtime.fingerprintCleanup?.();
    await runtime.history.close().catch(() => {});
    await runtime.ses.setProxy({
      mode: "fixed_servers",
      proxyRules: "http://127.0.0.1:9",
      proxyBypassRules: "<-loopback>",
    });
    await runtime.ses.closeAllConnections();
    await runtime.bridge?.close();
  })().finally(() => {
    if (closingAccounts.get(runtime.id) === closing) closingAccounts.delete(runtime.id);
  });
  runtimeClosures.set(runtime, closing);
  closingAccounts.set(runtime.id, closing);
  return closing;
}
async function terminate(message: string) {
  epoch++;
  auth = undefined;
  restoringAccount = "";
  state.connection = "connecting";
  accountFormOpen = false;
  state.label = "";
  state.accounts = [];
  state.platforms = [];
  state.activeId = "";
  state.statuses = {};
  state.accountProfiles = {};
  state.teamArchiveEnabled = false;
  state.teamArchiveError = "";
  state.billing = undefined;
  state.message = message;
  await Promise.allSettled([...runtimes.values()].map(closeRuntime));
  // Serialize removal after pending writes so logout cannot resurrect saved credentials.
  saving = saving.catch(() => {}).then(() => rm(credentialsFile(), { force: true }));
  await saving;
  emit();
}
function bounds() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const sidebarWidth = state.sidebarCollapsed ? 76 : 280;
  for (const runtime of runtimes.values()) {
    const selected = runtime.id === state.activeId && !accountFormOpen;
    const pending = runtime.status === "identity_pending";
    // Telegram's bootstrap uses animation frames before publishing its owner.
    // A hidden pending view must keep progressing; restore throttling as soon
    // as ownership is known or the user switches away from the account.
    runtime.view.webContents.setBackgroundThrottling(!(selected && pending));
    const active = selected && !pending;
    runtime.view.setVisible(active);
    if (active)
      runtime.view.setBounds({
        x: sidebarWidth,
        y: 58,
        width: Math.max(0, width - sidebarWidth - (state.toolsCollapsed ? 42 : 330)),
        height: Math.max(0, height - 58),
      });
  }
}
let refreshing: { epoch: number; promise: Promise<void> } | undefined;
function refresh() {
  if (changingAccount) return Promise.resolve();
  if (!refreshing || refreshing.epoch !== epoch) {
    const pending = { epoch, promise: Promise.resolve() };
    pending.promise = syncAccounts().finally(() => {
      if (refreshing === pending) refreshing = undefined;
    });
    refreshing = pending;
  }
  return refreshing.promise;
}
async function syncAccounts() {
  const generation = epoch;
  const revision = accountsRevision;
  const [accounts, platforms] = await Promise.all([
    request<Account[]>("/client/accounts"),
    request<ViewState["platforms"]>("/client/platforms"),
  ]);
  if (!auth || generation !== epoch || revision !== accountsRevision) return;
  state.accounts = accounts;
  state.platforms = platforms;
  const allowed = new Set(
    accounts
      .filter((account) => account.available && !account.paused && !account.hidden)
      .map((account) => account.id),
  );
  if (state.activeId && !allowed.has(state.activeId)) state.activeId = "";
  if (restoringAccount && !allowed.has(restoringAccount)) restoringAccount = "";
  for (const runtime of [...runtimes.values()]) {
    if (!allowed.has(runtime.id)) {
      await closeRuntime(runtime);
      if (generation !== epoch || !auth) return;
      if (state.activeId === runtime.id) state.activeId = "";
    }
  }
  for (const id of Object.keys(state.accountProfiles || {})) {
    if (!allowed.has(id)) delete state.accountProfiles![id];
  }
  for (const account of accounts) {
    if (
      account.unavailableReason === "proxy_disabled" ||
      account.unavailableReason === "platform_not_allowed"
    )
      state.statuses[account.id] = account.unavailableReason;
    else if (["proxy_disabled", "platform_not_allowed"].includes(state.statuses[account.id] || ""))
      delete state.statuses[account.id];
  }
  if (!changingAccount) {
    try {
      await cleanup.reconcile(auth.tenantId, auth.codeId, new Set(accounts.map((a) => a.id)));
    } catch {
      state.message = "已移除账号的本机数据清理未完成，将自动重试";
    }
  }
  bounds();
  persistSession();
  emit();
}
let beating: { epoch: number; promise: Promise<void> } | undefined;
function heartbeat(): Promise<void> {
  if (!auth || quitting) return Promise.resolve();
  if (beating?.epoch === epoch) return beating.promise;
  const pending = { epoch, promise: Promise.resolve() };
  pending.promise = reconnect().finally(() => {
    if (beating === pending) beating = undefined;
  });
  beating = pending;
  return pending.promise;
}
async function refreshArchivePolicy() {
  if (!auth || quitting) return;
  if (archivePolicyRequest?.epoch === epoch) return archivePolicyRequest.promise;
  const generation = epoch,
    tenant = auth.tenantId,
    device = auth.deviceId;
  const item = { epoch: generation, promise: Promise.resolve() };
  item.promise = (async () => {
    try {
      const policy = await request<{ enabled: boolean }>("/client/team-settings");
      if (!auth || generation !== epoch) return;
      const changed = state.teamArchiveEnabled !== policy.enabled;
      state.teamArchiveEnabled = policy.enabled;
      state.teamArchiveError = "";
      if (changed)
        for (const runtime of runtimes.values())
          if (!runtime.view.webContents.isDestroyed())
            runtime.view.webContents.send("team:archive-policy", { enabled: policy.enabled });
      emit();
      if (!policy.enabled) {
        const stillDisabled = () =>
          auth?.tenantId === tenant &&
          auth?.deviceId === device &&
          generation === epoch &&
          !state.teamArchiveEnabled;
        const owned = [...archiveQueues.entries()].filter(([key]) =>
          key.startsWith(tenant + ":" + device + ":"),
        );
        const discarded = await Promise.allSettled(owned.map(([, queue]) => queue.discard()));
        if (!stillDisabled()) return;
        const directory = path.join(app.getPath("userData"), "chat-archive", tenant, device);
        const retained = new Set(
          owned.map(([key]) => key.slice((tenant + ":" + device + ":").length) + ".bin"),
        );
        for (const file of await readdir(directory).catch(() => [])) {
          if (!stillDisabled()) return;
          if (/^[0-9a-f-]{36}\.bin$/.test(file) && !retained.has(file))
            await rm(path.join(directory, file), { force: true });
        }
        if (discarded.some((result) => result.status === "rejected") && generation === epoch) {
          state.teamArchiveError = "聊天同步已关闭，部分本机待同步记录清理失败";
          emit();
        }
      }
      if (!auth || generation !== epoch) return;
    } catch {
      /* Older or unavailable services do not affect account login. */
    }
  })().finally(() => {
    if (archivePolicyRequest === item) archivePolicyRequest = undefined;
  });
  archivePolicyRequest = item;
  return item.promise;
}
async function reconnect() {
  const generation = epoch;
  try {
    await request("/client/heartbeat", {});
    if (auth && epoch === generation) {
      await refresh();
      if (!auth || epoch !== generation) return;
      state.billing = await request<ViewState["billing"]>("/client/billing");
      if (!auth || epoch !== generation) return;
      state.connection = "online";
      void refreshArchivePolicy();
      state.message = "";
      emit();
    }
  } catch {
    if (auth && generation === epoch) {
      state.connection = "reconnecting";
      state.message = "管理服务暂时不可达，登录已保留，正在自动重连";
      emit();
    }
    return;
  }
  if (auth && generation === epoch && restoringAccount && !opening && !accountFormOpen) {
    const id = restoringAccount;
    restoringAccount = "";
    // Restore the last selected account only after fresh server authorization.
    void openAccount(id).catch(() => {});
  }
}
async function login(code: string, remember: boolean) {
  if (opening) throw new Error("正在处理连接，请稍后");
  if (typeof code !== "string" || code.length < 10 || code.length > 100)
    throw new Error("请输入完整登录码");
  if (!remember) await rememberedLogin.save(null);
  await terminate("");
  const generation = epoch;
  const result = await request<ClientAuth>("/client/auth", {
    code: code.trim(),
    deviceId: deviceIdentity,
    deviceName: hostname(),
  });
  if (epoch !== generation) return;
  let rememberWarning = "";
  if (remember) {
    try {
      await rememberedLogin.save(code.trim());
    } catch {
      rememberWarning = "登录成功，但登录码未能保存到本机，请检查系统加密存储和磁盘空间";
    }
  }
  if (epoch !== generation) return;
  auth = result;
  state.label = result.label;
  state.connection = "connecting";
  state.message = "正在同步工作台…";
  persistSession();
  emit();
  await heartbeat();
  if (rememberWarning && auth && epoch === generation) {
    state.message = rememberWarning;
    emit();
  }
}
async function updateStatus(runtime: Runtime, status: string, identifier?: string | null) {
  if (runtimes.get(runtime.id) !== runtime || !auth) return;
  const generation = epoch;
  if (runtime.status === "ready" && status !== "ready") runtime.archiveLastSync = undefined;
  const profile = state.accountProfiles?.[runtime.id];
  if (status === "qr_required" || (status === "ready" && profile && profile.owner !== identifier)) {
    delete state.accountProfiles?.[runtime.id];
    persistSession();
  }
  if (status === "ready" && !validAccountIdentity(runtime.platform, identifier)) {
    runtime.owner = undefined;
    runtime.status = "identity_pending";
    state.statuses[runtime.id] = "identity_pending";
    bounds();
    emit();
    return;
  }
  runtime.owner = status === "ready" && identifier ? identifier : undefined;
  runtime.status = status;
  state.statuses[runtime.id] = status;
  bounds();
  emit();
  try {
    await request(`/client/accounts/${runtime.id}/status`, {
      status: status === "storage_error" ? "unknown" : status,
      identifier,
    });
  } catch (error) {
    if (
      auth &&
      generation === epoch &&
      runtimes.get(runtime.id) === runtime &&
      status === "ready" &&
      String(error).includes("公司累计 3 天缓冲已用完")
    ) {
      await request(`/client/accounts/${runtime.id}/close`, {}).catch(() => {});
      if (!auth || generation !== epoch || runtimes.get(runtime.id) !== runtime) return;
      await closeRuntime(runtime);
      if (state.activeId === runtime.id) state.activeId = "";
      state.message = (error as Error).message;
      await refresh();
      emit();
    }
    /* Heartbeat controls authorization; failed observations never erase platform login. */
  }
}
async function openAccount(id: string) {
  if (opening || changingAccount) throw new Error("正在处理账号，请稍后");
  if (!auth) throw new Error("请先登录客户端");
  const account = state.accounts.find((x) => x.id === id);
  if (!account || !account.available) throw new Error("账号不可用或已被其他设备绑定");
  if (account.connectionType === "cloud") {
    opening = true;
    try {
      const generation = epoch;
      if (account.paused || account.hidden) await request(`/client/accounts/${id}/restore`, {});
      await request(`/client/whatsapp-cloud/numbers/${id}/chats?offset=0`);
      if (!auth || generation !== epoch) return;
      accountsRevision++;
      for (const row of state.accounts)
        if (row.id === id) {
          row.paused = false;
          row.hidden = false;
        }
      state.activeId = id;
      restoringAccount = "";
      persistSession();
      bounds();
      emit();
      return;
    } finally {
      opening = false;
    }
  }
  if (runtimes.has(id)) {
    state.activeId = id;
    restoringAccount = "";
    persistSession();
    bounds();
    emit();
    return;
  }
  const adapter = getPlatform(account.platform);
  opening = true;
  const generation = epoch;
  let bridge: Bridge | undefined;
  let runtime: Runtime | undefined;
  try {
    // A previous view may still be releasing this partition's proxy/connections.
    await closingAccounts.get(id);
    if (generation !== epoch || !auth) return;
    let lineDirectory: string | undefined;
    if (account.platform === "line") {
      state.message = "正在准备 LINE 登录组件，首次打开可能需要下载…";
      emit();
      lineDirectory = await ensureLineComponent(app.getPath("userData"), (url) =>
        net.fetch(url, { signal: AbortSignal.timeout(90000) }),
      );
      if (generation !== epoch || !auth) return;
      state.message = "";
    }
    const settings = await request<{
      id: string;
      tenantId: string;
      networkMode: "system" | "proxy";
      proxy: ProxyConfig | null;
      fingerprint?: Fingerprint | null;
    }>(`/client/accounts/${id}/open`, {});
    if (generation !== epoch || !auth) return;
    accountsRevision++;
    for (const row of state.accounts) if (row.id === id) row.paused = false;
    const p = settings.proxy;
    const fingerprint = compatibleFingerprint(settings.fingerprint, process.versions.chrome);
    const ses = session.fromPartition(`persist:gd7-${settings.tenantId}-${id}`);
    if (lineDirectory && !ses.extensions.getExtension(LINE_EXTENSION_ID)) {
      const extension = await ses.extensions.loadExtension(lineDirectory);
      if (extension.id !== LINE_EXTENSION_ID)
        throw new LineComponentError("LINE 登录组件身份校验失败");
    }
    const browserUA =
      fingerprint?.userAgent || chromiumUserAgent(app.userAgentFallback, app.getName());
    ses.setUserAgent(browserUA, fingerprint?.language);
    ses.webRequest.onBeforeRequest((_details, callback) =>
      callback({ cancel: !runtimes.has(id) || !auth }),
    );
    let proxyAuth: ProxyAuth | undefined;
    if (p) {
      let { host, port, username, password, protocol } = p;
      if (protocol === "socks5") {
        bridge = await socksBridge(p);
        host = "127.0.0.1";
        port = bridge.port;
        username = bridge.username;
        password = bridge.password;
        protocol = "http";
      }
      await ses.setProxy({
        mode: "fixed_servers",
        proxyRules: `${protocol}://${host.includes(":") ? "[" + host + "]" : host}:${port}`,
        proxyBypassRules: "<-loopback>",
      });
      proxyAuth = { host, port, username, password };
    } else if (settings.networkMode === "system") {
      // Explicitly reset persisted sessions to the current OS network settings.
      await ses.setProxy({ mode: "system" });
    } else {
      throw new Error("账号网络配置无效，请刷新后重试");
    }
    await ses.closeAllConnections();
    installPlatformPermissions(ses, adapter.allowedOrigins);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: path.join(baseDir, adapter.preload),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    runtime = {
      platform: account.platform,
      id,
      view,
      ses,
      bridge,
      proxyAuth,
      status: "loading",
      history: new TranslationHistory(
        historyFile(auth!.tenantId, id),
        (value) => {
          if (!safeStorage.isEncryptionAvailable()) throw Error("本机加密存储不可用");
          return safeStorage.encryptString(value);
        },
        (value) => safeStorage.decryptString(value),
      ),
      translator: new FreeTranslator(throughSession(ses, proxyAuth), (usage) => {
        // Free usage metadata only: never send message content to the management API.
        if (generation === epoch && auth && runtimes.has(id))
          void request("/client/usage", {
            ...usage,
            accountId: id,
            requestId: randomUUID(),
          }).catch(() => {});
      }),
    };
    if (
      generation !== epoch ||
      !auth ||
      !state.accounts.some((account) => account.id === id && account.available)
    ) {
      await closeRuntime(runtime);
      return;
    }
    runtimes.set(id, runtime);
    win.contentView.addChildView(view);
    state.activeId = id;
    restoringAccount = "";
    persistSession();
    bounds();
    emit();
    const current = runtime;
    const wc = view.webContents;
    wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    wc.setUserAgent(browserUA);
    wc.on("login", (event, _details, info, callback) => {
      event.preventDefault();
      if (
        proxyAuth &&
        _details.firstAuthAttempt &&
        info.isProxy &&
        info.host === proxyAuth.host &&
        info.port === proxyAuth.port
      )
        callback(proxyAuth.username, proxyAuth.password);
      else callback();
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (isPlatformURL(account.platform, url)) return;
      event.preventDefault();
      if (account.platform === "telegram" && new URL(url).origin === "https://web.telegram.org") {
        state.message = "每个号位只登录一个 Telegram 账号，请从 D1 Scrm 左侧添加其他账号。";
        emit();
        // Web K goes offline before switching owners; restore this slot's page.
        void wc.loadURL(adapter.homeURL).catch(() => {});
      }
    };
    wc.on("will-navigate", guardNavigation);
    wc.on("will-redirect", guardNavigation);
    wc.on("did-fail-load", (_event, code, _desc, _url, isMain) => {
      if (isMain && code !== -3) void updateStatus(current, "network_error");
    });
    wc.on("render-process-gone", () => {
      void updateStatus(current, "unknown");
    });
    wc.on("context-menu", (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [{ role: "copy" }, { role: "paste" }];
      if (params.selectionText.trim())
        items.unshift({
          label: "翻译选中文字",
          click: () => wc.send("wa:selection", params.selectionText.slice(0, 4000)),
        });
      Menu.buildFromTemplate(items).popup({ window: win });
    });
    await updateStatus(current, "loading");
    if (fingerprint) {
      current.fingerprintCleanup = await applyFingerprint(
        wc,
        fingerprint,
        adapter.allowedOrigins,
        () => {
          if (runtimes.get(id) !== current || generation !== epoch || !auth) return;
          state.message = "账号指纹配置已中断，请重新打开账号以恢复配置。";
          void closeRuntime(current).then(() => {
            if (state.activeId === id) state.activeId = "";
            bounds();
            emit();
          });
        },
      );
      if (runtimes.get(id) !== current || generation !== epoch || !auth) {
        current.fingerprintCleanup();
        return;
      }
    }
    // A stalled page must never hold the account-operation lock. Setup is done;
    // navigation continues independently and the user can switch, reload or close.
    void wc.loadURL(adapter.homeURL).catch((error) => {
      if (runtimes.get(id) !== current || generation !== epoch || !auth || wc.isDestroyed()) return;
      if (error?.code === "ERR_ABORTED" || error?.errno === -3) return;
      void updateStatus(current, "network_error");
      if (state.activeId === id) {
        state.message = "账号页面加载失败，可重新加载或关闭账号后重试";
        emit();
      }
    });
  } catch (error) {
    if (runtime && runtimes.get(id) === runtime) {
      await updateStatus(runtime, "network_error");
      await closeRuntime(runtime);
    } else await bridge?.close();
    if (generation !== epoch || !auth) return;
    if (state.activeId === id) state.activeId = "";
    bounds();
    state.message =
      error instanceof LineComponentError || error instanceof FingerprintError
        ? error.message
        : "账号打开失败，请检查代理地址、认证信息和网络连接后重试";
    emit();
    throw new Error(state.message);
  } finally {
    opening = false;
  }
}

app.whenReady().then(async () => {
  const applicationIcon = nativeImage.createFromPath(path.join(baseDir, "icon.png"));
  if (!applicationIcon.isEmpty()) app.dock?.setIcon(applicationIcon);
  await mkdir(app.getPath("userData"), { recursive: true });
  rememberedLogin = new RememberedLogin(
    path.join(app.getPath("userData"), "login-preferences.json"),
    apiURL,
    (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw Error("本机加密存储不可用");
      return safeStorage.encryptString(value);
    },
    (value) => safeStorage.decryptString(value),
  );
  cleanup = new AccountCleanup(
    path.join(app.getPath("userData"), "pending-account-removals.json"),
    async (tenant, id) => {
      const runtime = runtimes.get(id);
      if (runtime) await closeRuntime(runtime);
      const ses = session.fromPartition(`persist:gd7-${tenant}-${id}`);
      ses.webRequest.onBeforeRequest((_details, done) => done({ cancel: true }));
      await ses.closeAllConnections();
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
      await rm(historyFile(tenant, id), { force: true });
    },
  );
  await cleanup.load();
  const devicePath = path.join(app.getPath("userData"), "installation-id");
  try {
    deviceIdentity = (await readFile(devicePath, "utf8")).trim();
  } catch {
    deviceIdentity = randomBytes(32).toString("hex");
    await writeFile(devicePath, deviceIdentity, { mode: 0o600 });
  }
  win = new BrowserWindow({
    icon: applicationIcon,
    ...windowBounds(false),
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: backgroundTest ? "D1 Scrm · 自动测试" : "D1 Scrm 客户端",
    show: false,
    skipTaskbar: backgroundTest,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: path.join(baseDir, "shell-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  syncWindowMode();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("did-start-loading", () => {
    accountFormOpen = false;
    bounds();
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("resize", bounds);
  win.on("closed", () => app.quit());
  ipcMain.handle("shell:state", (event) => {
    requireShell(event);
    return state;
  });
  ipcMain.handle("shell:cloud-request", async (event, numberId, route, body) => {
    requireShell(event);
    if (
      !auth ||
      typeof numberId !== "string" ||
      typeof route !== "string" ||
      !state.accounts.some(
        (a) =>
          a.id === numberId &&
          a.connectionType === "cloud" &&
          a.available &&
          !a.paused &&
          !a.hidden,
      )
    )
      throw Error("API 号码未授权");
    const parsed = new URL(route, "https://cloud.invalid");
    const uuid = "[0-9a-f-]{36}";
    const getRoute = new RegExp(`^/(chats|templates|chats/${uuid}/messages)$`);
    const postRoute = new RegExp(
      `^/(chats|chats/${uuid}/(messages|read)|media|media/${uuid}/download|translate)$`,
    );
    if (
      parsed.origin !== "https://cloud.invalid" ||
      parsed.hash ||
      !(body === undefined ? getRoute : postRoute).test(parsed.pathname) ||
      [...parsed.searchParams.keys()].some((k) => !["before", "offset", "search"].includes(k))
    )
      throw Error("API 请求路径无效");
    const generation = epoch;
    const result = await request(
      `/client/whatsapp-cloud/numbers/${numberId}${parsed.pathname}${parsed.search}`,
      body,
    );
    if (!auth || generation !== epoch) throw Error("登录状态已变化");
    return result;
  });
  ipcMain.handle("shell:login-preference", (event) => {
    requireShell(event);
    return rememberedLogin.read();
  });
  ipcMain.handle("shell:forget-login-code", (event) => {
    requireShell(event);
    if (loginPending) throw Error("正在登录，请稍后重试");
    return rememberedLogin.save(null);
  });
  ipcMain.handle("shell:login", async (event, code, remember = false) => {
    requireShell(event);
    if (typeof remember !== "boolean") throw Error("参数无效");
    if (loginPending) throw Error("正在登录，请稍后");
    loginPending = true;
    try {
      await login(code, remember);
    } finally {
      loginPending = false;
    }
  });
  ipcMain.handle("shell:logout", async (event) => {
    requireShell(event);
    // Remove local authorization immediately even when the service cannot be reached.
    void request("/client/logout", {}).catch(() => {});
    await terminate("已退出客户端，平台登录资料保留在本机");
  });
  const changeAccount = async (event: IpcMainInvokeEvent, id: string, remove: boolean) => {
    requireShell(event);
    if (!auth) throw Error("请先登录客户端");
    if (opening || changingAccount || creatingAccount) throw Error("正在处理账号，请稍后重试");
    let account = state.accounts.find((a) => a.id === id);
    if (!account || account.hidden || account.unavailableReason === "other_device")
      throw Error("账号不属于当前客户端");
    if (remove && !account.paused) throw Error("请先退登账号，再确认移除");
    const generation = epoch,
      identity = { ...auth };
    changingAccount = true;
    let stoppedLocally = false;
    try {
      if (!remove && account.connectionType !== "cloud") {
        // Stop a stuck page immediately, even if the management API is slow.
        const runtime = runtimes.get(id);
        const closing = runtime ? closeRuntime(runtime) : closingAccounts.get(id);
        stoppedLocally = true;
        state.statuses[id] = "closed";
        if (state.activeId === id) state.activeId = "";
        if (restoringAccount === id) restoringAccount = "";
        bounds();
        persistSession();
        emit();
        await closing;
      }
      if (refreshing?.epoch === epoch) await refreshing.promise;
      if (!auth || epoch !== generation) throw Error("登录状态已变化");
      account = state.accounts.find((a) => a.id === id);
      if (!account || account.hidden || account.unavailableReason === "other_device")
        throw Error("账号不属于当前客户端");
      if (remove && !account.paused) throw Error("账号状态已变化，请重新操作");
      if (remove && account.connectionType !== "cloud")
        await cleanup.remember({
          tenantId: identity.tenantId,
          codeId: identity.codeId,
          accountId: id,
        });
      await request(`/client/accounts/${id}/${remove ? "remove" : "close"}`, {});
      if (!auth || generation !== epoch) return;
      accountsRevision++;
      const runtime = runtimes.get(id);
      if (runtime) await closeRuntime(runtime);
      account.paused = true;
      state.statuses[id] = "closed";
      if (state.activeId === id) state.activeId = "";
      if (restoringAccount === id) restoringAccount = "";
      if (remove) {
        if (account.connectionType === "cloud") account.hidden = true;
        else {
          await cleanup.finish(identity.tenantId, id);
          state.accounts = state.accounts.filter((a) => a.id !== id);
          delete state.statuses[id];
        }
      }
      await saveAuth();
      bounds();
      emit();
    } catch (error) {
      if (stoppedLocally && auth && generation === epoch)
        throw Error(`本机聊天页面已关闭，退出状态暂未同步，请重试：${(error as Error).message}`);
      throw error;
    } finally {
      changingAccount = false;
      bounds();
      emit();
    }
  };
  ipcMain.handle("shell:close-account", (event, id) => changeAccount(event, id, false));
  ipcMain.handle("shell:remove-account", (event, id) => changeAccount(event, id, true));
  ipcMain.handle("shell:repair-account", async (event, id, resetLogin) => {
    requireShell(event);
    if (typeof id !== "string" || typeof resetLogin !== "boolean") throw Error("修复参数无效");
    if (opening || changingAccount) throw Error("正在处理账号，请稍后");
    const runtime = runtimes.get(id);
    const account = state.accounts.find((row) => row.id === id && row.available && !row.paused);
    if (!auth || !runtime || !account || state.activeId !== id) throw Error("请先打开要修复的账号");
    const generation = epoch;
    changingAccount = true;
    let repairError: unknown;
    try {
      await closeRuntime(runtime);
      delete state.statuses[id];
      await repairAccountStorage(runtime.ses, resetLogin);
    } catch (error) {
      repairError = error;
    } finally {
      changingAccount = false;
      bounds();
      emit();
    }
    if (auth && generation === epoch) {
      await openAccount(id);
      if (repairError)
        throw Error("未能完成网页存储修复。已重新打开账号，请检查磁盘空间或重启客户端后重试。");
    }
  });
  ipcMain.handle("shell:reload", async (event) => {
    requireShell(event);
    const runtime = runtimes.get(state.activeId);
    if (!runtime || !auth) throw Error("没有可重新加载的账号");
    await updateStatus(runtime, "loading");
    try {
      await runtime.view.webContents.loadURL(getPlatform(runtime.platform).homeURL);
    } catch {
      await updateStatus(runtime, "network_error");
    }
  });
  ipcMain.handle("shell:refresh", async (event) => {
    requireShell(event);
    await heartbeat();
  });
  ipcMain.handle("shell:open", async (event, id) => {
    requireShell(event);
    await openAccount(id);
  });
  ipcMain.handle("shell:account-form", async (event, open) => {
    requireShell(event);
    if (open === false) {
      accountFormOpen = false;
      bounds();
      return;
    }
    if (open !== true || !auth) throw Error("请先登录客户端");
    const generation = epoch;
    const options = await request<AccountOptions>("/client/account-options");
    if (!auth || generation !== epoch) throw Error("登录状态已变化，请重试");
    accountFormOpen = true;
    bounds();
    return options;
  });
  ipcMain.handle("shell:create-proxy", async (event, input: NewProxy) => {
    requireShell(event);
    if (!auth) throw Error("请先登录客户端");
    if (creatingAccount || changingAccount) throw Error("正在处理账号，请稍后");
    if (
      !input ||
      ![input.label, input.protocol, input.host, input.username, input.password].every(
        (v) => typeof v === "string" && v.length <= 1024,
      ) ||
      !Number.isInteger(input.port) ||
      input.port < 1 ||
      input.port > 65535
    )
      throw Error("请填写有效的代理配置");
    const generation = epoch;
    creatingAccount = true;
    try {
      const result = await request<{ id: string }>("/client/proxies", {
        label: input.label,
        protocol: input.protocol,
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
      });
      if (!auth || generation !== epoch) throw Error("登录状态已变化");
      const options = await request<AccountOptions>("/client/account-options");
      if (!auth || generation !== epoch) throw Error("登录状态已变化");
      return { id: result.id, options };
    } finally {
      creatingAccount = false;
    }
  });
  ipcMain.handle("shell:create-account", async (event, input: NewAccount) => {
    requireShell(event);
    if (!auth) throw Error("请先登录客户端");
    if (creatingAccount || changingAccount) throw Error("正在处理账号，请稍后");
    if (
      !input ||
      typeof input.label !== "string" ||
      !input.label.trim() ||
      [...input.label.trim()].length > 100 ||
      typeof input.platform !== "string" ||
      typeof input.proxyId !== "string" ||
      typeof input.requestId !== "string"
    )
      throw Error("请填写账号名称并选择平台");
    getPlatform(input.platform);
    const fingerprint = validateFingerprint(input.fingerprint, process.versions.chrome);
    const generation = epoch;
    creatingAccount = true;
    try {
      const result = await request<{ id: string }>("/client/accounts", {
        label: input.label.trim(),
        platform: input.platform,
        proxyId: input.proxyId,
        requestId: input.requestId,
        fingerprint,
      });
      if (!auth || generation !== epoch) throw Error("登录状态已变化，请重新登录后查看账号");
      await refresh();
      if (!auth || generation !== epoch) throw Error("登录状态已变化，请重新登录后查看账号");
      return result.id;
    } finally {
      creatingAccount = false;
    }
  });
  for (const [channel, route] of [
    ["wa:customer-check", "/client/customers/check"],
    ["wa:conversation", "/client/conversations"],
  ] as const) {
    ipcMain.handle(channel, async (event, payload) => {
      const runtime = requireRuntime(event);
      if (
        !payload ||
        typeof payload.identifier !== "string" ||
        payload.identifier.length > 100 ||
        typeof payload.ip !== "string" ||
        payload.ip.length > 60
      )
        throw Error("客户参数无效");
      const generation = epoch;
      const result = await request(route, {
        accountId: runtime.id,
        identifier: payload.identifier,
        ip: payload.ip,
      });
      if (generation !== epoch || runtimes.get(runtime.id) !== runtime)
        throw Error("账号状态已变化");
      return result;
    });
  }
  ipcMain.handle("shell:tools-modal", (event, open) => {
    requireShell(event);
    if (typeof open !== "boolean") throw Error("参数无效");
    accountFormOpen = open;
    bounds();
  });
  ipcMain.handle("shell:tools-collapsed", (event, collapsed) => {
    requireShell(event);
    if (typeof collapsed !== "boolean") throw Error("参数无效");
    state.toolsCollapsed = collapsed;
    bounds();
    persistSession();
    emit();
  });
  ipcMain.handle("shell:sidebar-collapsed", (event, collapsed) => {
    requireShell(event);
    if (typeof collapsed !== "boolean") throw Error("参数无效");
    state.sidebarCollapsed = collapsed;
    bounds();
    persistSession();
    emit();
  });
  ipcMain.handle("shell:tools-request", async (event, method, route, body) => {
    requireShell(event);
    if (
      !auth ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      typeof route !== "string" ||
      !/^\/(assets(?:\/[0-9a-f-]{36})?|tags|customer(?:\/tag)?)$/.test(route)
    )
      throw Error("工具请求无效");
    if (body !== undefined && JSON.stringify(body).length > 7 * 1024 * 1024)
      throw Error("内容过大");
    return request("/client/tools" + route, body, method);
  });
  const nativeContext = (context: CustomerContext) => {
    const runtime = runtimes.get(context?.accountId);
    if (
      !auth ||
      !runtime ||
      state.activeId !== runtime.id ||
      !context.identifier ||
      context.identifier !== runtime.customer?.identifier ||
      runtime.view.webContents.isDestroyed()
    )
      throw Error("当前客户已切换，请重新选择");
    return runtime;
  };
  ipcMain.handle(
    "shell:customer-translate",
    async (event, context: CustomerContext, text: string, language: string) => {
      requireShell(event);
      const runtime = nativeContext(context);
      if (typeof text !== "string" || typeof language !== "string") throw Error("翻译参数无效");
      const result = await runtime.translator.translate(text, language);
      nativeContext(context);
      return result;
    },
  );
  ipcMain.handle("shell:customer-language", (event, context: CustomerContext, language: string) => {
    requireShell(event);
    const runtime = nativeContext(context);
    if (typeof language !== "string" || language.length > 16) throw Error("语言无效");
    runtime.view.webContents.send("wa:customer-language", {
      identifier: context.identifier,
      language,
    });
  });
  const composerPending = new Map<string, { runtime: Runtime; resolve: (error: string) => void }>();
  ipcMain.on("wa:composer-ready", (event, payload) => {
    try {
      const runtime = requireRuntime(event);
      const pending = composerPending.get(payload?.requestId);
      if (pending?.runtime === runtime)
        pending.resolve(typeof payload.error === "string" ? payload.error : "无效响应");
    } catch {
      /* Reject events from other web contents. */
    }
  });
  ipcMain.handle(
    "shell:prepare-quick",
    async (event, context: CustomerContext, content: { text?: string; assetId?: string }) => {
      requireShell(event);
      const runtime = nativeContext(context);
      if (!content || (typeof content.text !== "string" && typeof content.assetId !== "string"))
        throw Error("请选择图片或话术");
      let asset: AssetContent | undefined;
      if (content.assetId) {
        if (!/^[0-9a-f-]{36}$/.test(content.assetId)) throw Error("素材无效");
        asset = await request<AssetContent>("/client/tools/assets/" + content.assetId);
      }
      const text = content.text ?? asset?.body ?? "";
      if (text.length > 16000) throw Error("话术过长");
      if (asset?.kind === "image") {
        const picture = nativeImage.createFromBuffer(Buffer.from(asset.data, "base64"));
        if (picture.isEmpty()) throw Error("图片无法读取");
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(picture.toPNG())], { type: "image/png" }),
          }),
        ]);
      }
      if (nativeContext(context) !== runtime) throw Error("账号已切换");
      const requestId = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          composerPending.delete(requestId);
          reject(Error("未找到聊天输入框，请重新打开客户聊天"));
        }, 4000);
        composerPending.set(requestId, {
          runtime,
          resolve: (error) => {
            clearTimeout(timer);
            composerPending.delete(requestId);
            error ? reject(Error(error)) : resolve();
          },
        });
        runtime.view.webContents.send("wa:prepare-composer", {
          identifier: context.identifier,
          requestId,
        });
      });
      if (nativeContext(context) !== runtime) throw Error("账号已切换");
      runtime.view.webContents.focus();
      if (asset?.kind === "image") {
        runtime.view.webContents.paste();
      } else {
        if (!text.trim()) throw Error("话术内容为空");
        await runtime.view.webContents.insertText(text);
      }
    },
  );
  ipcMain.on("wa:customer-context", (event, payload) => {
    try {
      const runtime = requireRuntime(event);
      if (
        typeof payload?.identifier !== "string" ||
        typeof payload.name !== "string" ||
        payload.name.length > 150 ||
        (payload.identifier !== "" && !validCustomerIdentity(runtime.platform, payload.identifier))
      )
        return;
      runtime.customer = payload.identifier
        ? { accountId: runtime.id, identifier: payload.identifier, name: payload.name }
        : undefined;
      if (runtime.id === state.activeId) emit();
    } catch {
      /* Observations never grant access. */
    }
  });
  ipcMain.handle("wa:translate", async (event, payload) => {
    const runtime = requireRuntime(event);
    if (!payload || typeof payload.text !== "string" || typeof payload.target !== "string")
      throw Error("参数无效");
    return runtime.translator.translate(
      payload.text,
      payload.target,
      typeof payload.source === "string" ? payload.source : "",
    );
  });
  ipcMain.handle("wa:translation-originals", async (event, payload) => {
    const runtime = requireRuntime(event);
    if (
      typeof payload?.identifier !== "string" ||
      !validCustomerIdentity(runtime.platform, payload.identifier)
    )
      throw Error("客户参数无效");
    if (payload.id === undefined) return runtime.history.list(payload.identifier);
    const match =
      typeof payload.id === "string" ? /^true_([^_]+)_[^\s]{1,200}$/.exec(payload.id) : null;
    const expectedPeer = payload.identifier.endsWith("@lid")
      ? payload.identifier
      : payload.identifier + "@s.whatsapp.net";
    const actualPeer = match?.[1]?.replace(/:[0-9]+@/, "@").replace(/@c\.us$/, "@s.whatsapp.net");
    const nativeMessage =
      typeof payload.id === "string" &&
      payload.id.startsWith(`${runtime.platform}:${payload.identifier}:`) &&
      /^-?\d{1,30}$/.test(payload.id.slice(`${runtime.platform}:${payload.identifier}:`.length));
    if (
      typeof payload.id !== "string" ||
      (runtime.platform === "whatsapp" ? actualPeer !== expectedPeer : !nativeMessage) ||
      typeof payload.source !== "string" ||
      typeof payload.text !== "string" ||
      !payload.source.trim() ||
      payload.source.length > 4000 ||
      payload.text.length > 32000
    )
      throw Error("翻译原文参数无效");
    await runtime.history.put(payload.id, {
      identifier: payload.identifier,
      source: payload.source,
      text: payload.text,
    });
  });
  ipcMain.handle("wa:copy", (event, text) => {
    requireRuntime(event);
    if (typeof text !== "string" || text.length > 20000) throw Error("文本无效");
    clipboard.writeText(text);
  });
  ipcMain.handle("line:remove-login-cookie", async (event) => {
    const runtime = requireRuntime(event);
    if (runtime.platform !== "line") throw Error("请求来源无效");
    await runtime.ses.cookies.remove("https://line-chrome-gw.line-apps.com/", "lct");
    return { name: "lct" };
  });
  ipcMain.handle("platform:inbound-events", async (event, batch: InboundBatch) => {
    const runtime = requireRuntime(event);
    if (
      !batch ||
      !validAccountIdentity(runtime.platform, batch.owner) ||
      runtime.owner !== batch.owner ||
      !Array.isArray(batch.events) ||
      batch.events.length > 250 ||
      typeof batch.ready !== "boolean"
    )
      throw Error("统计来源无效");
    for (const e of batch.events) {
      if (
        !e ||
        typeof e.id !== "string" ||
        e.id.length > 512 ||
        !e.id ||
        typeof e.customer !== "string" ||
        e.customer.length > 80 ||
        typeof e.at !== "string" ||
        !Number.isFinite(Date.parse(e.at))
      )
        throw Error("统计格式无效");
    }
    batch = {
      owner: batch.owner,
      ready: batch.ready,
      events: batch.events.map(({ id, customer, at, phone }) => ({
        id,
        customer,
        at,
        ...(typeof phone === "string" && /^[1-9][0-9]{5,19}$/.test(phone) ? { phone } : {}),
      })),
    };
    const generation = epoch;
    const queueKey = `${auth!.tenantId}:${runtime.id}`;
    runtime.inbound ||= inboundQueues.get(queueKey);
    runtime.inbound ||= new InboundQueue(
      path.join(app.getPath("userData"), "inbound-statistics", auth!.tenantId, runtime.id + ".bin"),
      (value) => {
        if (!safeStorage.isEncryptionAvailable()) throw Error("本机加密存储不可用");
        return safeStorage.encryptString(value);
      },
      (value) => safeStorage.decryptString(value),
    );
    inboundQueues.set(queueKey, runtime.inbound);
    await runtime.inbound.enqueue(batch);
    void runtime.inbound
      .flush(batch.owner, batch.ready, (data) => {
        if (
          generation !== epoch ||
          !auth ||
          runtimes.get(runtime.id) !== runtime ||
          runtime.owner !== data.owner
        )
          throw Error("账号已关闭");
        return request(`/client/accounts/${runtime.id}/inbound-events`, data);
      })
      .catch(() => {});
    return { stored: true };
  });
  ipcMain.handle("team:archive-policy", (event) => {
    requireRuntime(event);
    return { enabled: state.teamArchiveEnabled === true };
  });
  ipcMain.handle("platform:chat-archive", async (event, input: ArchiveBatch) => {
    const runtime = requireRuntime(event);
    if (!state.teamArchiveEnabled) return { stored: false, enabled: false };
    if (
      !input ||
      typeof input.ready !== "boolean" ||
      !Array.isArray(input.messages) ||
      input.messages.length > 100 ||
      (!input.ready && input.messages.length > 0) ||
      !["loaded_only", "unavailable"].includes(input.historyScope)
    )
      throw Error("聊天同步格式无效");
    const metadataOnly = !input.ready && input.messages.length === 0;
    const owner = input.owner || (metadataOnly ? runtime.owner || runtime.archiveOwner : "");
    const ownsBatch = () =>
      runtime.owner === owner || (metadataOnly && !runtime.owner && runtime.archiveOwner === owner);
    if (!validAccountIdentity(runtime.platform, owner) || !ownsBatch())
      throw Error("聊天同步账号无效");
    if (input.ready) runtime.archiveOwner = owner;
    const kinds = new Set([
      "text",
      "image",
      "video",
      "audio",
      "document",
      "sticker",
      "location",
      "contact",
      "poll",
    ]);
    for (const message of input.messages) {
      if (
        !message ||
        typeof message.id !== "string" ||
        !message.id ||
        message.id.length > 512 ||
        typeof message.customer !== "string" ||
        message.customer === owner ||
        !(
          validCustomerIdentity(runtime.platform, message.customer) ||
          (runtime.platform === "whatsapp" && /^lid:[0-9]{5,25}$/.test(message.customer))
        ) ||
        typeof message.body !== "string" ||
        [...message.body].length > 8000 ||
        typeof message.at !== "string" ||
        !Number.isFinite(Date.parse(message.at)) ||
        !["in", "out"].includes(message.direction) ||
        !kinds.has(message.kind) ||
        (message.name !== undefined &&
          (typeof message.name !== "string" || [...message.name].length > 150))
      )
        throw Error("聊天记录字段无效");
    }
    const batch: ArchiveBatch = {
      owner,
      ready: input.ready,
      historyScope: input.historyScope,
      limited: input.limited === true,
      messages: input.messages.map((m) => ({
        id: m.id,
        customer: m.customer,
        name: m.name,
        direction: m.direction,
        body: m.body,
        kind: m.kind,
        at: m.at,
        observedAt: m.observedAt,
        truncated: m.truncated === true,
      })),
    };
    if (Buffer.byteLength(JSON.stringify(batch)) > 1_000_000) throw Error("聊天同步批次过大");
    const generation = epoch,
      tenant = auth!.tenantId,
      device = auth!.deviceId,
      key = tenant + ":" + device + ":" + runtime.id;
    runtime.archive ||= archiveQueues.get(key);
    runtime.archive ||= new ChatArchiveQueue({
      file: path.join(app.getPath("userData"), "chat-archive", tenant, device, runtime.id + ".bin"),
      scope: { tenantId: tenant, deviceId: device, accountId: runtime.id },
      encrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable()) throw Error("本机加密存储不可用");
        return safeStorage.encryptString(value);
      },
      decrypt: (value) => safeStorage.decryptString(value),
    });
    archiveQueues.set(key, runtime.archive);
    const current = () =>
      auth &&
      generation === epoch &&
      runtimes.get(runtime.id) === runtime &&
      ownsBatch() &&
      state.teamArchiveEnabled;
    const send = async (data: ArchiveBatch) => {
      if (!current()) throw Error("聊天同步已暂停");
      const result = await request<{ accepted: number; enabled: boolean }>(
        `/client/accounts/${runtime.id}/chat-archive`,
        data,
      );
      if (!result.enabled) {
        void refreshArchivePolicy();
        throw Error("团队已暂停同步");
      }
      if (current()) {
        runtime.archiveLastSync = Date.now();
        state.teamArchiveError = "";
        emit();
      }
      return result;
    };
    if (!batch.ready || !batch.messages.length) {
      if (!runtime.archiveLastSync || Date.now() - runtime.archiveLastSync > 30000)
        void send({ ...batch, messages: [] }).catch(() => {});
    }
    if (batch.messages.length) {
      try {
        await runtime.archive.enqueue(batch);
      } catch (error) {
        if (current()) {
          state.teamArchiveError = "部分聊天记录暂未保存，将自动重试";
          emit();
        }
        throw error;
      }
    }
    void runtime.archive.flush(owner, batch.ready, send).catch(() => {
      if (current()) {
        state.teamArchiveError = "部分聊天记录待同步，将自动重试";
        emit();
      }
    });
    return { stored: true, enabled: true };
  });
  ipcMain.on("platform:self-avatar", (event, owner, avatar) => {
    try {
      const runtime = requireRuntime(event);
      if (
        runtime.status !== "ready" ||
        runtime.owner !== owner ||
        !validAccountIdentity(runtime.platform, owner) ||
        !validAccountAvatar(avatar)
      )
        return;
      const profiles = (state.accountProfiles ||= {});
      if (profiles[runtime.id]?.owner === owner && profiles[runtime.id]?.avatar === avatar) return;
      profiles[runtime.id] = { owner, avatar };
      persistSession();
      emit();
    } catch {
      /* Reject non-platform frames and stale account snapshots. */
    }
  });
  for (const channel of ["wa:status", "platform:status"])
    ipcMain.on(channel, (event, status, identifier) => {
      try {
        const runtime = requireRuntime(event);
        if (
          ["ready", "qr_required", "loading", "unknown", "network_error", "storage_error"].includes(
            status,
          )
        )
          void updateStatus(runtime, status, typeof identifier === "string" ? identifier : null);
      } catch {
        /* Ignore untrusted/expired observations. */
      }
    });
  await win.loadFile(shellFile);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const saved = JSON.parse(safeStorage.decryptString(await readFile(credentialsFile())));
      if (saved.apiURL === apiURL && saved.auth?.accessToken) {
        auth = saved.auth;
        state.label = auth!.label;
        state.accounts = Array.isArray(saved.accounts) ? saved.accounts : [];
        state.platforms = Array.isArray(saved.platforms) ? saved.platforms : [];
        state.accountProfiles = {};
        if (
          saved.accountProfiles &&
          typeof saved.accountProfiles === "object" &&
          !Array.isArray(saved.accountProfiles)
        ) {
          for (const [id, raw] of Object.entries(saved.accountProfiles).slice(0, 500)) {
            const profile = raw as { owner?: unknown; avatar?: unknown };
            const account = state.accounts.find((a) => a.id === id);
            if (
              account &&
              typeof profile?.owner === "string" &&
              validAccountIdentity(account.platform, profile.owner) &&
              validAccountAvatar(profile.avatar)
            )
              state.accountProfiles[id] = { owner: profile.owner, avatar: profile.avatar };
          }
        }
        state.toolsCollapsed = saved.toolsCollapsed === true;
        state.sidebarCollapsed = saved.sidebarCollapsed === true;
        restoringAccount = typeof saved.activeId === "string" ? saved.activeId : "";
        state.message = "登录已保留，正在恢复连接…";
      }
    }
  } catch (error) {
    // A read/decryption problem must not delete the only copy of the saved session.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      state.message = "暂时无法读取本机登录状态，请重新打开客户端或输入登录码";
  }
  emit();
  if (!backgroundTest) win.show();
  void heartbeat();
  setInterval(() => void heartbeat(), 30000);
  powerMonitor.on("resume", () => void heartbeat());
});
app.on("second-instance", () => {
  if (win && !backgroundTest) {
    win.show();
    win.focus();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (readyToQuit) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  // Finish the local encrypted snapshot before closing; quitting is not a logout.
  void Promise.allSettled([
    saveAuth(),
    rememberedLogin?.flush(),
    ...[...inboundQueues.values()].map((queue) => queue.close()),
    ...[...archiveQueues.values()].map((queue) => queue.close()),
  ])
    .catch(() => {})
    .finally(() => {
      for (const r of runtimes.values()) {
        if (!r.view.webContents.isDestroyed()) r.view.webContents.close();
        void r.bridge?.close();
      }
      readyToQuit = true;
      app.quit();
    });
});
