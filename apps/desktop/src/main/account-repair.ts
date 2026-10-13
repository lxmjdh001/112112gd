import type { Session } from "electron";

// The caller must close the account's view first. Never delete profile folders
// while Chromium owns them, and never reset other account partitions.
export async function repairAccountStorage(ses: Session, resetLogin: boolean) {
  await ses.closeAllConnections();
  await ses.clearCache();
  if (resetLogin) {
    await ses.clearStorageData();
    await ses.clearAuthCache();
  } else {
    // Re-fetch the website code, retaining cookies, localStorage and IndexedDB.
    await ses.clearStorageData({ storages: ["serviceworkers", "cachestorage"] });
  }
  ses.flushStorageData();
}
