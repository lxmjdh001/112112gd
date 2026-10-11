import { cloudLanguages } from "../../../../packages/cloud-chat/index.ts";
import { mountImageUpload } from "./image-upload.ts";
import type {
  CustomerContext,
  CustomerProfile,
  QuickAsset,
  AssetContent,
} from "../shared/customer-tools.ts";
const esc = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const errorText = (e: unknown) =>
  String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': Error: /, "");
const api = <T>(method: string, path: string, body?: unknown) =>
  window.gongdan.toolsRequest<T>(method, path, body);
interface Options {
  toggle(collapsed: boolean): Promise<void>;
  prepare(
    context: CustomerContext,
    asset: QuickAsset,
    content: AssetContent,
    text: string,
  ): Promise<void>;
  language(context: CustomerContext, language: string): Promise<void>;
  translate(context: CustomerContext, text: string, language: string): Promise<string>;
}
export function mountCustomerTools(host: HTMLElement, options: Options) {
  host.className = "customer-sidebar";
  host.innerHTML = `<button class="ct-expand" title="展开客户工具" aria-label="展开客户工具">‹<span>客户工具</span></button><div class="ct-panel"><header class="ct-header"><b>客户工具</b><button class="ct-collapse" title="折叠客户工具" aria-label="折叠客户工具">›</button></header><div class="ct-tabs"><button data-tab="tools" class="active">聊天工具</button><button data-tab="profile">客户资料 / 备注</button></div><div class="ct-customer"><strong></strong><small></small></div><p class="ct-notice" role="status"></p><div class="ct-scroll"><div class="ct-tools-page"><section class="ct-card"><div class="ct-card-head"><h3>快捷图片</h3><button data-new="image">新增图片</button></div><div class="ct-image-library"></div></section><section class="ct-card"><div class="ct-card-head"><h3>话术</h3><button data-new="text">新增话术</button></div><div class="ct-text-library"></div></section><section class="ct-card"><div class="ct-card-head"><h3>客户标签</h3><button class="ct-new-tag">新建标签</button></div><select class="ct-tag-select" aria-label="给当前客户添加标签"><option value="">选择标签…</option></select><div class="ct-tags"></div></section><section class="ct-card"><h3>翻译语言</h3><label>当前客户语言<select class="ct-language" aria-label="当前客户翻译语言">${cloudLanguages.map(([id, name]) => `<option value="${id}">${name}</option>`).join("")}</select></label><p class="ct-help">为这位客户单独保存，快捷话术和聊天翻译沿用此语言。</p></section></div><div class="ct-profile-page" hidden><section class="ct-card"><h3>客户资料</h3><div class="ct-profile-fields"></div></section><section class="ct-card"><h3>销售信息</h3><div class="ct-sales-fields"></div></section><section class="ct-card"><h3>备注</h3><textarea class="ct-notes" maxlength="6000" rows="7" placeholder="记录这位客户的情况…"></textarea></section><div class="ct-profile-actions"><button class="ct-primary ct-save-profile">保存资料</button><button class="ct-reset-profile">取消修改</button></div></div><button class="ct-refresh">刷新工具资料</button></div></div>`;
  const q = <T extends HTMLElement = HTMLElement>(s: string) => host.querySelector<T>(s)!;
  let context: CustomerContext | undefined,
    profile: CustomerProfile | undefined,
    draftDetails: Record<string, string> = {},
    generation = 0,
    disposed = false,
    collapsed = false;
  let assets: QuickAsset[] = [],
    tags: { id: string; name: string }[] = [],
    saving = false;
  let modal: HTMLDialogElement | undefined;
  const filters = {
    image: { scope: "personal", category: "全部", page: 0 },
    text: { scope: "personal", category: "全部", page: 0 },
  };
  const previews = new Map<string, string>();
  const drafts = new Map<string, { details: Record<string, string>; version: number }>();
  const customerKey = (c: CustomerContext) => `${c.accountId}:${c.identifier}`;
  let draftVersion = 0;
  const dirty = () =>
    Object.keys(draftDetails).some((k) => (draftDetails[k] || "") !== (profile?.details[k] || ""));
  const notify = (text: string) => {
    if (!disposed) q(".ct-notice").textContent = text;
  };
  const action = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (e) {
      notify(errorText(e));
    }
  };
  const same = (c: CustomerContext) =>
    !disposed &&
    context?.accountId === c.accountId &&
    context.identifier === c.identifier &&
    context.chatId === c.chatId;
  const current = () => {
    if (!context || !profile) throw Error("请先打开可识别的客户聊天");
    return { ...context };
  };
  function button(text: string, fn: () => void, cls = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.className = cls;
    b.addEventListener("click", fn);
    return b;
  }
  async function dialog(title: string, html: string) {
    if (modal) throw Error("请先关闭当前弹窗");
    await window.gongdan.toolsModal(true);
    if (disposed) {
      await window.gongdan.toolsModal(false);
      throw Error("工具已关闭");
    }
    const d = document.createElement("dialog");
    modal = d;
    d.className = "ct-dialog";
    d.setAttribute("aria-label", title);
    d.innerHTML = `<header><h3>${esc(title)}</h3><button type="button" class="ct-dialog-close" aria-label="关闭">×</button></header>${html}<p class="ct-dialog-error" role="alert"></p>`;
    document.body.append(d);
    d.querySelector(".ct-dialog-close")!.addEventListener("click", () => d.close());
    d.addEventListener(
      "close",
      () => {
        if (modal === d) modal = undefined;
        d.remove();
        void window.gongdan.toolsModal(false).catch(() => {});
      },
      { once: true },
    );
    d.showModal();
    return d;
  }
  async function loadLibrary() {
    const [nextAssets, nextTags] = await Promise.all([
      api<QuickAsset[]>("GET", "/assets"),
      api<{ id: string; name: string }[]>("GET", "/tags"),
    ]);
    if (disposed) return;
    assets = nextAssets;
    tags = nextTags;
    renderLibraries();
    renderTags();
  }
  function renderTags() {
    const select = q<HTMLSelectElement>(".ct-tag-select");
    select.replaceChildren(new Option("选择标签…", ""));
    for (const tag of tags.filter((t) => !profile?.tags.includes(t.id)))
      select.add(new Option(tag.name, tag.id));
    select.disabled = !profile || !context;
    const assigned = q(".ct-tags");
    assigned.replaceChildren();
    if (!context) {
      assigned.textContent = "打开客户聊天后可快速打标签。";
      return;
    }
    if (!profile?.tags.length) {
      assigned.textContent = "这位客户还没有标签。";
      return;
    }
    for (const id of profile.tags) {
      const tag = tags.find((t) => t.id === id);
      if (tag)
        assigned.append(
          button(tag.name + " ×", () => void action(() => setTag(id, false)), "ct-tag"),
        );
    }
  }
  async function setTag(tagId: string, assigned: boolean) {
    const c = current();
    await api("PUT", "/customer/tag", { ...c, tagId, assigned });
    if (!same(c) || !profile) return;
    profile!.tags = assigned
      ? [...new Set([...profile!.tags, tagId])]
      : profile!.tags.filter((t) => t !== tagId);
    renderTags();
  }
  function renderLibrary(kind: "text" | "image") {
    const root = q(`.ct-${kind}-library`),
      f = filters[kind];
    root.replaceChildren();
    const scopes = document.createElement("div");
    scopes.className = "ct-scope";
    for (const [id, name] of [
      ["personal", kind === "text" ? "快捷话术" : "我的图片"],
      ["team", kind === "text" ? "团队话术" : "团队图片"],
    ])
      scopes.append(
        button(
          name!,
          () => {
            f.scope = id!;
            f.category = "全部";
            f.page = 0;
            renderLibrary(kind);
          },
          id === f.scope ? "active" : "",
        ),
      );
    const rows = assets.filter((a) => a.kind === kind && a.scope === f.scope);
    const select = document.createElement("select");
    select.setAttribute("aria-label", kind === "text" ? "话术分类" : "图片分类");
    select.add(new Option("全部分类", "全部"));
    for (const category of [...new Set(rows.map((a) => a.category))])
      select.add(new Option(category, category));
    if (![...select.options].some((o) => o.value === f.category)) f.category = "全部";
    select.value = f.category;
    select.addEventListener("change", () => {
      f.category = select.value;
      f.page = 0;
      renderLibrary(kind);
    });
    root.append(scopes, select);
    const filtered = rows.filter((a) => f.category === "全部" || a.category === f.category);
    f.page = Math.min(f.page, Math.max(0, Math.ceil(filtered.length / 6) - 1));
    const list = document.createElement("div");
    list.className = kind === "image" ? "ct-images" : "ct-replies";
    root.append(list);
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "ct-help";
      empty.textContent =
        kind === "image"
          ? "暂无图片，添加后可快速放入聊天。"
          : "暂无话术，添加常用回复后可重复使用。";
      list.append(empty);
    }
    for (const asset of filtered.slice(f.page * 6, f.page * 6 + 6)) {
      const row = document.createElement("div");
      row.className = "ct-asset";
      const use = button("", () => void action(() => preview(asset)), "ct-asset-use");
      use.title = "预览并放入当前聊天";
      if (kind === "image") {
        const img = document.createElement("img");
        img.alt = asset.title;
        use.append(img);
        if (previews.has(asset.id)) img.src = previews.get(asset.id)!;
        else
          void api<AssetContent>("GET", "/assets/" + asset.id)
            .then((content) => {
              if (disposed) return;
              const src = `data:${content.mime};base64,${content.data}`;
              if (previews.size > 18) previews.clear();
              previews.set(asset.id, src);
              if (img.isConnected) img.src = src;
            })
            .catch(() => {
              if (img.isConnected) img.alt = "图片加载失败，点击重试";
            });
      }
      const title = document.createElement("b");
      title.textContent = asset.title;
      use.append(title);
      if (kind === "text") {
        const text = document.createElement("small");
        text.textContent = asset.body;
        use.append(text);
      }
      const controls = document.createElement("div");
      controls.className = "ct-asset-actions";
      controls.append(
        button("编辑", () => void action(() => editAsset(kind, asset))),
        button("删除", () => void action(() => removeAsset(asset))),
      );
      row.append(use, controls);
      list.append(row);
    }
    if (filtered.length > 6) {
      const pager = document.createElement("div");
      pager.className = "ct-pages";
      const prev = button("上一页", () => {
          f.page--;
          renderLibrary(kind);
        }),
        next = button("下一页", () => {
          f.page++;
          renderLibrary(kind);
        });
      prev.disabled = f.page === 0;
      next.disabled = (f.page + 1) * 6 >= filtered.length;
      pager.append(
        prev,
        document.createTextNode(`${f.page + 1} / ${Math.ceil(filtered.length / 6)}`),
        next,
      );
      root.append(pager);
    }
  }
  function renderLibraries() {
    renderLibrary("image");
    renderLibrary("text");
  }
  async function editAsset(kind: "text" | "image", asset?: QuickAsset) {
    const existing =
      asset?.kind === "image" ? await api<AssetContent>("GET", "/assets/" + asset.id) : undefined;
    const d = await dialog(
      asset ? "编辑素材" : kind === "image" ? "新增快捷图片" : "新增话术",
      `<form><label>名称<input name="title" maxlength="80" required value="${esc(asset?.title || "")}" /></label><label>范围<select name="scope" ${asset ? "disabled" : ""}><option value="personal">个人使用</option><option value="team" ${asset?.scope === "team" ? "selected" : ""}>团队共享</option></select></label><label>分类<input name="category" maxlength="40" value="${esc(asset?.category || "默认")}" /></label>${kind === "text" ? `<label>话术内容<textarea name="body" rows="6" maxlength="4000" required>${esc(asset?.body || "")}</textarea></label>` : `<div class="ct-upload-label">图片</div><div class="ct-image-upload"></div>`}<footer><button class="ct-primary" type="submit">保存</button></footer></form>`,
    );
    const uploader =
      kind === "image"
        ? mountImageUpload(d.querySelector(".ct-image-upload")!, existing, (text) => {
            d.querySelector(".ct-dialog-error")!.textContent = text;
          })
        : undefined;
    d.addEventListener("close", () => uploader?.dispose(), { once: true });
    d.querySelector("form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = d.querySelector<HTMLButtonElement>("[type=submit]")!;
      if (submit.disabled) return;
      submit.disabled = true;
      uploader?.setDisabled(true);
      try {
        const input = (name: string) =>
          d.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            `[name="${name}"]`,
          )!;
        const content = await uploader?.content();
        await api(asset ? "PATCH" : "POST", asset ? "/assets/" + asset.id : "/assets", {
          kind,
          title: input("title").value,
          category: input("category").value,
          scope: asset?.scope || input("scope").value,
          body: kind === "text" ? input("body").value : "",
          mime: content?.mime || "",
          filename: content?.filename || "",
          data: content?.data || "",
          version: asset?.version || 0,
        });
        if (asset) previews.delete(asset.id);
        d.close();
        await loadLibrary();
        notify("素材已保存");
      } catch (e) {
        d.querySelector(".ct-dialog-error")!.textContent = errorText(e);
      } finally {
        submit.disabled = false;
        uploader?.setDisabled(false);
      }
    });
  }
  async function removeAsset(asset: QuickAsset) {
    const d = await dialog(
      "删除素材",
      `<p>删除「${esc(asset.title)}」？${asset.scope === "team" ? "这是团队共享素材。" : ""}</p><footer><button class="ct-delete">删除</button></footer>`,
    );
    d.querySelector(".ct-delete")!.addEventListener(
      "click",
      () =>
        void action(async () => {
          await api("DELETE", "/assets/" + asset.id);
          previews.delete(asset.id);
          d.close();
          await loadLibrary();
        }),
    );
  }
  async function preview(asset: QuickAsset) {
    const c = current();
    const content = await api<AssetContent>("GET", "/assets/" + asset.id);
    if (!same(c)) throw Error("当前客户已切换，请重新选择");
    const d = await dialog(
      "发送预览",
      `<p class="ct-help">当前客户：${esc(c.name || c.identifier)} · ${esc(c.identifier)}</p>${asset.kind === "image" ? `<img class="ct-preview-image" src="data:${content.mime};base64,${content.data}" alt="${esc(asset.title)}" />` : `<textarea rows="7" maxlength="4000" aria-label="待发送话术">${esc(content.body)}</textarea><button class="ct-translate-preview">翻译为客户语言</button>`}<footer><button class="ct-primary ct-use-preview">放入当前聊天</button></footer><p class="ct-help">放入后在聊天窗口确认发送；不会覆盖已有草稿。</p>`,
    );
    d.dataset.customerBound = "true";
    d.querySelector(".ct-translate-preview")?.addEventListener("click", async () => {
      const button = d.querySelector<HTMLButtonElement>(".ct-translate-preview")!;
      if (button.disabled) return;
      button.disabled = true;
      const input = d.querySelector("textarea")!,
        before = input.value;
      try {
        const translated = await options.translate(c, before, profile!.language);
        if (same(c) && d.isConnected && input.value === before) input.value = translated;
      } catch (e) {
        d.querySelector(".ct-dialog-error")!.textContent = errorText(e);
      } finally {
        button.disabled = false;
      }
    });
    d.querySelector(".ct-use-preview")!.addEventListener("click", async () => {
      const b = d.querySelector<HTMLButtonElement>(".ct-use-preview")!;
      if (b.disabled) return;
      b.disabled = true;
      try {
        if (!same(c)) throw Error("当前客户已切换，请重新选择");
        const text = d.querySelector("textarea")?.value || "";
        await window.gongdan.toolsModal(false);
        await options.prepare(c, asset, content, text);
        d.close();
        notify("已放入当前聊天，请确认后发送");
      } catch (e) {
        if (d.isConnected) {
          await window.gongdan.toolsModal(true);
          d.querySelector(".ct-dialog-error")!.textContent = errorText(e);
        }
      } finally {
        b.disabled = false;
      }
    });
  }
  const fields: [string, string, string[]?][] = [
    ["name", "标注"],
    ["phone", "手机号"],
    ["country", "国家 / 地区"],
    ["address", "地址"],
    ["gender", "性别", ["未知", "男", "女"]],
    ["source", "社媒来源"],
  ];
  const sales: [string, string, string[]][] = [
    ["dealStatus", "交易情况", ["未成交", "跟进中", "已付款", "已完成"]],
    ["level", "客户等级", ["普通", "潜在", "重要", "核心"]],
  ];
  function formFields(root: HTMLElement, items: typeof fields) {
    root.replaceChildren();
    for (const [key, name, values] of items) {
      const label = document.createElement("label");
      label.textContent = name;
      const input = values ? document.createElement("select") : document.createElement("input");
      input.setAttribute("data-field", key);
      if (input instanceof HTMLSelectElement) {
        input.add(new Option("未填写", ""));
        for (const value of values!) input.add(new Option(value, value));
      } else {
        input.maxLength = key === "address" ? 500 : key === "phone" ? 60 : 100;
      }
      input.value = draftDetails[key] || "";
      input.disabled = !profile;
      input.addEventListener("input", () => {
        draftDetails[key] = input.value;
      });
      label.append(input);
      root.append(label);
    }
  }
  function renderProfile() {
    formFields(q(".ct-profile-fields"), fields);
    formFields(q(".ct-sales-fields"), sales);
    q<HTMLTextAreaElement>(".ct-notes").value = draftDetails.notes || "";
    q<HTMLTextAreaElement>(".ct-notes").disabled = !profile;
    q<HTMLButtonElement>(".ct-save-profile").disabled = !profile;
    q<HTMLSelectElement>(".ct-language").value = profile?.language || "en";
    q<HTMLSelectElement>(".ct-language").disabled = !profile;
  }
  async function loadCustomer() {
    const c = context ? { ...context } : undefined;
    const ticket = ++generation;
    profile = undefined;
    draftDetails = {};
    renderProfile();
    renderTags();
    if (!c) return;
    let next: CustomerProfile;
    try {
      next = await api<CustomerProfile>("POST", "/customer", c);
    } catch (e) {
      if (ticket === generation && same(c)) throw e;
      return;
    }
    if (ticket !== generation || !same(c)) return;
    profile = next;
    const draft = drafts.get(customerKey(c));
    draftDetails = { ...(draft?.details || next.details) };
    draftVersion = draft?.version ?? next.version;
    renderProfile();
    renderTags();
    await options.language(c, next.language);
    if (draft && same(c)) notify("已恢复这位客户尚未保存的资料");
  }
  q(".ct-notes").addEventListener("input", () => {
    draftDetails.notes = q<HTMLTextAreaElement>(".ct-notes").value;
  });
  q(".ct-save-profile").addEventListener(
    "click",
    () =>
      void action(async () => {
        if (saving) return;
        const c = current(),
          details = { ...draftDetails };
        saving = true;
        q<HTMLButtonElement>(".ct-save-profile").disabled = true;
        try {
          const result = await api<{ version: number }>("PUT", "/customer", {
            ...c,
            details,
            language: profile!.language,
            version: draftVersion,
          });
          const cached = drafts.get(customerKey(c));
          if (cached && JSON.stringify(cached.details) === JSON.stringify(details))
            drafts.delete(customerKey(c));
          if (same(c) && profile) {
            profile!.version = result.version;
            profile!.details = details;
            draftVersion = result.version;
            drafts.delete(customerKey(c));
            notify("客户资料与备注已保存");
          }
        } finally {
          saving = false;
          q<HTMLButtonElement>(".ct-save-profile").disabled = !profile;
        }
      }),
  );
  q(".ct-reset-profile").addEventListener("click", () => {
    draftDetails = { ...profile?.details };
    draftVersion = profile?.version || 0;
    if (context) drafts.delete(customerKey(context));
    renderProfile();
    notify("已取消修改");
  });
  q(".ct-language").addEventListener(
    "change",
    () =>
      void action(async () => {
        if (saving) return;
        const c = current(),
          language = q<HTMLSelectElement>(".ct-language").value;
        saving = true;
        q<HTMLSelectElement>(".ct-language").disabled = true;
        try {
          const result = await api<{ version: number }>("PUT", "/customer", {
            ...c,
            details: profile!.details,
            language,
            version: profile!.version,
          });
          if (same(c) && profile) {
            if (draftVersion === profile!.version) draftVersion = result.version;
            profile!.language = language;
            profile!.version = result.version;
            await options.language(c, language);
            notify("已保存当前客户的翻译语言");
          }
        } finally {
          saving = false;
          q<HTMLSelectElement>(".ct-language").disabled = !profile;
          q<HTMLSelectElement>(".ct-language").value = profile?.language || "en";
        }
      }),
  );
  q<HTMLSelectElement>(".ct-tag-select").addEventListener(
    "change",
    () =>
      void action(async () => {
        const select = q<HTMLSelectElement>(".ct-tag-select");
        if (select.value) await setTag(select.value, true);
      }),
  );
  q(".ct-new-tag").addEventListener(
    "click",
    () =>
      void action(async () => {
        const d = await dialog(
          "新建客户标签",
          '<form><label>标签名称<input name="name" maxlength="30" required /></label><footer><button class="ct-primary" type="submit">创建标签</button></footer></form>',
        );
        d.querySelector("form")!.addEventListener("submit", async (e) => {
          e.preventDefault();
          const b = d.querySelector<HTMLButtonElement>("[type=submit]")!;
          if (b.disabled) return;
          b.disabled = true;
          try {
            await api("POST", "/tags", { name: d.querySelector<HTMLInputElement>("input")!.value });
            d.close();
            await loadLibrary();
          } catch (e) {
            d.querySelector(".ct-dialog-error")!.textContent = errorText(e);
          } finally {
            b.disabled = false;
          }
        });
      }),
  );
  host.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      host.querySelectorAll("[data-tab]").forEach((el) => el.classList.toggle("active", el === b));
      q(".ct-tools-page").hidden = b.dataset.tab !== "tools";
      q(".ct-profile-page").hidden = b.dataset.tab !== "profile";
    }),
  );
  host
    .querySelectorAll<HTMLElement>("[data-new]")
    .forEach((b) =>
      b.addEventListener(
        "click",
        () => void action(() => editAsset(b.dataset.new as "text" | "image")),
      ),
    );
  q(".ct-collapse").addEventListener("click", () => void action(() => options.toggle(true)));
  q(".ct-expand").addEventListener("click", () => void action(() => options.toggle(false)));
  q(".ct-refresh").addEventListener(
    "click",
    () =>
      void action(async () => {
        if (dirty()) throw Error("有未保存的资料，请先保存或取消修改");
        await Promise.all([loadLibrary(), loadCustomer()]);
        notify("已刷新");
      }),
  );
  renderProfile();
  renderTags();
  void action(loadLibrary);
  return {
    update(next: CustomerContext | undefined, isCollapsed: boolean) {
      collapsed = isCollapsed;
      host.classList.toggle("is-collapsed", collapsed);
      const changed =
        context?.accountId !== next?.accountId ||
        context?.identifier !== next?.identifier ||
        context?.chatId !== next?.chatId;
      if (changed && context && profile && dirty()) {
        drafts.set(customerKey(context), { details: { ...draftDetails }, version: draftVersion });
      }
      if (changed && modal?.dataset.customerBound) modal.close();
      context = next;
      q(".ct-customer strong").textContent = next?.name || next?.identifier || "尚未选择客户";
      q(".ct-customer small").textContent =
        next?.identifier || "打开客户聊天后可管理标签、语言与备注";
      if (changed) {
        notify("");
        void action(loadCustomer);
      }
    },
    dispose() {
      disposed = true;
      generation++;
      modal?.close();
      previews.clear();
      drafts.clear();
      host.remove();
    },
  };
}
