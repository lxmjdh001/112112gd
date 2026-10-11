import { detectSource, providerLabel } from "./source.js";

// Shared request coalescing for visible message translations and reply previews.
// Incoming jobs are bounded; a reply can run immediately instead of waiting for history.
export class AutomaticTranslator {
  private limitedUntil = 0;
  private values = new Map<string, Promise<string>>();
  private providers = new Map<string, string>();
  private request: (
    text: string,
    target: string,
    source?: string,
  ) => Promise<{ text: string; provider?: string }>;
  constructor(
    request: (
      text: string,
      target: string,
      source?: string,
    ) => Promise<{ text: string; provider?: string }>,
  ) {
    this.request = request;
  }
  provider(text: string, target: string, hint = "") {
    return this.providers.get(target + "\0" + detectSource(text, hint) + "\0" + text) || "";
  }
  translate(text: string, target: string, hint = "") {
    const source = detectSource(text, hint);
    const key = target + "\0" + source + "\0" + text;
    const cached = this.values.get(key);
    if (cached) return cached;
    if (Date.now() < this.limitedUntil)
      return Promise.reject(Error("免费翻译服务暂不可用，已暂停自动请求，请稍后点击重试"));
    const pending = this.request(text, target, source)
      .then((result) => {
        if (!result.text?.trim()) throw Error("未获得译文，请重试");
        this.providers.set(key, providerLabel(result.provider));
        return result.text;
      })
      .catch((error) => {
        this.values.delete(key);
        if (/限流|429|too many requests/i.test(String(error?.message || error)))
          this.limitedUntil = Date.now() + 60000;
        throw error;
      });
    if (this.values.size >= 500) {
      const oldest = this.values.keys().next().value!;
      this.values.delete(oldest);
      this.providers.delete(oldest);
    }
    this.values.set(key, pending);
    return pending;
  }
}
