import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
export interface InboundEvent {
  id: string;
  customer: string;
  at: string;
}
export interface InboundBatch {
  owner: string;
  ready: boolean;
  events: InboundEvent[];
}
// Durable metadata-only outbox. Server acknowledgement, not a timer, removes events.
export class InboundQueue {
  private events: Record<string, InboundEvent & { owner: string }> = {};
  private loaded?: Promise<void>;
  private saving = Promise.resolve();
  private sending = false;
  private file: string;
  private encrypt: (s: string) => Buffer;
  private decrypt: (b: Buffer) => string;
  constructor(file: string, encrypt: (s: string) => Buffer, decrypt: (b: Buffer) => string) {
    this.file = file;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
  }
  private load() {
    return (this.loaded ||= readFile(this.file)
      .then((b) => {
        this.events = JSON.parse(this.decrypt(b));
      })
      .catch((e) => {
        if (e.code !== "ENOENT") throw Error("无法读取进线统计缓存");
      }));
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file + ".tmp", this.encrypt(JSON.stringify(this.events)), { mode: 0o600 });
    await rename(this.file + ".tmp", this.file);
  }
  async enqueue(batch: InboundBatch) {
    const operation = this.saving
      .catch(() => {})
      .then(async () => {
        await this.load();
        for (const e of batch.events) {
          if (Object.keys(this.events).length >= 100000 && !this.events[e.id])
            throw Error("统计缓存已满，请恢复网络");
          this.events[e.id] ||= { ...e, owner: batch.owner };
        }
        await this.save();
      });
    this.saving = operation;
    await operation;
  }
  async flush(owner: string, ready: boolean, send: (batch: InboundBatch) => Promise<unknown>) {
    if (this.sending) return;
    this.sending = true;
    try {
      await this.saving;
      await this.load();
      const selected = Object.values(this.events)
        .filter((e) => e.owner === owner)
        .slice(0, 250);
      await send({ owner, ready, events: selected.map(({ owner, ...e }) => e) });
      const operation = this.saving
        .catch(() => {})
        .then(async () => {
          for (const e of selected) delete this.events[e.id];
          await this.save();
        });
      this.saving = operation;
      await operation;
    } finally {
      this.sending = false;
    }
  }
  async close() {
    await this.saving;
  }
}
