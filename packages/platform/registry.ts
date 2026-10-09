import type { PlatformAdapter } from "./core/index.ts";
import { whatsapp } from "./whatsapp/index.ts";
const adapters = new Map<string, PlatformAdapter>([[whatsapp.id, whatsapp]]);
export function getPlatform(id: string): PlatformAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error("该平台尚未开放");
  return adapter;
}
