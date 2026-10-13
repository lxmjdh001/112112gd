import {
  gpuPresets,
  MIN_CHROME_MAJOR,
  MAX_CHROME_MAJOR,
  randomFingerprint,
  userAgentFor,
  validateFingerprint,
  type Fingerprint,
} from "../shared/fingerprint.ts";

export function mountFingerprintForm(host: HTMLElement) {
  const chromeVersion =
    navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || `${MAX_CHROME_MAJOR}.0.0.0`;
  const os = /Windows/.test(navigator.userAgent)
    ? "windows"
    : /Macintosh/.test(navigator.userAgent)
      ? "macos"
      : "linux";
  const base: Fingerprint = {
    version: 1,
    seed: crypto.randomUUID().replaceAll("-", ""),
    os,
    userAgent: userAgentFor(os, chromeVersion),
    gpuVendor: "",
    gpuRenderer: "",
    screenWidth: Math.max(800, screen.width),
    screenHeight: Math.max(600, screen.height),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    hardwareConcurrency: Math.min(64, navigator.hardwareConcurrency || 8),
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8,
    webrtc: "proxy",
    canvasNoise: false,
    audioNoise: false,
    webglNoise: false,
    blockLocalFonts: false,
  };
  let profile = { ...base };
  let custom = false;
  host.className = "fingerprint-card";
  host.innerHTML = `<div class="fp-heading"><div class="fp-title"><h3>指纹配置</h3><span class="fp-status">当前电脑配置</span></div><div class="fp-actions"><button type="button" data-fp-current>使用当前电脑</button><button type="button" data-fp-random>↻ 随机生成</button></div></div>
    <p class="fp-help">随机生成使用当前 Chrome ${chromeVersion.split(".")[0]} 内核；手动版本范围 ${MIN_CHROME_MAJOR}–${chromeVersion.split(".")[0]}。配置随账号保存。</p>
    <div class="fp-grid">
    <label>操作系统<select data-fp="os"><option value="windows">Windows</option><option value="macos">macOS</option><option value="linux">Linux</option></select></label>
    <label class="fp-gpu-preset">GPU 预设<select data-fp-preset><option value="">当前电脑 / 自定义</option></select></label>
    <label class="fp-wide">User-Agent<input data-fp="userAgent" maxlength="512" spellcheck="false" /></label>
    <details class="fp-gpu-manual fp-wide"><summary>手动填写 GPU 厂商与型号</summary><div class="fp-grid"><label>GPU 厂商<input data-fp="gpuVendor" maxlength="240" placeholder="留空使用本机 GPU" /></label>
    <label>GPU 型号<input data-fp="gpuRenderer" maxlength="240" placeholder="留空使用本机 GPU" /></label></div></details>
    <label>屏幕分辨率<div class="fp-resolution"><input data-fp="screenWidth" type="number" min="800" max="7680" aria-label="屏幕宽度" /><span>×</span><input data-fp="screenHeight" type="number" min="600" max="4320" aria-label="屏幕高度" /></div></label>
    <label>时区<input data-fp="timezone" list="fp-timezones" placeholder="Asia/Shanghai" /><datalist id="fp-timezones">${["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Singapore", "Asia/Bangkok", "Asia/Dubai", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "America/Sao_Paulo", "UTC"].map((t) => `<option value="${t}"></option>`).join("")}</datalist></label>
    <label>语言<input data-fp="language" list="fp-languages" placeholder="zh-CN" /><datalist id="fp-languages">${["zh-CN", "zh-TW", "en-US", "en-GB", "ja-JP", "ko-KR", "th-TH", "vi-VN", "pt-BR", "es-ES", "ar-SA"].map((t) => `<option value="${t}"></option>`).join("")}</datalist></label>
    <label>CPU 核心数<input data-fp="hardwareConcurrency" type="number" min="1" max="64" /></label>
    <label>内存<select data-fp="deviceMemory">${[1, 2, 4, 8].map((n) => `<option value="${n}">${n} GB${n === 8 ? " 及以上" : ""}</option>`).join("")}</select></label>
    <label>WebRTC<select data-fp="webrtc"><option value="proxy">禁止非代理 UDP（推荐）</option><option value="disabled">完全禁用</option></select></label>
    </div><details class="fp-privacy"><summary>高级指纹保护</summary><div class="fp-checks">${[
      ["canvasNoise", "Canvas 噪声"],
      ["audioNoise", "音频噪声"],
      ["webglNoise", "WebGL 噪声"],
      ["blockLocalFonts", "禁用本地字体加载"],
    ]
      .map(([key, label]) => `<label><input type="checkbox" data-fp="${key}" />${label}</label>`)
      .join(
        "",
      )}</div><p class="fp-help">噪声按账号固定。完全禁用 WebRTC 会影响通话；字体保护可能改变部分网页字体。</p></details>`;
  const controls = () => [
    ...host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-fp]"),
  ];
  const status = () => {
    host.querySelector(".fp-status")!.textContent = custom ? "自定义 · 随账号保存" : "当前电脑配置";
  };
  const presets = host.querySelector<HTMLSelectElement>("[data-fp-preset]")!;
  const renderPresets = () => {
    presets.replaceChildren(new Option("当前电脑 / 自定义", ""));
    gpuPresets[profile.os].forEach((gpu, i) => presets.add(new Option(gpu[1], String(i))));
    const found = gpuPresets[profile.os].findIndex(
      (gpu) => gpu[1] === profile.gpuRenderer && gpu[0] === profile.gpuVendor,
    );
    presets.value = found < 0 ? "" : String(found);
  };
  function render() {
    for (const el of controls()) {
      const value = profile[el.dataset.fp as keyof Fingerprint];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!value;
      else el.value = String(value);
    }
    renderPresets();
    status();
  }
  for (const el of controls())
    el.addEventListener("input", () => {
      custom = true;
      const key = el.dataset.fp as keyof Fingerprint;
      const value =
        el instanceof HTMLInputElement && el.type === "checkbox"
          ? el.checked
          : ["screenWidth", "screenHeight", "hardwareConcurrency", "deviceMemory"].includes(key)
            ? Number(el.value)
            : el.value;
      profile = { ...profile, [key]: value };
      if (key === "os") {
        profile.userAgent = userAgentFor(profile.os, chromeVersion);
        [profile.gpuVendor, profile.gpuRenderer] = gpuPresets[profile.os][0];
        render();
      } else status();
    });
  presets.addEventListener("change", () => {
    custom = true;
    [profile.gpuVendor, profile.gpuRenderer] =
      presets.value === "" ? ["", ""] : gpuPresets[profile.os][Number(presets.value)];
    render();
  });
  host.querySelector("[data-fp-current]")!.addEventListener("click", () => {
    profile = { ...base };
    custom = false;
    render();
  });
  host.querySelector("[data-fp-random]")!.addEventListener("click", () => {
    profile = randomFingerprint(profile, chromeVersion);
    custom = true;
    render();
  });
  render();
  return { value: () => (custom ? validateFingerprint(profile, chromeVersion) : null) };
}
