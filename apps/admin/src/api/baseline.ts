export type Platform = "whatsapp" | "line";
export const platformNames: Record<string, string> = { whatsapp: "WhatsApp", line: "LINE" };
export interface Match {
  duplicateAccount: boolean;
  duplicateIP: boolean;
  baselineMatch: boolean;
  historyMatch: boolean;
}
export interface BaselineRow {
  id: string;
  platform: Platform;
  identifier: string;
  ip: string;
  note: string;
  enabled: boolean;
  accountName: string;
  createdAt: string;
}
export interface Conversation extends Match {
  id: string;
  platform: Platform;
  identifier: string;
  ip: string;
  accountName: string;
  createdAt: string;
  checkedAt: string;
}
export interface ImportRow {
  line: number;
  identifier: string;
  ip: string;
  note: string;
  error?: string;
  status?: string;
}
export interface Preview {
  rows: ImportRow[];
  total: number;
  valid: number;
  invalid: number;
  added: number;
  skipped: number;
}
export interface Batch {
  id: string;
  platform: Platform;
  source: string;
  total: number;
  added: number;
  skipped: number;
  invalid: number;
  errors: ImportRow[];
  accountName: string;
  createdAt: string;
}
export function resultText(m: Match) {
  return m.duplicateAccount || m.duplicateIP ? "重复用户" : "新用户";
}
export function matchText(m: Match) {
  return (
    [m.duplicateAccount ? "账号重复" : "", m.duplicateIP ? "IP 重复" : ""]
      .filter(Boolean)
      .join("、") || "未命中"
  );
}
