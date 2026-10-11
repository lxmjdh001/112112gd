// Read only the session owner's JID. Chat contacts and display names must never
// become a billing identity. WhatsApp may change these keys; fail closed to null.
export function currentWhatsAppAccount(storage: Pick<Storage, "getItem">): string | null {
  for (const key of ["last-wid-md", "last-wid"]) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      if (raw.length > 100) return null;
      let value: unknown = raw;
      if (raw.startsWith('"')) value = JSON.parse(raw);
      if (typeof value !== "string") return null;
      const match = /^([1-9][0-9]{6,14})(?::[0-9]+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(value);
      return match?.[1] ?? null;
    } catch {
      /* An invalid modern identity must not fall back to a stale legacy account. */
      return null;
    }
  }
  return null;
}
