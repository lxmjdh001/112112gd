import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface ArchiveMessage {
  id: string;
  customer: string;
  name?: string;
  direction: "in" | "out";
  body: string;
  kind: string;
  at: string;
  observedAt?: string;
  truncated?: boolean;
}
export interface ArchiveBatch {
  owner: string;
  ready: boolean;
  historyScope: "loaded_only" | "unavailable";
  limited?: boolean;
  messages: ArchiveMessage[];
}
export interface ArchiveQueueScope {
  tenantId: string;
  accountId: string;
  deviceId: string;
}
export interface ArchiveQueueOptions {
  file: string;
  scope: ArchiveQueueScope;
  encrypt: (plain: string) => Buffer;
  decrypt: (encrypted: Buffer) => string;
  limits?: { maxMessages?: number; maxBytes?: number; maxBodyLength?: number };
}
export interface ArchiveAcknowledgement {
  accepted?: number;
  enabled?: boolean;
}
interface Entry {
  owner: string;
  message: ArchiveMessage;
  revision: number;
  limited: boolean;
}
interface StoredQueue {
  version: 1;
  scope: ArchiveQueueScope;
  entries: Entry[];
}
const idString = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);
const keyOf = (owner: string, id: string) => JSON.stringify([owner, id]);
const content = (entry: Entry) => {
  const { observedAt: _observedAt, ...message } = entry.message;
  return createHash("sha256")
    .update(JSON.stringify({ message, limited: entry.limited }))
    .digest("hex");
};

/**
 * Encrypted, tenant/account/device-scoped outbox. The caller must validate the
 * authenticated platform owner before enqueue and use safeStorage callbacks.
 * enqueue resolves only after persistence, so its inputs may then be acknowledged
 * to the collector. A successful send acknowledges every selected message; an
 * response must explicitly enable archiving and accept every selected message.
 */
export class ChatArchiveQueue {
  private readonly options: ArchiveQueueOptions;
  private readonly limits: Required<NonNullable<ArchiveQueueOptions["limits"]>>;
  private entries = new Map<string, Entry>();
  private loaded = false;
  private sequence = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private flushing?: Promise<number>;
  private closing = false;
  private closed = false;
  private closedPromise?: Promise<void>;

  constructor(options: ArchiveQueueOptions) {
    if (
      !options.file ||
      !["tenantId", "accountId", "deviceId"].every((field) =>
        idString(options.scope?.[field as keyof ArchiveQueueScope], 200),
      )
    )
      throw Error("聊天缓存范围无效");
    this.options = {
      ...options,
      scope: {
        tenantId: options.scope.tenantId,
        accountId: options.scope.accountId,
        deviceId: options.scope.deviceId,
      },
    };
    this.limits = {
      maxMessages: options.limits?.maxMessages ?? 5000,
      maxBytes: options.limits?.maxBytes ?? 8 * 1024 * 1024,
      maxBodyLength: options.limits?.maxBodyLength ?? 8000,
    };
    if (!Object.values(this.limits).every((value) => Number.isSafeInteger(value) && value > 0))
      throw Error("聊天缓存容量无效");
  }
  private ensureOpen() {
    if (this.closing || this.closed) throw Error("聊天缓存已关闭");
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => {}).then(operation);
    this.pending = next;
    return next;
  }
  private normalizeMessage(raw: ArchiveMessage): ArchiveMessage {
    if (
      !raw ||
      !idString(raw.id, 512) ||
      !idString(raw.customer, 128) ||
      !["in", "out"].includes(raw.direction) ||
      typeof raw.body !== "string" ||
      [...raw.body].length > this.limits.maxBodyLength ||
      !idString(raw.kind, 32) ||
      typeof raw.at !== "string" ||
      raw.at.length > 64 ||
      (raw.observedAt !== undefined &&
        (typeof raw.observedAt !== "string" || raw.observedAt.length > 64)) ||
      !/^[a-z_]+$/.test(raw.kind) ||
      (raw.name !== undefined && (typeof raw.name !== "string" || [...raw.name].length > 150)) ||
      (raw.truncated !== undefined && typeof raw.truncated !== "boolean")
    )
      throw Error("聊天记录格式或长度无效");
    const at = Date.parse(raw.at);
    const observedAt = raw.observedAt === undefined ? Date.now() : Date.parse(raw.observedAt);
    if (
      !Number.isFinite(at) ||
      !Number.isFinite(observedAt) ||
      at < 946684800000 ||
      observedAt < 946684800000 ||
      at > Date.now() + 300000 ||
      observedAt > Date.now() + 300000
    )
      throw Error("聊天记录时间无效");
    return {
      id: raw.id,
      customer: raw.customer,
      direction: raw.direction,
      body: raw.body,
      kind: raw.kind,
      at: new Date(at).toISOString(),
      observedAt: new Date(observedAt).toISOString(),
      ...(raw.name !== undefined ? { name: raw.name } : {}),
      ...(raw.truncated !== undefined ? { truncated: raw.truncated } : {}),
    };
  }
  private payload(entries: Map<string, Entry>): string {
    const stored: StoredQueue = {
      version: 1,
      scope: this.options.scope,
      entries: [...entries.values()],
    };
    const plain = JSON.stringify(stored);
    if (
      entries.size > this.limits.maxMessages ||
      Buffer.byteLength(plain, "utf8") > this.limits.maxBytes
    )
      throw Error("聊天记录缓存已满，请恢复同步后重试");
    return plain;
  }
  private async load() {
    if (this.loaded) return;
    let encrypted: Buffer;
    try {
      const info = await stat(this.options.file);
      if (info.size > this.limits.maxBytes * 2 + 65536) throw Error("缓存文件过大");
      encrypted = await readFile(this.options.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw new Error("无法读取聊天记录缓存", { cause: error });
    }
    try {
      const stored = JSON.parse(this.options.decrypt(encrypted)) as StoredQueue;
      if (
        !stored ||
        stored.version !== 1 ||
        !stored.scope ||
        !["tenantId", "accountId", "deviceId"].every(
          (field) =>
            stored.scope[field as keyof ArchiveQueueScope] ===
            this.options.scope[field as keyof ArchiveQueueScope],
        ) ||
        !Array.isArray(stored.entries) ||
        stored.entries.length > this.limits.maxMessages
      )
        throw Error("缓存范围不匹配");
      const restored = new Map<string, Entry>();
      let sequence = 0;
      for (const entry of stored.entries) {
        if (
          !entry ||
          !idString(entry.owner, 128) ||
          !Number.isSafeInteger(entry.revision) ||
          entry.revision < 1 ||
          typeof entry.limited !== "boolean"
        )
          throw Error("缓存条目无效");
        const message = this.normalizeMessage(entry.message);
        const key = keyOf(entry.owner, message.id);
        if (restored.has(key)) throw Error("缓存条目标识重复");
        restored.set(key, {
          owner: entry.owner,
          message,
          revision: entry.revision,
          limited: entry.limited,
        });
        sequence = Math.max(sequence, entry.revision);
      }
      this.payload(restored);
      this.entries = restored;
      this.sequence = sequence;
      this.loaded = true;
    } catch (error) {
      // Never replace a corrupted, mismatched or temporarily undecryptable file.
      throw new Error("无法解密或校验聊天记录缓存", { cause: error });
    }
  }
  private async save(entries: Map<string, Entry>) {
    const encrypted = this.options.encrypt(this.payload(entries));
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw Error("无法加密聊天记录缓存");
    await mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.file}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(encrypted);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.options.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async enqueue(batch: ArchiveBatch): Promise<{ accepted: number; pending: number }> {
    this.ensureOpen();
    return this.serialize(async () => {
      await this.load();
      if (
        !batch ||
        !idString(batch.owner, 128) ||
        typeof batch.ready !== "boolean" ||
        !["loaded_only", "unavailable"].includes(batch.historyScope) ||
        (batch.limited !== undefined && typeof batch.limited !== "boolean") ||
        !Array.isArray(batch.messages) ||
        batch.messages.length > 1000 ||
        (batch.messages.length > 0 && (!batch.ready || batch.historyScope !== "loaded_only"))
      )
        throw Error("聊天记录批次无效");
      const candidate = new Map(this.entries);
      let changed = false;
      let sequence = this.sequence;
      for (const raw of batch.messages) {
        const message = this.normalizeMessage(raw);
        const key = keyOf(batch.owner, message.id);
        const previous = candidate.get(key);
        if (
          previous &&
          (previous.message.customer !== message.customer ||
            previous.message.direction !== message.direction ||
            previous.message.at !== message.at)
        )
          throw Error("聊天记录标识发生冲突");
        if (previous && Date.parse(message.observedAt!) < Date.parse(previous.message.observedAt!))
          continue;
        const entry: Entry = {
          owner: batch.owner,
          message,
          revision: 0,
          limited: batch.limited === true || previous?.limited === true,
        };
        if (previous && content(previous) === content(entry)) continue;
        if (!Number.isSafeInteger(sequence + 1)) throw Error("聊天记录修订版本无效");
        entry.revision = ++sequence;
        candidate.set(key, entry);
        changed = true;
      }
      if (changed) {
        await this.save(candidate);
        this.entries = candidate;
        this.sequence = sequence;
      }
      return { accepted: batch.messages.length, pending: this.entries.size };
    });
  }
  async flush(
    owner: string,
    ready: boolean,
    send: (batch: ArchiveBatch) => Promise<ArchiveAcknowledgement | unknown>,
  ): Promise<number> {
    this.ensureOpen();
    if (!idString(owner, 128)) throw Error("聊天记录账号无效");
    if (!ready || this.flushing) return 0;
    const operation = (async () => {
      const selected = await this.serialize(async () => {
        await this.load();
        const selected: Entry[] = [];
        // Pending records may combine several collector batches. Bound the
        // actual UTF-8 payload as well as count (CJK text can use 3 bytes/char).
        let bytes = Buffer.byteLength(
          JSON.stringify({
            owner,
            ready: true,
            historyScope: "loaded_only",
            limited: false,
            messages: [],
          }),
          "utf8",
        );
        for (const entry of this.entries.values()) {
          if (entry.owner !== owner) continue;
          if (selected.length >= 100) break;
          const messageBytes =
            Buffer.byteLength(JSON.stringify(entry.message), "utf8") + (selected.length ? 1 : 0);
          if (bytes + messageBytes > 512 * 1024) {
            if (!selected.length) throw Error("单条聊天记录超过同步容量，请调整采集长度");
            break;
          }
          selected.push(entry);
          bytes += messageBytes;
        }
        return selected;
      });
      if (!selected.length) return 0;
      const acknowledgement = await send({
        owner,
        ready: true,
        historyScope: "loaded_only",
        limited: selected.some((entry) => entry.limited),
        messages: selected.map((entry) => ({ ...entry.message })),
      });
      const ack =
        acknowledgement && typeof acknowledgement === "object"
          ? (acknowledgement as ArchiveAcknowledgement)
          : undefined;
      if (ack?.enabled !== true || ack?.accepted !== selected.length)
        throw Error("聊天记录尚未全部确认，稍后继续同步");
      await this.serialize(async () => {
        const candidate = new Map(this.entries);
        let changed = false;
        for (const entry of selected) {
          const key = keyOf(entry.owner, entry.message.id);
          if (candidate.get(key)?.revision === entry.revision) {
            candidate.delete(key);
            changed = true;
          }
        }
        // A full discard may have removed these entries during the send. Do not
        // recreate its deleted file or require encryption when nothing changed.
        if (!changed) return;
        await this.save(candidate);
        this.entries = candidate;
      });
      return selected.length;
    })();
    this.flushing = operation;
    try {
      return await operation;
    } finally {
      if (this.flushing === operation) this.flushing = undefined;
    }
  }
  /** Explicit opt-out cleanup; no automatic eviction ever discards unsent text. */
  async discard(owner?: string): Promise<void> {
    this.ensureOpen();
    if (owner !== undefined && !idString(owner, 128)) throw Error("聊天记录账号无效");
    await this.serialize(async () => {
      if (owner === undefined) {
        // Opt-out must work even when the keychain is locked or a previous
        // encrypted file is corrupt. Keep the revision sequence monotonic for
        // any in-flight send, but require no decryption or encryption to erase.
        this.entries = new Map();
        this.loaded = true;
        await unlink(this.options.file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        return;
      }
      await this.load();
      const candidate = new Map([...this.entries].filter(([, entry]) => entry.owner !== owner));
      await this.save(candidate);
      this.entries = candidate;
    });
  }
  close(): Promise<void> {
    if (this.closedPromise) return this.closedPromise;
    this.closing = true;
    const active = this.flushing;
    this.closedPromise = (async () => {
      if (active) await active.catch(() => {}); // Failed sends leave the persisted outbox intact.
      try {
        await this.pending;
      } finally {
        this.closed = true;
      }
    })();
    return this.closedPromise;
  }
}
