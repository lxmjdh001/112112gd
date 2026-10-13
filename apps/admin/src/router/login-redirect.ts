const ADMIN_HOME_PATH = '/dashboard';

/** Login should resume an internal admin page, never the public site or auth form. */
export function loginRedirectPath(value: unknown): string {
  if (typeof value !== 'string') return ADMIN_HOME_PATH;
  let target = value.trim();
  try {
    // Older login URLs encode the return path a second time. Preserve query
    // escapes in current, already-decoded paths (for example, a literal "%").
    if (!target.startsWith('/')) target = decodeURIComponent(target);
  } catch {
    return ADMIN_HOME_PATH;
  }
  if (!target.startsWith('/') || target.startsWith('//') || /[\\\u0000-\u001f]/.test(target)) {
    return ADMIN_HOME_PATH;
  }
  const path = target.split(/[?#]/, 1)[0]!.replace(/\/+$/, '') || '/';
  if (path === '/' || /^\/(?:home|auth|s)(?:\/|$)/i.test(path)) return ADMIN_HOME_PATH;
  return target;
}
