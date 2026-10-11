import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
export interface OriginalMessage {
  identifier: string;
  source: string;
  text: string;
}
// Original replies stay encrypted on this device, scoped to tenant and account.
export class TranslationHistory {
  private records: Record<string, OriginalMessage> = {};
  private loaded?: Promise<void>;
  private saving = Promise.resolve();
  private closed = false;
  private file: string;
  private encrypt: (text: string) => Buffer;
  private decrypt: (data: Buffer) => string;
  constructor(file: string, encrypt: (text: string) => Buffer, decrypt: (data: Buffer) => string) {
    this.file = file;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
  }
  private load() {
    return (this.loaded ||= readFile(this.file)
      .then((data) => {
        this.records = JSON.parse(this.decrypt(data));
      })
      .catch((e) => {
        if (e.code !== "ENOENT") throw Error("无法读取本机翻译原文");
      }));
  }
  async list(identifier: string) {
    await this.load();
    return Object.fromEntries(
      Object.entries(this.records).filter(([, v]) => v.identifier === identifier),
    );
  }
  async put(id: string, record: OriginalMessage) {
    await this.load();
    if (this.closed) throw Error("账号已关闭");
    this.records[id] = record;
    // Bound local storage. Current replies are retained across page/app restarts.
    while (Object.keys(this.records).length > 5000)
      delete this.records[Object.keys(this.records)[0]!];
    const work = this.saving
      .catch(() => {})
      .then(async () => {
        const bytes = this.encrypt(JSON.stringify(this.records));
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(this.file + ".tmp", bytes, { mode: 0o600 });
        await rename(this.file + ".tmp", this.file);
      });
    this.saving = work;
    await work;
  }
  close() {
    this.closed = true;
    return this.saving;
  }
}
