export interface NativeCustomer {
  identifier: string;
  name: string;
  sendMode: "enter" | "modifier" | "unknown";
  messages?: { id: string; text: string; outgoing: boolean }[];
}

// Read-only, self-contained function executed in the official application's
// main world. Names never establish identity; group chats are deliberately excluded.
export function readNativeCustomer(
  platform: "line" | "telegram",
  includeMessages = false,
): NativeCustomer | null {
  if (platform === "telegram") {
    const editors = [
      ...document.querySelectorAll<HTMLElement>(
        '.chat-input [contenteditable="true"][data-peer-id]',
      ),
    ].filter((el) => el.getClientRects().length > 0);
    if (editors.length !== 1) return null;
    const identifier = editors[0].dataset.peerId || "";
    const root = (window as any).rootScope;
    if (!/^[1-9][0-9]{0,15}$/.test(identifier) || identifier === String(root?.myId || ""))
      return null;
    const chat = editors[0].closest(".chat");
    const name =
      chat?.querySelector<HTMLElement>(".chat-info .peer-title, .chat-info .user-title")
        ?.innerText || identifier;
    const shortcut =
      (window as any).useAppSettings?.()?.[0]?.sendShortcut ?? root?.settings?.sendShortcut;
    return {
      identifier,
      name: name.trim().slice(0, 150),
      sendMode:
        shortcut === "enter"
          ? "enter"
          : shortcut === "ctrlEnter" || shortcut === "ctrl_enter"
            ? "modifier"
            : "unknown",
    };
  }
  const element = document.getElementById("root") as any;
  const key = element && Object.keys(element).find((k) => k.startsWith("__reactContainer$"));
  const fiber = key && element[key];
  const queue = [fiber?.stateNode?.current || fiber];
  const visited = new Set();
  let state: any;
  for (let n = 0; queue.length && n < 500; n++) {
    const node = queue.shift();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    const store = node.memoizedProps?.value?.store;
    if (store?.getState) {
      state = store.getState();
      break;
    }
    queue.push(node.child, node.sibling);
  }
  if (state?.auth?.loginState !== "logged_in") return null;
  const editors = [
    ...document.querySelectorAll<HTMLElement>(
      '[class*="chatroomEditor-module__editor_area"] textarea-ex',
    ),
  ].filter((el) => el.getClientRects().length > 0);
  if (editors.length !== 1) return null;
  const editor = editors[0] as any;
  const reactKey = Object.keys(editor).find((k) => k.startsWith("__reactFiber$"));
  let node = reactKey && editor[reactKey];
  let identifier = "";
  for (let n = 0; node && n < 100; n++, node = node.return) {
    if (typeof node.memoizedProps?.messageBoxId === "string") {
      identifier = node.memoizedProps.messageBoxId;
      break;
    }
  }
  // The pinned LINE app uses /chats/:messageBoxId and /friends/:messageBoxId.
  const route = /\/(?:chats|friends)\/(u[0-9a-f]{32})(?:[/?#]|$)/.exec(
    location.hash || location.pathname,
  )?.[1];
  if (!identifier) identifier = route || "";
  if (
    !/^u[0-9a-f]{32}$/.test(identifier) ||
    (route && route !== identifier) ||
    identifier === state.auth.profile?.mid
  )
    return null;
  const contact = state.contact?.entities?.contacts?.[identifier];
  const name = contact?.displayNameOverridden || contact?.displayName || identifier;
  const messages: NonNullable<NativeCustomer["messages"]> = [];
  if (includeMessages) {
    const room = editor.closest('[class*="chatroom-module__chatroom"]');
    const ids = new Set(
      [...(room?.querySelectorAll("[data-message-id]") || [])].map((el: any) =>
        el.getAttribute("data-message-id"),
      ),
    );
    for (const id of [...ids].slice(-100)) {
      const msg = state.message?.entities?.messages?.[id as string];
      if (
        !msg ||
        !/^\d{1,30}$/.test(String(id)) ||
        Number(msg.toType) !== 0 ||
        Number(msg.contentType) !== 0 ||
        typeof msg.text !== "string" ||
        !msg.text.trim() ||
        msg.text.length > 4000
      )
        continue;
      const outgoing = msg.from === state.auth.profile?.mid && msg.to === identifier;
      const incoming = msg.from === identifier && msg.to === state.auth.profile?.mid;
      if (incoming || outgoing) messages.push({ id: String(id), text: msg.text, outgoing });
    }
  }
  return {
    identifier,
    name: String(name).slice(0, 150),
    sendMode:
      state.common?.userStorage?.settings?.chat?.sendKey === "enter_with_modifier"
        ? "modifier"
        : "enter",
    ...(includeMessages ? { messages } : {}),
  };
}
