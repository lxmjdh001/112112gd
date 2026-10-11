import { detectAll } from "tinyld";

const supported = [
  "zh",
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
];
// Detection stays on the device. A customer's saved language helps with short,
// ambiguous replies; it never replaces an unambiguous script or strong detection.
export function detectSource(text: string, hint = "") {
  for (const [pattern, language] of [
    [/\p{Script=Hiragana}|\p{Script=Katakana}/u, "ja"],
    [/\p{Script=Hangul}/u, "ko"],
    [/\p{Script=Han}/u, hint === "zh-TW" ? "zh-TW" : "zh-CN"],
    [/\p{Script=Arabic}/u, "ar"],
    [/\p{Script=Thai}/u, "th"],
    [/\p{Script=Devanagari}/u, "hi"],
  ] as const)
    if (pattern.test(text)) return language;
  const candidates = detectAll(text).filter((candidate) => supported.includes(candidate.lang));
  const first = candidates[0];
  const latin = /\p{Script=Latin}/u.test(text) && !/\p{Script=Cyrillic}/u.test(text);
  const validHint =
    supported.includes(hint.split("-")[0]!) &&
    (!latin || ["en", "es", "pt", "fr", "de", "vi", "id"].includes(hint))
      ? hint
      : "";
  const strong =
    first &&
    (first.accuracy >= 0.3 ||
      (first.accuracy >= 0.1 && first.accuracy > (candidates[1]?.accuracy || 0) * 2.5));
  if (!strong && latin) return validHint || "en";
  if (validHint && !strong) return validHint;
  return first?.lang === "zh" ? "zh-CN" : first?.lang || validHint || (latin ? "en" : "");
}

export function providerLabel(provider?: string) {
  return (
    (
      { "google-free": "Google", mymemory: "MyMemory", original: "原文（同语言）" } as Record<
        string,
        string
      >
    )[provider || ""] || ""
  );
}
