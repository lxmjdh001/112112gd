export interface Fingerprint {
  version: 1;
  seed: string;
  os: "windows" | "macos" | "linux";
  userAgent: string;
  gpuVendor: string;
  gpuRenderer: string;
  screenWidth: number;
  screenHeight: number;
  timezone: string;
  language: string;
  hardwareConcurrency: number;
  deviceMemory: number;
  webrtc: "proxy" | "disabled";
  canvasNoise: boolean;
  audioNoise: boolean;
  webglNoise: boolean;
  blockLocalFonts: boolean;
}
export const gpuPresets = {
  windows: [
    [
      "Google Inc. (Intel)",
      "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ],
    [
      "Google Inc. (NVIDIA)",
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ],
  ],
  macos: [
    ["Google Inc. (Apple)", "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)"],
    ["Google Inc. (Apple)", "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"],
  ],
  linux: [
    ["Google Inc. (Intel)", "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)"],
  ],
} as const;
export const platformNames = { windows: "Win32", macos: "MacIntel", linux: "Linux x86_64" };
export function userAgentFor(os: Fingerprint["os"], chromeVersion: string) {
  const system = {
    windows: "Windows NT 10.0; Win64; x64",
    macos: "Macintosh; Intel Mac OS X 10_15_7",
    linux: "X11; Linux x86_64",
  }[os];
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}
// Product compatibility floor, stricter than individual sites' legacy minimums.
export const MIN_CHROME_MAJOR = 120;
export const MAX_CHROME_MAJOR = 152;
export function chromeVersionOf(ua: string): string | undefined {
  return /(?:^| )Chrome\/([0-9]+(?:\.[0-9]+){3})(?= |$)/.exec(ua)?.[1];
}
export function validateFingerprint(value: unknown, runtimeVersion?: string): Fingerprint | null {
  if (value == null) return null;
  const p = value as Fingerprint;
  const fail = () => {
    throw Error("指纹配置无效，请检查各项设置");
  };
  if (
    typeof p !== "object" ||
    p.version !== 1 ||
    !/^[0-9a-f]{32}$/.test(p.seed || "") ||
    !Object.hasOwn(platformNames, p.os)
  )
    fail();
  if (
    typeof p.userAgent !== "string" ||
    p.userAgent.length > 512 ||
    !/^[\x20-\x7e]+$/.test(p.userAgent) ||
    !/Chrome\/[0-9]+(?:\.[0-9]+){3}/.test(p.userAgent)
  )
    fail();
  const version = chromeVersionOf(p.userAgent);
  const major = Number(version?.split(".")[0]);
  const maximum = runtimeVersion ? Number(runtimeVersion.split(".")[0]) : MAX_CHROME_MAJOR;
  if (!version || major < MIN_CHROME_MAJOR || major > maximum)
    throw Error(
      `浏览器版本须在 Chrome ${MIN_CHROME_MAJOR}–${maximum} 之间，请使用当前内核版本或重新随机生成`,
    );
  if (/(?:Electron|HeadlessChrome|Edg|OPR)\//.test(p.userAgent))
    throw Error("请使用标准 Chrome 浏览器标识，可点击随机生成重置");
  const osMatches = {
    windows: /Windows NT/,
    macos: /Macintosh; Intel Mac OS X/,
    linux: /X11; Linux/,
  };
  if (!osMatches[p.os].test(p.userAgent)) throw Error("User-Agent 与所选操作系统不一致");
  for (const key of ["gpuVendor", "gpuRenderer"] as const)
    if (typeof p[key] !== "string" || p[key].length > 240 || /[\x00-\x1f\x7f]/.test(p[key])) fail();
  if (!!p.gpuVendor !== !!p.gpuRenderer)
    throw Error("请同时填写 GPU 厂商与型号，或同时留空使用本机 GPU");
  for (const [key, min, max] of [
    ["screenWidth", 800, 7680],
    ["screenHeight", 600, 4320],
    ["hardwareConcurrency", 1, 64],
  ] as const)
    if (!Number.isInteger(p[key]) || p[key] < min || p[key] > max) fail();
  if (![1, 2, 4, 8].includes(p.deviceMemory) || !["proxy", "disabled"].includes(p.webrtc)) fail();
  for (const key of ["canvasNoise", "audioNoise", "webglNoise", "blockLocalFonts"] as const)
    if (typeof p[key] !== "boolean") fail();
  if (
    typeof p.timezone !== "string" ||
    p.timezone.length > 80 ||
    typeof p.language !== "string" ||
    !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(p.language)
  )
    fail();
  try {
    new Intl.DateTimeFormat(p.language, { timeZone: p.timezone });
    Intl.getCanonicalLocales(p.language);
  } catch {
    throw Error("请输入有效的时区和语言，例如 Asia/Shanghai、zh-CN");
  }
  // Return a plain, bounded object, never arbitrary properties from an IPC caller.
  return Object.fromEntries(
    [
      "version",
      "seed",
      "os",
      "userAgent",
      "gpuVendor",
      "gpuRenderer",
      "screenWidth",
      "screenHeight",
      "timezone",
      "language",
      "hardwareConcurrency",
      "deviceMemory",
      "webrtc",
      "canvasNoise",
      "audioNoise",
      "webglNoise",
      "blockLocalFonts",
    ].map((key) => [key, p[key as keyof Fingerprint]]),
  ) as unknown as Fingerprint;
}

// Old saved identities can be outside today's supported range. Repair only
// the browser version at load time; retain account seed, cookies and other settings.
export function compatibleFingerprint(value: unknown, runtimeVersion: string): Fingerprint | null {
  if (value == null) return null;
  const p = value as Fingerprint;
  const version = typeof p.userAgent === "string" ? chromeVersionOf(p.userAgent) : undefined;
  const major = Number(version?.split(".")[0]);
  const maximum = Number(runtimeVersion.split(".")[0]);
  const repaired =
    version && (major < MIN_CHROME_MAJOR || major > maximum)
      ? { ...p, userAgent: p.userAgent.replace(`Chrome/${version}`, `Chrome/${runtimeVersion}`) }
      : p;
  return validateFingerprint(repaired, runtimeVersion);
}

export function randomFingerprint(base: Fingerprint, runtimeVersion: string): Fingerprint {
  const pick = <T>(items: readonly T[]) =>
    items[crypto.getRandomValues(new Uint32Array(1))[0]! % items.length]!;
  const os = pick(["windows", "macos", "linux"] as const);
  const [gpuVendor, gpuRenderer] = pick<readonly [string, string]>(gpuPresets[os]);
  const [screenWidth, screenHeight] = pick([
    [1920, 1080],
    [2560, 1440],
    [1440, 900],
    [1536, 864],
  ]);
  return {
    ...base,
    version: 1,
    seed: crypto.randomUUID().replaceAll("-", ""),
    os,
    userAgent: userAgentFor(os, runtimeVersion),
    gpuVendor,
    gpuRenderer,
    screenWidth,
    screenHeight,
    hardwareConcurrency: pick([4, 8, 12, 16]),
    deviceMemory: pick([4, 8]),
    webrtc: "proxy",
    canvasNoise: true,
    audioNoise: true,
    webglNoise: true,
    // Region preferences describe the user's working language/timezone, not random geography.
    blockLocalFonts: false,
  };
}
