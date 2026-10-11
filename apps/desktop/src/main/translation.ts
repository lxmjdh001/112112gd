import { detectSource } from "../../../../packages/translation/source.ts";
export const languages = new Set([
  "zh-CN",
  "zh-TW",
  "en",
  "es",
  "pt",
  "ar",
  "ru",
  "fr",
  "de",
  "ja",
  "ko",
  "vi",
  "th",
  "id",
  "hi",
]);
export interface Translation {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: "google-free" | "mymemory" | "original";
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export function parseGoogle(body: unknown): { text: string; sourceLanguage: string } {
  if (!Array.isArray(body) || !Array.isArray(body[0])) throw new Error("翻译服务返回格式异常");
  const text = body[0]
    .filter((s: unknown) => Array.isArray(s) && typeof s[0] === "string")
    .map((s: string[]) => s[0])
    .join("");
  if (!text) throw new Error("未获得译文，请稍后重试");
  return { text, sourceLanguage: typeof body[2] === "string" ? body[2] : "auto" };
}
// Memory only. Neither source text nor provider URLs are written to logs or disk.
export class FreeTranslator {
  private cache = new Map<string, { at: number; result: Translation }>();
  private inFlight = new Map<string, Promise<Translation>>();
  private timestamps: number[] = [];
  private paused = new Map<string, number>();
  private fetcher: Fetcher;
  private onUsage?: (usage: {
    inputChars: number;
    outputChars: number;
    targetLanguage: string;
    provider: string;
  }) => void;
  constructor(
    fetcher: Fetcher,
    onUsage?: (usage: {
      inputChars: number;
      outputChars: number;
      targetLanguage: string;
      provider: string;
    }) => void,
  ) {
    this.onUsage = onUsage;
    this.fetcher = fetcher;
  }
  async translate(text: string, target: string, source = ""): Promise<Translation> {
    text = text.trim();
    if (!text || [...text].length > 4000) throw new Error("每次翻译 1–4000 个字符");
    if (!languages.has(target)) throw new Error("暂不支持该语言");
    source = detectSource(text, source);
    const key = target + "\0" + source + "\0" + text;
    const saved = this.cache.get(key);
    if (saved && Date.now() - saved.at < 5 * 60000) return saved.result;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    this.timestamps = this.timestamps.filter((t) => Date.now() - t < 60000);
    if (this.timestamps.length >= 120) throw new Error("翻译过于频繁，请稍后重试");
    this.timestamps.push(Date.now());
    const work = this.request(text, target, source)
      .then((result) => {
        if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { at: Date.now(), result });
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }
  private async request(text: string, target: string, source: string): Promise<Translation> {
    const failures: string[] = [];
    for (const provider of ["google-free", "mymemory"] as const) {
      if (Date.now() < (this.paused.get(provider) || 0)) {
        failures.push(
          provider === "google-free" ? "Google 暂时限流或连接失败" : "MyMemory 额度用完或连接失败",
        );
        continue;
      }
      try {
        const signal = AbortSignal.timeout(provider === "google-free" ? 5000 : 20000);
        let result: Translation;
        if (provider === "google-free") {
          const q = new URLSearchParams({
            client: "gtx",
            sl: "auto",
            tl: target,
            dt: "t",
            q: text,
          });
          result = {
            ...parseGoogle(
              await this.json(`https://translate.googleapis.com/translate_a/single?${q}`, signal),
            ),
            targetLanguage: target,
            provider,
          };
        } else {
          if (!source) throw Error("请设置当前客户语言后重试");
          if (source === target)
            return { text, sourceLanguage: source, targetLanguage: target, provider: "original" };
          const output: string[] = [];
          for (const chunk of splitTranslation(text)) {
            const q = new URLSearchParams({
              q: chunk.text,
              langpair: `${source}|${target}`,
              mt: "1",
            });
            const body = (await this.json(
              `https://api.mymemory.translated.net/get?${q}`,
              signal,
            )) as {
              responseStatus?: number | string;
              quotaFinished?: boolean;
              responseData?: { translatedText?: string };
            };
            if (body.quotaFinished || Number(body.responseStatus) === 429) {
              this.paused.set(provider, Date.now() + 60 * 60 * 1000);
              throw Error("MyMemory 今日免费额度已用完，请稍后重试");
            }
            if (Number(body.responseStatus) !== 200 || !body.responseData?.translatedText?.trim())
              throw Error("MyMemory 未返回有效译文");
            output.push(body.responseData.translatedText.trim() + chunk.separator);
          }
          result = {
            text: output.join(""),
            sourceLanguage: source,
            targetLanguage: target,
            provider,
          };
        }
        if ([...result.text].length > 32000) throw Error("翻译结果过长");
        this.onUsage?.({
          inputChars: [...text].length,
          outputChars: [...result.text].length,
          targetLanguage: target,
          provider,
        });
        return result;
      } catch {
        this.paused.set(provider, Math.max(this.paused.get(provider) || 0, Date.now() + 60000));
        failures.push(
          provider === "google-free" ? "Google 暂时限流或连接失败" : "MyMemory 额度用完或连接失败",
        );
      }
    }
    throw Error(failures.join("；") + "。翻译未完成，请稍后重试");
  }
  private async json(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(url, {
      signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw Error("翻译服务暂不可用");
    return response.json();
  }
  clear() {
    this.cache.clear();
    this.timestamps = [];
  }
}

// Retained for the standalone desktop verification script.
export { FreeTranslator as GoogleFreeTranslator };

// MyMemory accepts 500 UTF-8 bytes per request. Preserve all input, split at
// word/sentence boundaries when possible, and preserve paragraph whitespace.
export function splitTranslation(text: string): { text: string; separator: string }[] {
  const result: { text: string; separator: string }[] = [];
  const encoder = new TextEncoder();
  let rest = text.trim();
  while (rest) {
    let end = 0,
      bytes = 0,
      boundary = 0;
    for (const char of rest) {
      const size = encoder.encode(char).length;
      if (bytes + size > 500) break;
      end += char.length;
      bytes += size;
      if (/[\s。！？.!?]/u.test(char)) boundary = end;
    }
    if (end < rest.length && boundary > end / 2) end = boundary;
    const piece = rest.slice(0, end);
    rest = rest.slice(end);
    const space = piece.match(/\s+$/u)?.[0] || rest.match(/^\s+/u)?.[0] || "";
    rest = rest.trimStart();
    result.push({ text: piece.trim(), separator: rest ? space || " " : "" });
  }
  return result;
}
