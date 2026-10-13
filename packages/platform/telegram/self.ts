// Executed in Telegram's main world. Read the authenticated owner, never a
// selected conversation peer. Web K keeps this ID in memory when its local
// passcode encrypts account1/user_auth and removes them from localStorage.
export function liveTelegramAccount(): string | null | undefined {
  try {
    const url = new URL(location.href);
    if (
      url.origin !== "https://web.telegram.org" ||
      !/^\/k\/?$/.test(url.pathname) ||
      !url.searchParams.getAll("account").every((value) => value === "1")
    )
      return null;
    const root = (window as any).rootScope;
    if (!root) return undefined;
    const id = root.myId;
    if (typeof id !== "string" && typeof id !== "number") return null;
    if (typeof id === "number" && !Number.isSafeInteger(id)) return null;
    return /^[1-9][0-9]{0,15}$/.test(String(id)) ? String(id) : null;
  } catch {
    return null;
  }
}
