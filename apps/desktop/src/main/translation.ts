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
  provider: "google-free";
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
export class GoogleFreeTranslator {
  private cache = new Map<string, { at: number; result: Translation }>();
  private inFlight = new Map<string, Promise<Translation>>();
  private timestamps: number[] = [];
  private fetcher: Fetcher;
  private onUsage?: (usage: {
    inputChars: number;
    outputChars: number;
    targetLanguage: string;
  }) => void;
  constructor(
    fetcher: Fetcher,
    onUsage?: (usage: { inputChars: number; outputChars: number; targetLanguage: string }) => void,
  ) {
    this.onUsage = onUsage;
    this.fetcher = fetcher;
  }
  async translate(text: string, target: string): Promise<Translation> {
    text = text.trim();
    if (!text || text.length > 4000) throw new Error("每次翻译 1–4000 个字符");
    if (!languages.has(target)) throw new Error("暂不支持该语言");
    const key = target + "\0" + text;
    const saved = this.cache.get(key);
    if (saved && Date.now() - saved.at < 5 * 60000) return saved.result;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    this.timestamps = this.timestamps.filter((t) => Date.now() - t < 60000);
    if (this.timestamps.length >= 20) throw new Error("翻译过于频繁，请稍后重试");
    this.timestamps.push(Date.now());
    const work = this.request(text, target)
      .then((result) => {
        if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { at: Date.now(), result });
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }
  private async request(text: string, target: string): Promise<Translation> {
    const query = new URLSearchParams({ client: "gtx", sl: "auto", tl: target, dt: "t", q: text });
    let response: Response;
    try {
      response = await this.fetcher(
        `https://translate.googleapis.com/translate_a/single?${query}`,
        {
          signal: AbortSignal.timeout(12000),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        },
      );
    } catch {
      throw new Error("翻译连接失败或超时，请检查代理后重试");
    }
    if (response.status === 429) throw new Error("Google 暂时限流，请稍后重试");
    if (!response.ok) throw new Error(`翻译服务暂不可用（${response.status}）`);
    const result: Translation = {
      ...parseGoogle(await response.json()),
      targetLanguage: target,
      provider: "google-free",
    };
    this.onUsage?.({
      inputChars: [...text].length,
      outputChars: [...result.text].length,
      targetLanguage: target,
    });
    return result;
  }
  clear() {
    this.cache.clear();
    this.timestamps = [];
  }
}
