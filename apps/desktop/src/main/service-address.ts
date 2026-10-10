export function serviceAddress(value: string): string {
  const target = new URL(value);
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/" ||
    (target.protocol !== "https:" &&
      !(
        target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
      ))
  )
    throw new Error("客户端服务地址配置无效，请联系管理员更新客户端");
  return target.origin;
}
