export interface ArchivedChatMessage {
  id: string;
  customer: string;
  name?: string;
  direction: "in" | "out";
  body: string;
  kind:
    | "text"
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "location"
    | "contact"
    | "poll";
  at: string;
  observedAt: string;
  truncated?: boolean;
}

// Self-contained: executed in an authenticated platform's main world only after
// the team enables archiving. Reads loaded stores; never loads history, opens a
// conversation, marks it read, downloads media, or sends anything.
export function collectChatArchive(platform: string, ack: string[] = [], knownOwner = "") {
  const w = window as any;
  const state = (w.__d1ChatArchiveV1 ||= {
    owner: "",
    platform: "",
    attached: null,
    pending: new Map(),
    seen: new Set(),
    requested: new Set(),
    resolved: new Set(),
    cleanup: undefined,
    cursor: 0,
    epoch: 0,
    limited: false,
    requireMessageOwner: false,
  });
  const unavailable = () => ({
    owner: "",
    ready: false,
    historyScope: "unavailable" as const,
    messages: [] as ArchivedChatMessage[],
    ...(state.limited ? { limited: true } : {}),
  });
  const ownerIsCurrent = (owner: string) => {
    if (w.__d1ChatArchiveV1 !== state || state.owner !== owner || state.platform !== platform)
      return false;
    try {
      if (platform === "telegram") return String(w.rootScope?.myId || "") === owner;
      if (platform === "line")
        return (
          state.store?.getState()?.auth?.loginState === "logged_in" &&
          state.store.getState().auth.profile?.mid === owner
        );
      if (platform === "whatsapp") {
        if (!document.querySelector("#pane-side")) return false;
        const storage = w.localStorage;
        if (!storage?.getItem) return false;
        for (const key of ["last-wid-md", "last-wid"]) {
          let raw = storage.getItem(key);
          if (!raw) continue;
          if (typeof raw !== "string" || raw.length > 100) return false;
          if (raw.startsWith('"')) raw = JSON.parse(raw);
          const match =
            typeof raw === "string" &&
            /^([1-9][0-9]{6,14})(?::[0-9]+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(raw);
          return !!match && match[1] === owner;
        }
      }
    } catch {
      /* Session switching is not a valid archive source. */
    }
    return false;
  };
  const bindOwner = (owner: string) => {
    if (state.owner === owner && state.platform === platform) return;
    state.cleanup?.();
    state.cleanup = undefined;
    state.attached = null;
    state.owner = owner;
    state.platform = platform;
    state.epoch++;
    state.pending.clear();
    state.seen.clear();
    state.requested.clear();
    state.resolved.clear();
    state.cursor = 0;
    state.limited = false;
    state.requireMessageOwner = false;
  };
  const add = (
    owner: string,
    sourceID: unknown,
    customer: string,
    direction: "in" | "out",
    body: unknown,
    kind: ArchivedChatMessage["kind"],
    seconds: number,
    name?: unknown,
  ) => {
    if (
      !ownerIsCurrent(owner) ||
      !customer ||
      customer === owner ||
      (typeof sourceID !== "string" && typeof sourceID !== "number")
    )
      return;
    const source = String(sourceID);
    if (
      !source ||
      source.length > 128 ||
      /[\x00-\x1f\x7f]/.test(source) ||
      !Number.isFinite(seconds) ||
      seconds < 946684800 ||
      seconds > Date.now() / 1000 + 300
    )
      return;
    const id = `${owner}:${customer}:${direction}:${source}`;
    if (state.seen.has(id) || state.pending.has(id)) return;
    let text = typeof body === "string" ? body.replace(/\u0000/g, "") : "";
    if (kind === "text" && !text.trim()) return;
    const points = [...text];
    const truncated = points.length > 8000;
    if (truncated) text = points.slice(0, 8000).join("");
    if (state.pending.size >= 5000) {
      state.limited = true;
      return;
    }
    const message: ArchivedChatMessage = {
      id,
      customer,
      direction,
      body: text,
      kind,
      at: new Date(seconds * 1000).toISOString(),
      observedAt: new Date().toISOString(),
      ...(typeof name === "string" && name.trim()
        ? { name: [...name.replace(/\u0000/g, "").trim()].slice(0, 150).join("") }
        : {}),
      ...(truncated ? { truncated: true } : {}),
    };
    state.pending.set(id, message);
  };
  const scan = (values: any[], read: (item: any) => void) => {
    if (!Array.isArray(values) || !values.length) return;
    const start = state.cursor % values.length,
      length = Math.min(values.length, 5000);
    for (let n = 0; n < length; n++) read(values[(start + n) % values.length]);
    state.cursor = (start + length) % values.length;
    if (values.length > length) state.limited = true;
  };
  const acknowledge = () => {
    for (const id of Array.isArray(ack) ? ack.slice(0, 100) : []) {
      if (typeof id !== "string" || !id.startsWith(state.owner + ":") || !state.pending.has(id))
        continue;
      state.pending.delete(id);
      state.seen.add(id);
    }
    while (state.seen.size > 50000) state.seen.delete(state.seen.values().next().value);
  };
  try {
    if (platform === "whatsapp") {
      if (!/^[1-9][0-9]{6,14}$/.test(knownOwner) || !document.querySelector("#pane-side"))
        return unavailable();
      // Validate the live owner before touching Meta's lazy module loader.
      const previous = state.owner,
        previousPlatform = state.platform;
      state.owner = knownOwner;
      state.platform = platform;
      const matches = ownerIsCurrent(knownOwner);
      state.owner = previous;
      state.platform = previousPlatform;
      if (!matches) return unavailable();
      const collections = w.require?.("WAWebCollections"),
        messages = collections?.Msg;
      if (typeof messages?.getModelsArray !== "function" || typeof messages?.on !== "function")
        return unavailable();
      const reusedOwnerSource =
        !!state.owner && state.owner !== knownOwner && state.attached === messages;
      const sameOwnerNewSource =
        state.owner === knownOwner && state.attached && state.attached !== messages;
      bindOwner(knownOwner);
      if (reusedOwnerSource) state.requireMessageOwner = true;
      else if (sameOwnerNewSource) state.requireMessageOwner = false;
      acknowledge();
      const read = (msg: any) => {
        if (!msg || typeof msg.id?.fromMe !== "boolean") return;
        const selfEndpoint = msg.id.fromMe ? msg.from : msg.to;
        const ownUser =
          typeof selfEndpoint === "string"
            ? /^([1-9][0-9]{6,14})(?::[0-9]+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(selfEndpoint)?.[1]
            : typeof selfEndpoint?.user === "string" &&
                ["c.us", "s.whatsapp.net"].includes(selfEndpoint.server)
              ? selfEndpoint.user.split(":")[0]
              : undefined;
        if (
          (ownUser && ownUser !== knownOwner) ||
          (state.requireMessageOwner && ownUser !== knownOwner)
        )
          return;
        const kinds: Record<string, ArchivedChatMessage["kind"]> = {
          chat: "text",
          image: "image",
          video: "video",
          audio: "audio",
          ptt: "audio",
          document: "document",
          sticker: "sticker",
          location: "location",
          vcard: "contact",
          multi_vcard: "contact",
          poll_creation: "poll",
          ptv: "video",
        };
        const kind = kinds[msg.type];
        if (!kind) return;
        const remote = msg.id.remote,
          server = remote?.server,
          user = String(remote?.user || "");
        if (
          !["c.us", "s.whatsapp.net", "lid"].includes(server) ||
          !(server === "lid" ? /^[1-9][0-9]{4,24}$/ : /^[1-9][0-9]{5,19}$/).test(user)
        )
          return;
        const customer = server === "lid" ? "lid:" + user : user;
        const contact = collections.Contact?.get?.(remote);
        add(
          knownOwner,
          msg.id.id,
          customer,
          msg.id.fromMe ? "out" : "in",
          msg.body ?? msg.caption,
          kind,
          Number(msg.t),
          contact?.name || contact?.formattedName || contact?.pushname,
        );
      };
      if (state.attached !== messages) {
        state.cleanup?.();
        messages.on("add", read);
        state.attached = messages;
        state.cleanup = () => messages.off?.("add", read);
      }
      scan(messages.getModelsArray(), read);
    } else if (platform === "telegram") {
      const root = w.rootScope,
        owner = String(root?.myId || "");
      if (!/^[1-9][0-9]{0,15}$/.test(owner) || typeof root?.addEventListener !== "function")
        return unavailable();
      if (
        document.querySelector(".passcode-lock-screen")?.getClientRects().length ||
        document.querySelector("#auth-pages")?.getClientRects().length
      )
        return unavailable();
      const reusedOwnerSource = !!state.owner && state.owner !== owner && state.attached === root;
      const sameOwnerNewSource = state.owner === owner && state.attached && state.attached !== root;
      bindOwner(owner);
      if (reusedOwnerSource) state.requireMessageOwner = true;
      else if (sameOwnerNewSource) state.requireMessageOwner = false;
      acknowledge();
      const read = (message: any, peerHint = "") => {
        const msg =
          message?.message && typeof message.message === "object" ? message.message : message;
        if (msg?._ !== "message" || msg.peer_id?.channel_id || msg.peer_id?.chat_id) return;
        const outgoing = !!(msg.pFlags?.out || msg.out);
        const selfEndpoint = outgoing ? msg.from_id?.user_id || msg.fromId : msg.peer_id?.user_id;
        // A normalized inbound peer may name the customer, so it is not an
        // explicit self endpoint. After an in-place account switch only a
        // confirmed self endpoint can associate old cached objects to an owner.
        const confirmsOwner = String(selfEndpoint || "") === owner;
        if (
          (outgoing && selfEndpoint && !confirmsOwner) ||
          (state.requireMessageOwner && !confirmsOwner)
        )
          return;
        let peer = String(msg.peerId || msg.peer_id?.user_id || peerHint || "");
        if (!outgoing && peer === owner) peer = String(msg.from_id?.user_id || msg.fromId || "");
        if (!/^[1-9][0-9]{0,15}$/.test(peer) || peer === owner) return;
        const source = msg.id || msg.mid;
        if (!/^[1-9][0-9]{0,19}$/.test(String(source || ""))) return;
        const media: Record<string, ArchivedChatMessage["kind"]> = {
          messageMediaPhoto: "image",
          messageMediaDocument: "document",
          messageMediaGeo: "location",
          messageMediaVenue: "location",
          messageMediaContact: "contact",
          messageMediaPoll: "poll",
        };
        const kind = msg.media ? media[msg.media._] : "text";
        if (!kind) return;
        const users = root.managers?.appUsersManager?.usersStorage;
        const user =
          users instanceof Map ? users.get(peer) || users.get(Number(peer)) : users?.[peer];
        const name =
          user &&
          [user.first_name, user.last_name].filter((x: unknown) => typeof x === "string").join(" ");
        add(
          owner,
          source,
          peer,
          outgoing ? "out" : "in",
          msg.message,
          kind,
          Number(msg.date),
          name,
        );
      };
      // getMessageByPeer is the existing loaded-message lookup used by inbound
      // statistics. Only IDs already emitted/downloaded/rendered are requested.
      const downloaded = ({ peerId, mids }: any) => {
        const peer = String(peerId || ""),
          getter = root.managers?.appMessagesManager?.getMessageByPeer;
        if (
          !/^[1-9][0-9]{0,15}$/.test(peer) ||
          peer === owner ||
          !Array.isArray(mids) ||
          typeof getter !== "function"
        )
          return;
        if (mids.length > 1000) state.limited = true;
        for (const mid of mids.slice(-1000)) {
          if (!Number.isSafeInteger(Number(mid)) || Number(mid) <= 0) continue;
          const key = `${owner}:${peer}:${mid}`;
          if (state.requested.has(key) || state.resolved.has(key)) continue;
          if (state.requested.size >= 10000) {
            state.limited = true;
            break;
          }
          state.requested.add(key);
          const epoch = state.epoch;
          Promise.resolve()
            .then(() => getter.call(root.managers.appMessagesManager, Number(peer), Number(mid)))
            .then((message) => {
              if (state.epoch !== epoch || !ownerIsCurrent(owner)) return;
              if (message) {
                read(message, peer);
                state.resolved.add(key);
                while (state.resolved.size > 50000)
                  state.resolved.delete(state.resolved.values().next().value);
              }
            })
            .catch(() => {
              /* An unavailable cached record can be retried. */
            })
            .finally(() => {
              if (state.epoch === epoch) state.requested.delete(key);
            });
        }
      };
      const event = (value: any) => {
        if (!ownerIsCurrent(owner)) return;
        if (Array.isArray(value)) {
          for (const item of value.slice(-1000)) read(item);
          return;
        }
        if (value?.mids) downloaded(value);
        if (Array.isArray(value?.messages)) {
          for (const item of value.messages.slice(-1000)) read(item);
        }
        read(value);
      };
      if (state.attached !== root) {
        state.cleanup?.();
        const events = ["history_append", "history_multiappend", "history_update"];
        for (const name of events) root.addEventListener(name, event);
        root.addEventListener("messages_downloaded", downloaded);
        state.attached = root;
        state.cleanup = () => {
          for (const name of events) root.removeEventListener(name, event);
          root.removeEventListener("messages_downloaded", downloaded);
        };
      }
      const rows = document.querySelectorAll?.(".bubble[data-mid][data-peer-id]") || [];
      const byPeer = new Map<string, number[]>();
      for (const row of [...rows].slice(-1000) as HTMLElement[]) {
        const peer = row.dataset.peerId || "",
          mid = Number(row.dataset.mid);
        if (!/^[1-9][0-9]{0,15}$/.test(peer) || !Number.isSafeInteger(mid) || mid <= 0) continue;
        const ids = byPeer.get(peer) || [];
        ids.push(mid);
        byPeer.set(peer, ids);
      }
      for (const [peerId, mids] of byPeer) downloaded({ peerId, mids });
    } else if (platform === "line") {
      const element = document.getElementById("root") as any;
      const key = element && Object.keys(element).find((k) => k.startsWith("__reactContainer$"));
      const fiber = key && element[key],
        queue = [fiber?.stateNode?.current || fiber],
        visited = new Set();
      let store: any;
      for (let n = 0; queue.length && n < 500; n++) {
        const node = queue.shift();
        if (!node || visited.has(node)) continue;
        visited.add(node);
        const candidate = node.memoizedProps?.value?.store;
        if (typeof candidate?.getState === "function") {
          store = candidate;
          break;
        }
        queue.push(node.child, node.sibling);
      }
      const data = store?.getState(),
        owner = data?.auth?.profile?.mid;
      if (
        data?.auth?.loginState !== "logged_in" ||
        !/^u[0-9a-f]{32}$/.test(owner) ||
        !data.message?.entities?.messages ||
        typeof store.subscribe !== "function"
      )
        return unavailable();
      bindOwner(owner);
      state.store = store;
      acknowledge();
      const read = () => {
        if (!ownerIsCurrent(owner)) return;
        const current = store.getState(),
          messages = current.message?.entities?.messages || {};
        const kinds: Record<number, ArchivedChatMessage["kind"]> = {
          0: "text",
          1: "image",
          2: "video",
          3: "audio",
          7: "sticker",
          13: "contact",
          14: "document",
        };
        scan(Object.values(messages), (msg: any) => {
          if (
            Number(msg?.toType) !== 0 ||
            !/^\d{1,30}$/.test(String(msg?.id || "")) ||
            msg.contentMetadata?.LOC_KEY
          )
            return;
          const out = msg.from === owner && /^u[0-9a-f]{32}$/.test(msg.to);
          const incoming = msg.to === owner && /^u[0-9a-f]{32}$/.test(msg.from);
          if (!out && !incoming) return;
          const peer = out ? msg.to : msg.from,
            kind = kinds[Number(msg.contentType)];
          if (!kind) return;
          const contact = current.contact?.entities?.contacts?.[peer];
          add(
            owner,
            msg.id,
            peer,
            out ? "out" : "in",
            msg.text,
            kind,
            Number(msg.createdTime) / 1000,
            contact?.displayNameOverridden || contact?.displayName,
          );
        });
      };
      if (state.attached !== store) {
        state.cleanup?.();
        state.cleanup = store.subscribe(read);
        state.attached = store;
      }
      read();
    } else return unavailable();
  } catch {
    return unavailable();
  }
  let bytes = 0;
  const messages: ArchivedChatMessage[] = [];
  for (const message of state.pending.values() as Iterable<ArchivedChatMessage>) {
    if (messages.length >= 100) break;
    // UTF-8 upper bound including JSON escaping. Conservative bound avoids a
    // payload overrun for non-ASCII text without relying on a global encoder.
    const size = JSON.stringify(message).length * 3;
    if (bytes + size > 500_000) {
      state.limited = true;
      break;
    }
    bytes += size;
    messages.push({ ...message });
  }
  return {
    owner: state.owner as string,
    ready: true,
    historyScope: "loaded_only" as const,
    messages,
    ...(state.limited ? { limited: true } : {}),
  };
}

// Also self-contained for execution in the platform's main world. Called when
// the team setting is disabled, the slot logs out, or its owner changes.
export function disposeChatArchive() {
  const w = window as any,
    state = w.__d1ChatArchiveV1;
  if (!state) return;
  state.epoch++;
  state.cleanup?.();
  state.pending?.clear();
  state.seen?.clear();
  state.requested?.clear();
  state.resolved?.clear();
  delete w.__d1ChatArchiveV1;
}
