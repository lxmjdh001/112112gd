// Inert official-DOM/store fixtures. No network, phone pairing or external delivery.
export function nativeFixture(platform) {
  const line = platform === "line";
  document.body.innerHTML = `<style>body{font:15px system-ui;margin:0;padding:20px}.chat{height:90vh}.messages{padding:10px}.bubble,[data-message-id]{padding:10px;background:#eff8f3;margin:8px}.chat-input,.chatroomEditor-module__editor_area{position:absolute;bottom:10px;left:10px;right:10px;background:white;padding:10px}textarea-ex{display:block;width:100%;height:60px}[contenteditable]{min-height:40px;border:1px solid #ccc}</style><div id="${line ? "root" : "page-chats"}"><div class="chat chatroom-module__chatroom"><header class="chat-info"><b class="peer-title">客户 A</b></header><div class="messages"></div><footer class="${line ? "chatroomEditor-module__editor_area" : "chat-input"}">${line ? "<textarea-ex></textarea-ex>" : '<div contenteditable="true" data-peer-id="100001"></div><button class="btn-send">发送</button>'}</footer></div></div>`;
  if (line)
    customElements.define(
      "textarea-ex",
      class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: "open" }).innerHTML =
            '<textarea style="width:95%;height:50px"></textarea>';
        }
        get inputEl() {
          return this.shadowRoot.querySelector("textarea");
        }
      },
    );
  const f = (window.fixture = {
    platform,
    peer: line ? "u" + "1".repeat(32) : "100001",
    owner: line ? "u" + "9".repeat(32) : "900001",
    sent: [],
    counter: 0,
    paste: [],
    messages: {},
  });
  f.state = {
    auth: { loginState: "logged_in", profile: { mid: f.owner } },
    common: { userStorage: { settings: { chat: { sendKey: "enter" } } } },
    contact: { entities: { contacts: {} } },
    message: { entities: { messages: f.messages } },
  };
  if (line)
    document.querySelector("#root").__reactContainer$fixture = {
      memoizedProps: { value: { store: { getState: () => f.state, subscribe: () => () => {} } } },
    };
  else {
    localStorage.setItem("account1", JSON.stringify({ userId: Number(f.owner) }));
    window.rootScope = {
      myId: f.owner,
      settings: { sendShortcut: "enter" },
      addEventListener() {},
      removeEventListener() {},
    };
  }
  f.editor = () =>
    line
      ? document.querySelector("textarea-ex").inputEl
      : document.querySelector("[contenteditable]");
  f.text = () => (line ? f.editor().value : f.editor().innerText);
  f.message = (text, outgoing = false) => {
    const id = String(++f.counter),
      row = document.createElement("div");
    if (line) {
      row.dataset.messageId = id;
      row.textContent = text;
      f.messages[id] = {
        id,
        text,
        from: outgoing ? f.owner : f.peer,
        to: outgoing ? f.peer : f.owner,
        toType: 0,
        contentType: 0,
        createdTime: String(Date.now()),
      };
    } else {
      row.className = "bubble" + (outgoing ? " is-out" : "");
      row.dataset.mid = id;
      row.dataset.peerId = f.peer;
      row.innerHTML = '<div class="message"></div>';
      row.firstChild.textContent = text;
    }
    document.querySelector(".messages").append(row);
  };
  f.select = (id) => {
    f.peer = id;
    document.querySelector(".messages").replaceChildren();
    if (line) {
      location.hash = "/chats/" + id;
      f.state.contact.entities.contacts[id] = { displayName: "客户 " + id.slice(-2) };
      document.querySelector("textarea-ex").__reactFiber$fixture = {
        memoizedProps: { messageBoxId: id },
      };
      f.editor().value = "";
    } else {
      f.editor().dataset.peerId = id;
      f.editor().textContent = "";
    }
    f.message("Hello customer");
  };
  f.send = () => {
    const text = f.text();
    if (!text.trim()) return;
    f.sent.push({ peer: f.peer, text });
    f.message(text, true);
    if (line) f.editor().value = "";
    else f.editor().textContent = "";
    f.editor().dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  };
  f.editor().addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      if (
        line &&
        f.state.common.userStorage.settings.chat.sendKey === "enter_with_modifier" &&
        !(e.metaKey || e.altKey)
      )
        return;
      e.preventDefault();
      f.send();
    }
  });
  f.editor().addEventListener("paste", (e) =>
    f.paste.push([...e.clipboardData.items].map((x) => x.type)),
  );
  if (!line) document.querySelector(".btn-send").onclick = f.send;
  f.select(f.peer);
}
