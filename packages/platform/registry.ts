import type { PlatformAdapter } from "./core/index.ts";
import { whatsapp } from "./whatsapp/index.ts";
import { telegram, isTelegramAccountURL } from "./telegram/index.ts";
import { line } from "./line/index.ts";
const adapters = new Map<string, PlatformAdapter>([whatsapp, telegram, line].map((p) => [p.id, p]));
export function getPlatform(id: string): PlatformAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error("该平台尚未开放");
  return adapter;
}

export function isPlatformURL(platform: string, address: string): boolean {
  try {
    if (platform === "telegram") return isTelegramAccountURL(address);
    const url = new URL(address);
    const origin =
      url.protocol === "chrome-extension:" ? `${url.protocol}//${url.host}` : url.origin;
    return getPlatform(platform).allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

export function validAccountIdentity(platform: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (platform === "whatsapp") return /^[1-9][0-9]{6,14}$/.test(value);
  if (platform === "telegram") return /^[1-9][0-9]{0,15}$/.test(value);
  if (platform === "line") return /^u[0-9a-f]{32}$/.test(value);
  return false;
}
