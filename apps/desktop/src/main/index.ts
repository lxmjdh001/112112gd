import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  ipcMain,
  Menu,
  clipboard,
  safeStorage,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import type {
  Account,
  AccountOptions,
  ClientAuth,
  NewAccount,
  ProxyConfig,
  ViewState,
} from "../shared/types.ts";
import { GoogleFreeTranslator } from "./translation.ts";
import { chromiumUserAgent } from "./browser-identity.ts";
import { socksBridge, type Bridge } from "./proxy.ts";
import { throughSession, type ProxyAuth } from "./network.ts";
import { getPlatform } from "../../../../packages/platform/registry.ts";

if (process.env.GONGDAN_USER_DATA)
  app.setPath("userData", path.resolve(process.env.GONGDAN_USER_DATA));
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
let deviceIdentity = "";
let leaseUntil = 0;
let epoch = 0;
let opening = false;
let beating = false;
let accountFormOpen = false;
let creatingAccount = false;
let apiURL = "http://127.0.0.1:18080";
const state: ViewState = {
  loggedIn: false,
  label: "",
  accounts: [],
  activeId: "",
  statuses: {},
  message: "",
  apiURL,
};
interface Runtime {
  id: string;
  view: WebContentsView;
  ses: Session;
  translator: GoogleFreeTranslator;
  bridge?: Bridge;
  proxyAuth: ProxyAuth;
  status: string;
}
const runtimes = new Map<string, Runtime>();
const credentialsFile = () => path.join(app.getPath("userData"), "authorization.bin");
function emit() {
  state.loggedIn = !!auth;
  state.apiURL = apiURL;
  if (win && !win.isDestroyed()) win.webContents.send("shell:state", state);
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
    !runtime ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame?.url.startsWith("https://web.whatsapp.com/") !== true ||
    !auth ||
    performance.now() >= leaseUntil
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
  const res = await fetch(apiURL + "/api/v1" + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `gongdan007-desktop/${app.getVersion()} (${process.platform}; ${process.arch})`,
      ...(requestAuth ? { Authorization: "Bearer " + requestAuth.accessToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  const result = (await res.json()) as { code: number; data: T; message?: string };
  if (!res.ok) {
    if (res.status === 401 && auth && auth === requestAuth)
      await terminate("登录权限已失效，请联系管理员或重新输入登录码");
    throw new Error(result.message || "请求未完成");
  }
  return result.data;
}
async function saveAuth() {
  if (!auth || !safeStorage.isEncryptionAvailable()) return;
  await writeFile(credentialsFile(), safeStorage.encryptString(JSON.stringify({ apiURL, auth })), {
    mode: 0o600,
  });
}
async function closeRuntime(runtime: Runtime) {
  runtimes.delete(runtime.id);
  runtime.translator.clear();
  if (!runtime.view.webContents.isDestroyed()) runtime.view.webContents.close();
  await runtime.ses.setProxy({
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:9",
    proxyBypassRules: "<-loopback>",
  });
  await runtime.ses.closeAllConnections();
  await runtime.bridge?.close();
}
async function terminate(message: string) {
  epoch++;
  auth = undefined;
  leaseUntil = 0;
  accountFormOpen = false;
  state.label = "";
  state.accounts = [];
  state.activeId = "";
  state.statuses = {};
  state.message = message;
  await Promise.allSettled([...runtimes.values()].map(closeRuntime));
  await rm(credentialsFile(), { force: true });
  emit();
}
function bounds() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  for (const runtime of runtimes.values()) {
    const active = runtime.id === state.activeId && !accountFormOpen;
    runtime.view.setVisible(active);
    if (active)
      runtime.view.setBounds({
        x: 224,
        y: 58,
        width: Math.max(0, width - 224),
        height: Math.max(0, height - 58),
      });
  }
}
let refreshing: { epoch: number; promise: Promise<void> } | undefined;
function refresh() {
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
  const accounts = await request<Account[]>("/client/accounts");
  if (!auth || generation !== epoch) return;
  state.accounts = accounts;
  const allowed = new Set(
    accounts.filter((account) => account.available).map((account) => account.id),
  );
  for (const runtime of [...runtimes.values()]) {
    if (!allowed.has(runtime.id)) {
      await closeRuntime(runtime);
      if (generation !== epoch || !auth) return;
      if (state.activeId === runtime.id) state.activeId = "";
    }
  }
  for (const account of accounts) {
    if (account.unavailableReason === "proxy_disabled")
      state.statuses[account.id] = "proxy_disabled";
    else if (state.statuses[account.id] === "proxy_disabled") delete state.statuses[account.id];
  }
  bounds();
  emit();
}
async function heartbeat() {
  if (!auth || beating) return;
  beating = true;
  try {
    const generation = epoch;
    const result = await request<{ leaseSeconds: number }>("/client/heartbeat", {});
    if (auth && epoch === generation) {
      await refresh();
      if (!auth || epoch !== generation) return;
      leaseUntil = performance.now() + Math.min(result.leaseSeconds, 150) * 1000;
      state.message = "";
      emit();
    }
  } catch {
    if (auth) {
      state.message = "管理服务暂时不可达，正在重试连接";
      emit();
    }
  } finally {
    beating = false;
  }
}
async function login(code: string, url: string) {
  if (opening) throw new Error("正在处理连接，请稍后");
  const target = new URL(url);
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.pathname !== "/" && target.pathname !== "")
  )
    throw new Error("请输入服务地址，例如 https://admin.example.com");
  if (
    target.protocol !== "https:" &&
    !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
  )
    throw new Error("服务地址必须使用 HTTPS");
  if (typeof code !== "string" || code.length < 10 || code.length > 100)
    throw new Error("请输入完整登录码");
  await terminate("");
  apiURL = target.origin;
  const generation = epoch;
  const result = await request<ClientAuth>("/client/auth", {
    code: code.trim(),
    deviceId: deviceIdentity,
    deviceName: hostname(),
  });
  if (epoch !== generation) return;
  auth = result;
  leaseUntil = performance.now() + Math.min(result.leaseSeconds, 150) * 1000;
  state.label = result.label;
  await saveAuth();
  await refresh();
  emit();
}
async function updateStatus(runtime: Runtime, status: string) {
  if (!runtimes.has(runtime.id) || !auth) return;
  runtime.status = status;
  state.statuses[runtime.id] = status;
  emit();
  try {
    await request(`/client/accounts/${runtime.id}/status`, { status });
  } catch {
    /* Heartbeat controls authorization; failed observations never erase platform login. */
  }
}
async function openAccount(id: string) {
  if (opening) throw new Error("正在打开账号，请稍后");
  if (!auth || performance.now() >= leaseUntil) throw new Error("请先登录客户端");
  const account = state.accounts.find((x) => x.id === id);
  if (!account || !account.available) throw new Error("账号不可用或已被其他设备绑定");
  if (runtimes.has(id)) {
    state.activeId = id;
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
    const settings = await request<{ id: string; tenantId: string; proxy: ProxyConfig }>(
      `/client/accounts/${id}/open`,
      {},
    );
    if (generation !== epoch || !auth) return;
    const p = settings.proxy;
    const ses = session.fromPartition(`persist:gd7-${settings.tenantId}-${id}`);
    const browserUA = chromiumUserAgent(app.userAgentFallback, app.getName());
    ses.setUserAgent(browserUA);
    ses.webRequest.onBeforeRequest((_details, callback) =>
      callback({ cancel: !runtimes.has(id) || !auth || performance.now() >= leaseUntil }),
    );
    let host = p.host,
      port = p.port,
      username = p.username,
      password = p.password,
      protocol = p.protocol;
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
    await ses.closeAllConnections();
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    const proxyAuth = { host, port, username, password };
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
      id,
      view,
      ses,
      bridge,
      proxyAuth,
      status: "loading",
      translator: new GoogleFreeTranslator(throughSession(ses, proxyAuth), (usage) => {
        // Free usage metadata only: never send message content to the management API.
        if (generation === epoch && auth && runtimes.has(id))
          void request("/client/usage", {
            ...usage,
            accountId: id,
            provider: "google-free",
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
    bounds();
    emit();
    const current = runtime;
    const wc = view.webContents;
    wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    wc.setUserAgent(browserUA);
    wc.on("login", (event, _details, info, callback) => {
      event.preventDefault();
      if (_details.firstAuthAttempt && info.isProxy && info.host === host && info.port === port)
        callback(username, password);
      else callback();
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event, url) => {
      if (!adapter.allowedOrigins.includes(new URL(url).origin)) event.preventDefault();
    });
    wc.on("will-redirect", (event, url) => {
      if (!adapter.allowedOrigins.includes(new URL(url).origin)) event.preventDefault();
    });
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
          label: "使用 Google 翻译选中文字",
          click: () => wc.send("wa:selection", params.selectionText.slice(0, 4000)),
        });
      Menu.buildFromTemplate(items).popup({ window: win });
    });
    await updateStatus(current, "loading");
    await wc.loadURL(adapter.homeURL);
  } catch {
    if (runtime) {
      await updateStatus(runtime, "network_error");
      await closeRuntime(runtime);
    } else await bridge?.close();
    state.activeId = "";
    bounds();
    state.message = "账号打开失败，请检查代理地址、认证信息和网络连接后重试";
    emit();
    throw new Error(state.message);
  } finally {
    opening = false;
  }
}

app.whenReady().then(async () => {
  await mkdir(app.getPath("userData"), { recursive: true });
  const devicePath = path.join(app.getPath("userData"), "installation-id");
  try {
    deviceIdentity = (await readFile(devicePath, "utf8")).trim();
  } catch {
    deviceIdentity = randomBytes(32).toString("hex");
    await writeFile(devicePath, deviceIdentity, { mode: 0o600 });
  }
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "工单007 客户端",
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: path.join(baseDir, "shell-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
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
  ipcMain.handle("shell:login", async (event, code, url) => {
    requireShell(event);
    await login(code, url);
  });
  ipcMain.handle("shell:logout", async (event) => {
    requireShell(event);
    try {
      await request("/client/logout", {});
    } finally {
      await terminate("已退出客户端，平台登录资料保留在本机");
    }
  });
  ipcMain.handle("shell:reload", async (event) => {
    requireShell(event);
    const runtime = runtimes.get(state.activeId);
    if (!runtime || !auth || performance.now() >= leaseUntil) throw Error("没有可重新加载的账号");
    await updateStatus(runtime, "loading");
    try {
      await runtime.view.webContents.loadURL(getPlatform("whatsapp").homeURL);
    } catch {
      await updateStatus(runtime, "network_error");
    }
  });
  ipcMain.handle("shell:refresh", async (event) => {
    requireShell(event);
    await refresh();
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
    if (open !== true || !auth || performance.now() >= leaseUntil) throw Error("请先登录客户端");
    const generation = epoch;
    const options = await request<AccountOptions>("/client/account-options");
    if (!auth || generation !== epoch) throw Error("登录状态已变化，请重试");
    accountFormOpen = true;
    bounds();
    return options;
  });
  ipcMain.handle("shell:create-account", async (event, input: NewAccount) => {
    requireShell(event);
    if (!auth || performance.now() >= leaseUntil) throw Error("请先登录客户端");
    if (creatingAccount) throw Error("正在添加账号，请稍后");
    if (
      !input ||
      typeof input.label !== "string" ||
      !input.label.trim() ||
      [...input.label.trim()].length > 100 ||
      typeof input.platform !== "string" ||
      typeof input.proxyId !== "string" ||
      typeof input.requestId !== "string"
    )
      throw Error("请填写账号名称并选择平台和代理");
    getPlatform(input.platform);
    const generation = epoch;
    creatingAccount = true;
    try {
      const result = await request<{ id: string }>("/client/accounts", {
        label: input.label.trim(),
        platform: input.platform,
        proxyId: input.proxyId,
        requestId: input.requestId,
      });
      if (!auth || generation !== epoch) throw Error("登录状态已变化，请重新登录后查看账号");
      await refresh();
      if (!auth || generation !== epoch) throw Error("登录状态已变化，请重新登录后查看账号");
      return result.id;
    } finally {
      creatingAccount = false;
    }
  });
  ipcMain.handle("wa:translate", async (event, payload) => {
    const runtime = requireRuntime(event);
    if (!payload || typeof payload.text !== "string" || typeof payload.target !== "string")
      throw Error("参数无效");
    return runtime.translator.translate(payload.text, payload.target);
  });
  ipcMain.handle("wa:copy", (event, text) => {
    requireRuntime(event);
    if (typeof text !== "string" || text.length > 20000) throw Error("文本无效");
    clipboard.writeText(text);
  });
  ipcMain.on("wa:status", (event, status) => {
    try {
      const runtime = requireRuntime(event);
      if (["ready", "qr_required", "loading", "unknown", "network_error"].includes(status))
        void updateStatus(runtime, status);
    } catch {
      /* Ignore untrusted/expired observations. */
    }
  });
  await win.loadFile(shellFile);
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const saved = JSON.parse(safeStorage.decryptString(await readFile(credentialsFile())));
      if (typeof saved.apiURL === "string" && saved.auth?.accessToken) {
        apiURL = saved.apiURL;
        auth = saved.auth;
        await heartbeat();
        if (auth && performance.now() < leaseUntil) {
          state.label = auth.label;
          await refresh();
        } else await terminate("请重新输入登录码");
      }
    }
  } catch {
    await terminate("");
  }
  emit();
  setInterval(() => void heartbeat(), 30000);
  setInterval(() => {
    if (auth && performance.now() >= leaseUntil)
      void terminate("授权连接超时，账号已暂停，请重新登录");
  }, 1000);
});
app.on("second-instance", () => {
  if (win) {
    win.show();
    win.focus();
  }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  for (const r of runtimes.values()) {
    r.view.webContents.close();
    void r.bridge?.close();
  }
});
