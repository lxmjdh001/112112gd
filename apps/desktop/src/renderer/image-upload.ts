import type { AssetContent } from "../shared/customer-tools.ts";

const pictureIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></svg>`;
const sizeLabel = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function mountImageUpload(
  root: HTMLElement,
  existing: AssetContent | undefined,
  error: (text: string) => void,
) {
  root.className = "ct-upload";
  root.innerHTML = `<input class="ct-upload-input" name="image" type="file" accept="image/png,image/jpeg" aria-label="选择图片" hidden />
    <button type="button" class="ct-upload-pick" aria-label="选择上传图片"><span class="ct-upload-icon">${pictureIcon}</span><strong>点击上传图片<span>，或拖拽到这里</span></strong><small>支持 PNG、JPG，单张不超过 5 MB</small></button>
    <div class="ct-upload-selected" hidden><div class="ct-upload-preview"><img alt="已选择的图片预览" /></div><div class="ct-upload-bottom"><div class="ct-upload-info"><strong></strong><small></small></div><div class="ct-upload-actions"><button type="button" data-replace>更换</button><button type="button" data-remove>移除</button></div></div></div><p class="ct-upload-status" role="status"></p>`;
  const input = root.querySelector<HTMLInputElement>("input")!;
  const pick = root.querySelector<HTMLButtonElement>(".ct-upload-pick")!;
  const selected = root.querySelector<HTMLElement>(".ct-upload-selected")!;
  const preview = root.querySelector<HTMLImageElement>("img")!;
  const status = root.querySelector<HTMLElement>(".ct-upload-status")!;
  let content = existing,
    pending: Promise<void> | undefined,
    revision = 0,
    disposed = false,
    disabled = false,
    failure = "";
  const render = (bytes?: number) => {
    pick.hidden = !!content;
    selected.hidden = !content;
    root.classList.toggle("has-image", !!content);
    if (content) {
      preview.src = `data:${content.mime};base64,${content.data}`;
      const name = root.querySelector<HTMLElement>(".ct-upload-info strong")!;
      name.textContent = content.filename || "已保存的图片";
      name.title = name.textContent;
      root.querySelector(".ct-upload-info small")!.textContent =
        `${content.mime === "image/png" ? "PNG" : "JPG"} · ${bytes === undefined ? "已保存" : sizeLabel(bytes)}`;
    } else preview.removeAttribute("src");
  };
  const choose = () => {
    if (!disabled) input.click();
  };
  pick.addEventListener("click", choose);
  root.querySelector("[data-replace]")!.addEventListener("click", choose);
  root.querySelector("[data-remove]")!.addEventListener("click", () => {
    if (disabled) return;
    revision++;
    pending = undefined;
    content = undefined;
    failure = "";
    status.textContent = "";
    input.value = "";
    error("");
    render();
    pick.focus();
  });
  const receive = (files: File[]) => {
    if (disabled || !files.length) return;
    const current = ++revision;
    failure = "";
    error("");
    const file = files[0]!;
    pending = (async () => {
      try {
        if (files.length !== 1) throw Error("请一次选择一张图片");
        if (
          !file.size ||
          file.size > 5 * 1024 * 1024 ||
          !["image/png", "image/jpeg"].includes(file.type)
        )
          throw Error("请选择 5 MB 以内的 PNG 或 JPG 图片");
        status.textContent = "正在读取图片…";
        const url = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(Error("图片读取失败，请重新选择"));
          reader.readAsDataURL(file);
        });
        const image = new Image();
        image.src = url;
        await image.decode().catch(() => {
          throw Error("图片无法预览，请选择有效的 PNG 或 JPG 图片");
        });
        if (disposed || current !== revision) return;
        content = {
          kind: "image",
          mime: file.type,
          filename: file.name,
          data: url.split(",")[1]!,
          body: "",
        };
        render(file.size);
      } catch (e) {
        if (!disposed && current === revision) {
          failure = (e as Error).message;
          error(failure);
        }
      } finally {
        if (!disposed && current === revision) {
          status.textContent = "";
          pending = undefined;
        }
      }
    })();
  };
  input.addEventListener("change", () => {
    receive([...(input.files || [])]);
    input.value = "";
  });
  root.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!disabled) {
      root.classList.add("is-dragging");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  });
  root.addEventListener("dragleave", (event) => {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget))
      root.classList.remove("is-dragging");
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    root.classList.remove("is-dragging");
    receive([...(event.dataTransfer?.files || [])]);
  });
  render();
  return {
    async content() {
      if (pending) await pending;
      if (failure) throw Error(failure);
      if (!content || disposed) throw Error("请先选择一张图片");
      return content;
    },
    setDisabled(value: boolean) {
      disabled = value;
      root.querySelectorAll("button,input").forEach((el) => {
        (el as HTMLButtonElement).disabled = value;
      });
    },
    dispose() {
      disposed = true;
      revision++;
      content = undefined;
      preview.removeAttribute("src");
    },
  };
}
