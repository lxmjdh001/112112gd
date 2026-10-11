import { readFile, writeFile, rename } from "node:fs/promises";
interface Removal {
  tenantId: string;
  codeId: string;
  accountId: string;
}
const uuid = /^[0-9a-f-]{36}$/;

// Persist only identifiers, never platform credentials. If a server removal
// succeeds but the process exits before clearing storage, the next sync retries.
export class AccountCleanup {
  private entries: Removal[] = [];
  private file: string;
  private clear: (tenant: string, account: string) => Promise<void>;
  constructor(file: string, clear: (tenant: string, account: string) => Promise<void>) {
    this.file = file;
    this.clear = clear;
  }
  async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!Array.isArray(data)) throw Error("Invalid cleanup queue");
      this.entries = data.filter(
        (e) =>
          e &&
          [e.tenantId, e.codeId, e.accountId].every((v) => typeof v === "string" && uuid.test(v)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async save() {
    await writeFile(this.file + ".tmp", JSON.stringify(this.entries), { mode: 0o600 });
    await rename(this.file + ".tmp", this.file);
  }
  async remember(entry: Removal) {
    if (!this.entries.some((e) => e.tenantId === entry.tenantId && e.accountId === entry.accountId))
      this.entries.push(entry);
    await this.save();
  }
  async finish(tenant: string, account: string) {
    await this.clear(tenant, account);
    this.entries = this.entries.filter((e) => e.tenantId !== tenant || e.accountId !== account);
    await this.save();
  }
  async reconcile(tenant: string, code: string, accounts: Set<string>) {
    for (const entry of [...this.entries]) {
      if (entry.tenantId === tenant && entry.codeId === code && !accounts.has(entry.accountId))
        await this.finish(tenant, entry.accountId);
    }
  }
}
