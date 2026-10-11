import { ipcRenderer } from "electron";
// New native integrations retain selected-text translation while their automatic
// message/customer adapters are developed separately from account login.
export function installNativeTranslation() {
  ipcRenderer.on("wa:selection", async (_event, selected: string) => {
    document.getElementById("d1-native-translation")?.remove();
    const host = document.createElement("div");
    host.id = "d1-native-translation";
    host.style.cssText = "position:fixed;right:20px;bottom:24px;z-index:2147483647";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>section{width:320px;padding:18px;background:white;color:#24382f;border:1px solid #dae6df;border-radius:14px;box-shadow:0 8px 32px #0002;font:13px/1.6 system-ui}header{display:flex;justify-content:space-between}button{border:0;border-radius:7px;padding:6px 10px;cursor:pointer;background:#ecf6f0;color:#19754b}select{padding:6px;border:1px solid #dae6df;border-radius:7px;background:white}p,output{display:block;white-space:pre-wrap;max-height:200px;overflow:auto}p{color:#83948a;font-size:12px}footer{display:flex;justify-content:space-between;gap:10px;margin-top:14px}</style><section><header><b>翻译选中文字</b><button aria-label="关闭翻译">×</button></header><p></p><output>正在翻译…</output><footer><select aria-label="目标语言"><option value="zh-CN">简体中文</option><option value="en">英语</option><option value="zh-TW">繁体中文</option><option value="ja">日语</option><option value="th">泰语</option><option value="ru">俄语</option><option value="es">西班牙语</option><option value="pt">葡萄牙语</option></select><button class="copy" disabled>复制译文</button></footer></section>`;
    root.querySelector("p")!.textContent = selected;
    root.querySelector("header button")!.addEventListener("click", () => host.remove());
    const output = root.querySelector("output")!;
    const language = root.querySelector("select")!;
    const copy = root.querySelector<HTMLButtonElement>(".copy")!;
    let generation = 0;
    async function translate() {
      const current = ++generation;
      copy.disabled = true;
      output.textContent = "正在翻译…";
      try {
        const result = await ipcRenderer.invoke("wa:translate", {
          text: selected.slice(0, 4000),
          target: language.value,
        });
        if (current !== generation || !host.isConnected) return;
        output.textContent = result.text;
        copy.disabled = false;
      } catch {
        if (current === generation) output.textContent = "翻译暂时不可用，请稍后重试。";
      }
    }
    language.addEventListener("change", () => void translate());
    copy.addEventListener(
      "click",
      () =>
        void ipcRenderer
          .invoke("wa:copy", output.textContent)
          .then(() => {
            copy.textContent = "已复制";
          })
          .catch(() => {
            copy.textContent = "复制失败";
          }),
    );
    document.body.append(host);
    void translate();
  });
}
