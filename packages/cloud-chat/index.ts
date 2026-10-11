export interface CloudTransport {
  request<T>(path: string, body?: unknown, method?: string): Promise<T>;
}
interface Chat {
  id: string;
  customerId: string;
  name: string;
  lastInboundAt: string | null;
  lastMessageAt: string;
  unread: number;
  duplicate: boolean;
  preview: string;
}
interface Message {
  id: string;
  seq: number;
  direction: string;
  kind: string;
  body: string;
  status: string;
  error: string;
  occurredAt: string;
  mediaId: string;
  filename: string;
}
interface Template {
  name: string;
  language: string;
  status: string;
  body: string;
  parameterCount: number;
  supported: boolean;
}
const statuses: Record<string, string> = {
  queued: "等待发送",
  sending: "发送中",
  accepted: "Meta 已接收",
  sent: "已发送",
  delivered: "已送达",
  read: "已读",
  failed: "发送失败",
  unknown: "结果待确认",
  received: "",
};
export const cloudLanguages = [
  ["zh-CN", "简体中文"],
  ["en", "英语"],
  ["es", "西班牙语"],
  ["pt", "葡萄牙语"],
  ["ar", "阿拉伯语"],
  ["ru", "俄语"],
  ["fr", "法语"],
  ["de", "德语"],
  ["ja", "日语"],
  ["ko", "韩语"],
  ["vi", "越南语"],
  ["th", "泰语"],
  ["id", "印尼语"],
  ["hi", "印地语"],
  ["zh-TW", "繁体中文"],
];
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function button(text: string, action: () => void, className = "wc-button") {
  const b = element("button", className, text);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
}
function time(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
export interface CloudChatOptions {
  onCustomerChange?: (chat: { id: string; customerId: string; name: string } | undefined) => void;
}
export function mountCloudChat(
  host: HTMLElement,
  transport: CloudTransport,
  options: CloudChatOptions = {},
) {
  let disposed = false,
    loading = false,
    selected = "",
    search = "",
    offset = 0,
    busy = false,
    lastRead = 0;
  let chats: Chat[] = [],
    messages: Message[] = [],
    templates: Template[] = [];
  let selectedChat: Chat | undefined;
  let pending: { fingerprint: string; requestId: string } | undefined;
  let attachment: { id: string; kind: string; filename: string } | undefined;
  const translations = new Map<string, string>();
  const drafts = new Map<string, string>();
  host.classList.add("wa-cloud-chat");
  host.innerHTML = `<section class="wc-sidebar"><div class="wc-side-head"><strong>在线聊天</strong><button class="wc-new wc-button" type="button">新对话</button></div><input class="wc-search" placeholder="搜索客户手机号 / 名称" aria-label="搜索客户"/><div class="wc-conversations"></div><div class="wc-pagination"></div></section><section class="wc-main"><header class="wc-chat-head"><div><strong class="wc-title">选择一位客户</strong><p class="wc-info">消息由 WhatsApp 官方 API 收发</p></div><button class="wc-refresh wc-button" type="button">刷新</button></header><p class="wc-notice" role="status"></p><div class="wc-messages"><div class="wc-welcome">在左侧选择对话，或使用获批模板开始新对话。</div></div><div class="wc-composer" hidden><div class="wc-compose-tools"><button class="wc-templates wc-button" type="button">模板消息</button><button class="wc-attach wc-button" type="button">添加附件</button><select class="wc-language" aria-label="翻译目标语言"></select><button class="wc-translate wc-button" type="button">翻译草稿</button><span class="wc-file"></span><input class="wc-file-input" type="file" hidden/></div><textarea class="wc-draft" rows="3" maxlength="4096" placeholder="输入回复内容，点击发送" aria-label="回复内容"></textarea><div class="wc-draft-translation" hidden></div><footer class="wc-compose-footer"><span class="wc-window"></span><button class="wc-send wc-primary" type="button">发送</button></footer></div></section>`;
  const get = <T extends HTMLElement = HTMLElement>(selector: string) =>
    host.querySelector<T>(selector)!;
  const draft = get<HTMLTextAreaElement>(".wc-draft"),
    sendButton = get<HTMLButtonElement>(".wc-send"),
    list = get(".wc-messages");
  const language = get<HTMLSelectElement>(".wc-language");
  for (const [value, label] of cloudLanguages) {
    const o = element("option", "", label);
    o.value = value!;
    language.append(o);
  }
  const notify = (message: string) => {
    if (!disposed) get(".wc-notice").textContent = message;
  };
  async function action(work: () => Promise<void>) {
    try {
      await work();
    } catch (e) {
      notify((e as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ""));
    }
  }
  function current() {
    return chats.find((c) => c.id === selected) || selectedChat;
  }
  function inWindow() {
    const at = current()?.lastInboundAt;
    return !!at && Date.now() - new Date(at).getTime() < 24 * 3600 * 1000;
  }
  function composer() {
    get(".wc-composer").hidden = !selected;
    const allowed = inWindow();
    sendButton.disabled = busy || !allowed;
    draft.disabled = !allowed;
    get<HTMLButtonElement>(".wc-attach").disabled = busy || !allowed;
    get<HTMLButtonElement>(".wc-templates").disabled = busy;
    get(".wc-window").textContent = allowed
      ? "客服窗口内 · 普通消息可发送"
      : "请使用获批模板，等待客户回复后再发送普通消息";
    get(".wc-file").textContent = attachment ? `附件：${attachment.filename}（点击移除）` : "";
  }
  function select(chat: Chat) {
    if (selected) drafts.set(selected, draft.value);
    selected = chat.id;
    selectedChat = chat;
    options.onCustomerChange?.(chat);
    messages = [];
    lastRead = 0;
    attachment = undefined;
    pending = undefined;
    draft.value = drafts.get(selected) || "";
    get(".wc-draft-translation").hidden = true;
    get(".wc-title").textContent = chat.name || chat.customerId;
    get(".wc-info").textContent = `${chat.customerId} · ${chat.duplicate ? "重复用户" : "新用户"}`;
    list.replaceChildren(element("p", "wc-welcome", "正在加载消息…"));
    renderChats();
    composer();
    void action(loadMessages);
  }
  function renderChats() {
    const root = get(".wc-conversations");
    root.replaceChildren();
    if (!chats.length)
      root.append(element("p", "wc-empty", "暂无对话，客户发来消息后会显示在这里。"));
    for (const chat of chats) {
      const b = button(
        "",
        () => select(chat),
        "wc-conversation" + (selected === chat.id ? " is-active" : ""),
      );
      const top = element("div", "wc-conversation-top");
      top.append(element("b", "", chat.name || chat.customerId));
      if (chat.unread) top.append(element("span", "wc-count", String(chat.unread)));
      b.append(top, element("span", "wc-preview", chat.preview || chat.customerId));
      if (chat.duplicate) b.append(element("span", "wc-duplicate", "重复用户"));
      root.append(b);
    }
    const pager = get(".wc-pagination");
    pager.replaceChildren();
    if (offset > 0)
      pager.append(
        button("上一页", () => {
          offset = Math.max(0, offset - 100);
          void action(refresh);
        }),
      );
    if (chats.length === 100)
      pager.append(
        button("下一页", () => {
          offset += 100;
          void action(refresh);
        }),
      );
  }
  async function download(m: Message) {
    const v = await transport.request<{ data: string; mime: string; filename: string }>(
      `/media/${m.mediaId}/download`,
      {},
    );
    if (disposed) return;
    const bytes = Uint8Array.from(atob(v.data), (c) => c.charCodeAt(0));
    // Download as an attachment, never execute/open untrusted documents in the app.
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = element("a");
    a.href = url;
    a.download = v.filename || m.filename || "WhatsApp-attachment";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderMessages(forceBottom = false) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100,
      oldTop = list.scrollTop,
      oldHeight = list.scrollHeight;
    list.replaceChildren();
    if (messages.length >= 100)
      list.append(
        button(
          "加载更早消息",
          () =>
            void action(async () => {
              const id = selected;
              const older = await transport.request<Message[]>(
                `/chats/${id}/messages?before=${messages[0]!.seq}`,
              );
              if (disposed || id !== selected) return;
              if (!older.length) {
                notify("已加载全部历史消息");
                return;
              }
              messages = [...older.reverse(), ...messages];
              renderMessages();
              list.scrollTop = list.scrollHeight - oldHeight + oldTop;
            }),
          "wc-button wc-older",
        ),
      );
    if (!messages.length) list.append(element("p", "wc-welcome", "还没有消息。可先发送获批模板。"));
    for (const m of messages) {
      const row = element("article", "wc-message " + (m.direction === "out" ? "wc-out" : "wc-in"));
      const bubble = element("div", "wc-bubble");
      bubble.append(element("div", "wc-message-body", m.body));
      if (m.mediaId)
        bubble.append(
          button("下载附件", () => void action(() => download(m)), "wc-message-action"),
        );
      if (m.body && ["text", "template"].includes(m.kind))
        bubble.append(
          button(
            "翻译",
            () =>
              void action(async () => {
                const v = await transport.request<{ text: string }>("/translate", {
                  text: m.body,
                  target: language.value,
                });
                if (disposed) return;
                translations.set(m.id, v.text);
                renderMessages();
              }),
            "wc-message-action",
          ),
        );
      const translated = translations.get(m.id);
      if (translated) bubble.append(element("p", "wc-translation", translated));
      const state = m.error
        ? `${statuses[m.status] || m.status} · ${m.error}`
        : statuses[m.status] || "";
      bubble.append(
        element(
          "small",
          "wc-message-meta" + (m.status === "failed" || m.status === "unknown" ? " wc-error" : ""),
          `${time(m.occurredAt)} ${state}`,
        ),
      );
      if (m.direction === "out" && m.status === "failed" && m.kind === "text")
        bubble.append(
          button(
            "恢复到草稿",
            () => {
              draft.value = m.body;
              draft.focus();
            },
            "wc-message-action",
          ),
        );
      row.append(bubble);
      list.append(row);
    }
    if (forceBottom || nearBottom) list.scrollTop = list.scrollHeight;
    else list.scrollTop = oldTop;
  }
  async function loadMessages() {
    if (!selected) return;
    const id = selected;
    const batch = await transport.request<Message[]>(`/chats/${id}/messages`);
    if (disposed || id !== selected) return;
    const combined = new Map(messages.map((m) => [m.id, m]));
    for (const m of batch) combined.set(m.id, m);
    const next = [...combined.values()].sort((a, b) => a.seq - b.seq);
    const changed = JSON.stringify(next) !== JSON.stringify(messages);
    const first = messages.length === 0;
    messages = next;
    if (changed || first) renderMessages(first);
    const last = batch.reduce((max, m) => Math.max(max, m.seq), 0);
    if (last > lastRead && host.isConnected && document.visibilityState === "visible") {
      await transport.request(`/chats/${id}/read`, { throughSeq: last });
      if (!disposed && id === selected) lastRead = last;
    }
  }
  async function refresh() {
    if (disposed || loading) return;
    loading = true;
    try {
      const rows = await transport.request<Chat[]>(
        `/chats?search=${encodeURIComponent(search)}&offset=${offset}`,
      );
      if (disposed) return;
      chats = rows;
      selectedChat = rows.find((c) => c.id === selected) || selectedChat;
      renderChats();
      composer();
      const chat = current();
      if (chat)
        get(".wc-info").textContent =
          `${chat.customerId} · ${chat.duplicate ? "重复用户" : "新用户"}`;
      await loadMessages();
    } finally {
      loading = false;
    }
  }
  async function send(body: Record<string, unknown>) {
    if (!selected || busy) throw Error("请等待当前操作完成");
    busy = true;
    composer();
    const chat = selected;
    const sentDraft = draft.value;
    const fingerprint = JSON.stringify({ chat, ...body });
    if (pending?.fingerprint !== fingerprint)
      pending = { fingerprint, requestId: crypto.randomUUID() };
    try {
      await transport.request(`/chats/${chat}/messages`, { ...body, requestId: pending.requestId });
      if (disposed) return;
      if (body.kind !== "template" && drafts.get(chat) === sentDraft) drafts.delete(chat);
      if (chat === selected) {
        // A slow response must not erase the next message already being typed.
        if (body.kind !== "template" && draft.value === sentDraft) draft.value = "";
        if (draft.value) drafts.set(chat, draft.value);
        else drafts.delete(chat);
        attachment = undefined;
        pending = undefined;
        get(".wc-draft-translation").hidden = true;
        notify("消息已加入发送队列");
        await loadMessages();
      }
    } finally {
      busy = false;
      if (!disposed) composer();
    }
  }
  function dialog(title: string) {
    const d = element("dialog", "wc-dialog");
    d.setAttribute("aria-label", title);
    const heading = element("h3", "", title);
    const content = element("div", "wc-dialog-content"),
      footer = element("div", "wc-dialog-footer");
    footer.append(button("取消", () => d.close()));
    d.append(heading, content, footer);
    host.append(d);
    d.addEventListener("close", () => d.remove());
    d.showModal();
    return { d, content, footer };
  }
  get(".wc-new").addEventListener("click", () => {
    const { d, content, footer } = dialog("开始新对话");
    content.append(
      element("p", "wc-muted", "输入客户手机号，先发送获批模板，客户回复后可自由聊天。"),
    );
    const input = element("input");
    input.placeholder = "含国家区号，例如 +8613800000000";
    input.setAttribute("aria-label", "客户手机号");
    content.append(input);
    footer.append(
      button(
        "创建对话",
        () =>
          void action(async () => {
            const result = await transport.request<{ id: string }>("/chats", {
              customerId: input.value,
            });
            if (disposed) return;
            search = "";
            offset = 0;
            get<HTMLInputElement>(".wc-search").value = "";
            await refresh();
            const chat = chats.find((c) => c.id === result.id);
            if (chat) select(chat);
            d.close();
          }),
        "wc-primary",
      ),
    );
  });
  get(".wc-templates").addEventListener(
    "click",
    () =>
      void action(async () => {
        templates = await transport.request<Template[]>("/templates");
        if (disposed) return;
        const { d, content, footer } = dialog("发送模板消息");
        const approved = templates.filter((t) => t.supported);
        if (!approved.length) {
          content.append(
            element("p", "wc-muted", "暂无可发送的获批文本模板，请管理员在号码管理中同步模板。"),
          );
          return;
        }
        const choice = element("select");
        approved.forEach((t, i) => {
          const o = element("option", "", `${t.name} · ${t.language}`);
          o.value = String(i);
          choice.append(o);
        });
        content.append(choice);
        const preview = element("p", "wc-template-preview"),
          params = element("div", "wc-template-params");
        content.append(preview, params);
        const update = () => {
          const t = approved[Number(choice.value)]!;
          preview.textContent = t.body;
          params.replaceChildren();
          for (let i = 0; i < t.parameterCount; i++) {
            const input = element("input");
            input.placeholder = `参数 ${i + 1}`;
            input.maxLength = 1024;
            params.append(input);
          }
        };
        choice.addEventListener("change", update);
        update();
        const submit = button(
          "发送模板",
          () =>
            void action(async () => {
              submit.disabled = true;
              try {
                const t = approved[Number(choice.value)]!;
                await send({
                  kind: "template",
                  templateName: t.name,
                  language: t.language,
                  parameters: [...params.querySelectorAll("input")].map((i) => i.value),
                });
                d.close();
              } finally {
                submit.disabled = false;
              }
            }),
          "wc-primary",
        );
        footer.append(submit);
      }),
  );
  get(".wc-send").addEventListener(
    "click",
    () =>
      void action(() =>
        send({
          kind: attachment?.kind || "text",
          text: draft.value,
          mediaId: attachment?.id || "",
        }),
      ),
  );
  get(".wc-translate").addEventListener(
    "click",
    () =>
      void action(async () => {
        const text = draft.value;
        if (!text.trim()) return;
        const id = selected;
        const result = await transport.request<{ text: string }>("/translate", {
          text,
          target: language.value,
        });
        if (disposed || id !== selected) return;
        const box = get(".wc-draft-translation");
        box.replaceChildren(
          element("p", "", result.text),
          button("使用译文", () => {
            draft.value = result.text;
            box.hidden = true;
          }),
        );
        box.hidden = false;
      }),
  );
  get(".wc-file").addEventListener("click", () => {
    attachment = undefined;
    composer();
  });
  const fileInput = get<HTMLInputElement>(".wc-file-input");
  fileInput.accept =
    "image/jpeg,image/png,audio/*,video/mp4,.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx";
  get(".wc-attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener(
    "change",
    () =>
      void action(async () => {
        const file = fileInput.files?.[0];
        fileInput.value = "";
        if (!file) return;
        if (file.size > 16 * 1024 * 1024) throw Error("文件最多 16 MB，图片最多 5 MB");
        const id = selected;
        busy = true;
        composer();
        notify("正在上传附件…");
        try {
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]!);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const result = await transport.request<{ id: string; kind: string; filename: string }>(
            "/media",
            { data, mime: file.type || "application/octet-stream", filename: file.name },
          );
          if (!disposed && id === selected) {
            attachment = result;
            notify("附件已准备好，点击发送后才会发给客户");
          }
        } finally {
          busy = false;
          if (!disposed) composer();
        }
      }),
  );
  let searchTimer: ReturnType<typeof setTimeout>;
  get<HTMLInputElement>(".wc-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search = (e.target as HTMLInputElement).value;
      offset = 0;
      void action(refresh);
    }, 300);
  });
  get(".wc-refresh").addEventListener("click", () => void action(refresh));
  const timer = setInterval(() => {
    if (host.isConnected && document.visibilityState === "visible") void action(refresh);
  }, 3000);
  void action(refresh);
  return {
    setCustomerLanguage(chatId: string, target: string) {
      if (!disposed && selected === chatId && cloudLanguages.some(([id]) => id === target))
        language.value = target;
    },
    async prepareQuick(
      chatId: string,
      content: { text?: string; image?: { data: string; mime: string; filename: string } },
    ) {
      if (disposed || selected !== chatId || !selected) throw Error("当前客户已切换，请重新选择");
      if (busy || !inWindow()) throw Error("当前无法放入普通消息，请等待操作完成或使用获批模板");
      if (draft.value.trim() || attachment) throw Error("聊天输入框已有草稿或附件，请先处理后再试");
      if (content.image) {
        busy = true;
        composer();
        try {
          const result = await transport.request<{ id: string; kind: string; filename: string }>(
            "/media",
            content.image,
          );
          if (disposed || selected !== chatId) throw Error("客户已切换，图片未放入新会话");
          attachment = result;
        } finally {
          busy = false;
          if (!disposed) composer();
        }
      } else {
        draft.value = content.text || "";
        drafts.set(selected, draft.value);
      }
      notify("素材已放入当前聊天，确认后点击发送");
      draft.focus();
    },
    dispose() {
      disposed = true;
      options.onCustomerChange?.(undefined);
      clearInterval(timer);
      clearTimeout(searchTimer);
      host.replaceChildren();
    },
    refresh,
  };
}
