import { readFile, writeFile, rename, rm } from "node:fs/promises";

export interface LoginPreference {
  remember: boolean;
  code: string;
}

// Separate from session tokens: signing out keeps this opt-in convenience,
// while unchecking it removes the secret even without another login attempt.
export class RememberedLogin {
  private saving = Promise.resolve();
  private file: string;
  private apiURL: string;
  private encrypt: (value: string) => Buffer;
  private decrypt: (value: Buffer) => string;
  constructor(
    file: string,
    apiURL: string,
    encrypt: (value: string) => Buffer,
    decrypt: (value: Buffer) => string,
  ) {
    this.file = file;
    this.apiURL = apiURL;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
  }

  async read(): Promise<LoginPreference> {
    await this.saving.catch(() => {});
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      if (saved.apiURL !== this.apiURL) return { remember: true, code: "" };
      if (saved.remember === false) return { remember: false, code: "" };
      if (saved.remember !== true || typeof saved.encryptedCode !== "string") throw Error();
      const code = this.decrypt(Buffer.from(saved.encryptedCode, "base64"));
      if (code.length < 10 || code.length > 100) throw Error();
      return { remember: true, code };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { remember: true, code: "" };
      throw Error("暂时无法读取已记住的登录码，请手动输入");
    }
  }

  save(code: string | null) {
    const work = this.saving
      .catch(() => {})
      .then(async () => {
        if (code !== null && (code.length < 10 || code.length > 100)) throw Error("登录码格式无效");
        const saved = {
          apiURL: this.apiURL,
          remember: code !== null,
          ...(code === null ? {} : { encryptedCode: this.encrypt(code).toString("base64") }),
        };
        const temporary = this.file + ".tmp";
        try {
          await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.saving = work;
    return work;
  }

  flush() {
    return this.saving;
  }
}
