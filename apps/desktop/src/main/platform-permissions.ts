import type { Session, WebContents } from "electron";

function originOf(address: unknown): string | undefined {
  if (typeof address !== "string") return;
  try {
    const url = new URL(address);
    if (url.username || url.password) return;
    if (url.protocol === "https:") return url.origin;
    if (url.protocol === "chrome-extension:" && url.hostname)
      return `${url.protocol}//${url.host}`;
  } catch {
    // Missing, opaque and malformed origins are never permission grants.
  }
}

// Persisting a site's storage protects it from eviction; it does not grant
// camera, microphone, clipboard or third-party storage access.
export function installPlatformPermissions(ses: Session, allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  const permits = (
    contents: WebContents | null,
    permission: string,
    isMainFrame: boolean,
    requestingUrl: string | undefined,
    requestingOrigin?: string,
  ) => {
    try {
      if (
        permission !== "persistent-storage" ||
        isMainFrame !== true ||
        !contents ||
        contents.isDestroyed() ||
        contents.session !== ses
      ) return false;
      const current = originOf(contents.getURL());
      return !!current && allowed.has(current) && originOf(requestingUrl) === current &&
        (requestingOrigin === undefined || originOf(requestingOrigin) === current);
    } catch {
      // A destroyed/navigating WebContents must not turn into a broad grant.
      return false;
    }
  };
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permits(contents, permission, details.isMainFrame, details.requestingUrl));
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    permits(contents, permission, details.isMainFrame, details.requestingUrl, requestingOrigin),
  );
}
