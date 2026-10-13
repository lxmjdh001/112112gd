export function validCustomerIdentity(platform: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (platform === "whatsapp") return /^(?:[1-9][0-9]{6,14}|[0-9]{5,30}@lid)$/.test(value);
  if (platform === "line") return /^u[0-9a-f]{32}$/.test(value);
  if (platform === "telegram") return /^[1-9][0-9]{0,15}$/.test(value);
  return false;
}
