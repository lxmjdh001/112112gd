export function serviceConnectionError(error: unknown, address: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const host = new URL(address).hostname;
  if (name === "TimeoutError" || name === "AbortError" || /TIMED_OUT/i.test(detail))
    return new Error(`连接服务器超时（${host}），请检查网络或系统代理后重试`);
  if (/ERR_CERT_|CERTIFICATE|CERT_HAS_EXPIRED|SELF_SIGNED/i.test(detail))
    return new Error("无法验证服务器证书，请检查电脑日期、时间和系统证书后重试");
  if (/ERR_PROXY_|ERR_TUNNEL_/i.test(detail))
    return new Error("系统代理连接失败，请检查代理设置后重试");
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(detail))
    return new Error(`无法解析服务器地址（${host}），请检查网络或 DNS 设置后重试`);
  return new Error(`无法连接服务器（${host}），请检查网络或系统代理后重试`);
}

export async function readServiceResult<T>(response: Response): Promise<{
  code: number;
  data: T;
  message?: string;
}> {
  const unavailable = () =>
    new Error(
      response.status === 429
        ? "请求过于频繁，请稍后重试"
        : response.status === 403
          ? "服务器拒绝了连接，请检查网络后重试，或联系管理员"
          : `服务器响应异常（HTTP ${response.status}），请稍后重试`,
    );
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw unavailable();
  }
  if (!result || typeof result !== "object" || !("code" in result)) throw unavailable();
  const envelope = result as { code: number; data: T; message?: string };
  if (
    typeof envelope.code !== "number" ||
    (envelope.message !== undefined && typeof envelope.message !== "string")
  )
    throw unavailable();
  return envelope;
}
