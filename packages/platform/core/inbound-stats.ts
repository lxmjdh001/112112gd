// Executed in the platform's main world. Observe existing message stores only;
// never fetch chats, mark messages read, or send messages on the user's behalf.
export function collectInbound(platform: string, ack: string[] = [], knownOwner = "") {
  const w = window as any;
  const key = "__d1InboundStatisticsV1";
  const state = (w[key] ||= {
    pending: new Map(),
    seen: new Set(),
    owner: "",
    attached: null,
    ready: false,
  });
  for (const id of ack) {
    state.pending.delete(id);
    state.seen.add(id);
  }
  while (state.seen.size > 50000) state.seen.delete(state.seen.values().next().value);
  const add = (owner: string, id: string, customer: string, seconds: number, phone?: string) => {
    if (
      !owner ||
      !id ||
      !customer ||
      customer === owner ||
      !Number.isFinite(seconds) ||
      seconds < 946684800 ||
      seconds > Date.now() / 1000 + 300
    )
      return;
    const eventID = `${owner}:${id}`;
    if (state.seen.has(eventID) || state.pending.has(eventID)) return;
    if (state.pending.size >= 100000) {
      state.ready = false;
      return;
    }
    state.pending.set(eventID, {
      id: eventID,
      customer,
      at: new Date(seconds * 1000).toISOString(),
      owner,
      ...(phone ? { phone } : {}),
    });
  };
  state.ready = false;
  try {
    if (platform === "whatsapp") {
      const collections = w.require?.("WAWebCollections");
      const owner = knownOwner;
      const messages = collections?.Msg;
      if (!/^[0-9]{5,20}$/.test(owner) || !messages?.getModelsArray || !messages?.on)
        throw Error("not ready");
      if (state.owner !== owner) {
        state.cleanup?.();
        state.attached = null;
      }
      state.owner = owner;
      state.ready = true;
      const read = (msg: any) => {
        if (
          msg?.id?.fromMe ||
          ![
            "chat",
            "image",
            "video",
            "audio",
            "ptt",
            "document",
            "sticker",
            "location",
            "vcard",
            "multi_vcard",
            "poll_creation",
            "ptv",
          ].includes(msg?.type)
        )
          return;
        const remote = msg.id?.remote;
        const server = remote?.server;
        const user = String(remote?.user || "");
        if (!["c.us", "s.whatsapp.net", "lid"].includes(server) || !/^\d{5,25}$/.test(user)) return;
        const customer = server === "lid" ? `lid:${user}` : user;
        // A resolved phone identity is shared between Cloud API and Web accounts.
        const contact = collections.Contact?.get?.(remote);
        const phone = contact?.phoneNumber?.user;
        add(
          owner,
          String(msg.id?.id || ""),
          customer,
          Number(msg.t),
          server === "lid" && phone && /^[1-9][0-9]{5,19}$/.test(String(phone))
            ? String(phone)
            : undefined,
        );
      };
      if (state.attached !== messages) {
        state.cleanup?.();
        messages.on("add", read);
        state.attached = messages;
        state.cleanup = () => messages.off?.("add", read);
      }
      for (const msg of messages.getModelsArray()) read(msg);
    } else if (platform === "telegram") {
      const root = w.rootScope;
      const owner = String(root?.myId || "");
      if (!/^[1-9][0-9]{0,15}$/.test(owner) || typeof root.addEventListener !== "function")
        throw Error("not ready");
      if (state.owner !== owner) {
        state.cleanup?.();
        state.attached = null;
      }
      state.owner = owner;
      state.ready = true;
      const read = (event: any) => {
        const msg = event?.message && typeof event.message === "object" ? event.message : event;
        const customer = String(msg?.peer_id?.user_id || msg?.peerId || "");
        if (
          msg?._ !== "message" ||
          msg.pFlags?.out ||
          msg.out ||
          !/^[1-9][0-9]{0,15}$/.test(customer) ||
          msg.peer_id?.channel_id ||
          msg.peer_id?.chat_id
        )
          return;
        add(owner, `${customer}:${msg.id || msg.mid || ""}`, customer, Number(msg.date));
      };
      if (state.attached !== root) {
        state.cleanup?.();
        const names = ["history_append", "history_multiappend", "history_update"];
        for (const name of names) root.addEventListener(name, read);
        // The worker returns already cached messages. This does not fetch or read-mark a chat.
        const downloaded = ({ peerId, mids }: any) => {
          if (!/^[1-9][0-9]{0,15}$/.test(String(peerId)) || !Array.isArray(mids)) return;
          for (const mid of mids.slice(0, 1000)) {
            Promise.resolve(root.managers?.appMessagesManager?.getMessageByPeer(peerId, mid))
              .then((message) => {
                if (String(root.myId) === owner) read(message);
              })
              .catch(() => {});
          }
        };
        root.addEventListener("messages_downloaded", downloaded);
        state.attached = root;
        state.cleanup = () => {
          for (const name of names) root.removeEventListener(name, read);
          root.removeEventListener("messages_downloaded", downloaded);
        };
      }
    } else if (platform === "line") {
      const element = document.getElementById("root") as any;
      const key = element && Object.keys(element).find((k) => k.startsWith("__reactContainer$"));
      const fiber = key && element[key];
      const queue = [fiber?.stateNode?.current || fiber];
      const visited = new Set();
      let store: any;
      for (let n = 0; queue.length && n < 500; n++) {
        const node = queue.shift();
        if (!node || visited.has(node)) continue;
        visited.add(node);
        const found = node.memoizedProps?.value?.store;
        if (found?.getState) {
          store = found;
          break;
        }
        queue.push(node.child, node.sibling);
      }
      const auth = store?.getState()?.auth;
      const owner = auth?.profile?.mid;
      if (
        auth?.loginState !== "logged_in" ||
        !/^u[0-9a-f]{32}$/.test(owner) ||
        !store.getState()?.message?.entities?.messages
      )
        throw Error("not ready");
      if (state.owner !== owner) {
        state.cleanup?.();
        state.attached = null;
      }
      state.owner = owner;
      state.ready = true;
      const read = () => {
        const data = store.getState();
        if (data.auth?.profile?.mid !== owner) return;
        for (const msg of Object.values(data.message.entities.messages) as any[]) {
          // Official LINE USER recipient type is 0. Numeric message IDs exclude local pseudo/system records.
          if (
            msg.toType !== 0 ||
            msg.to !== owner ||
            !/^u[0-9a-f]{32}$/.test(msg.from) ||
            !/^\d+$/.test(String(msg.id)) ||
            msg.contentMetadata?.LOC_KEY
          )
            continue;
          add(owner, String(msg.id), msg.from, Number(msg.createdTime) / 1000);
        }
      };
      if (state.attached !== store) {
        state.cleanup?.();
        state.cleanup = store.subscribe(read);
        state.attached = store;
      }
      read();
    }
  } catch {
    state.ready = false;
  }
  const events = [...state.pending.values()]
    .filter((e: any) => e.owner === state.owner)
    .slice(0, 250)
    .map(({ owner, ...event }: any) => event);
  return { owner: state.owner, ready: state.ready, events };
}
