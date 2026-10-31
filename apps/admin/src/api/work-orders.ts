import { api } from "./business";
export interface WorkOrder {
  id: string;
  name: string;
  accountIds: string[];
  startAt: string;
  endAt: string | null;
  resetMinutes: number;
  target: number;
  dedupBaseline: boolean;
  enabled: boolean;
  expiresAt: string | null;
  hasPassword: boolean;
  token: string;
  updatedAt: string;
}
export interface OrderAccount {
  id: string;
  label: string;
  platform: string;
  connectionType: string;
  codes: { id: string; label: string; groupId: string; groupName: string }[];
}
export interface OrderCounts {
  total: number;
  today: number;
  yesterday: number;
  fresh: number;
  duplicate: number;
  todayFresh: number;
  todayDuplicate: number;
}
export interface OrderStats extends OrderCounts {
  name: string;
  platforms: string[];
  startAt: string;
  endAt: string | null;
  resetMinutes: number;
  target: number;
  updatedAt: string;
  accounts: (OrderCounts & {
    id: string;
    label: string;
    nickname: string;
    account: string;
    status: "online" | "offline" | "error";
    platform: string;
    connectionType: string;
    removed: boolean;
    collectorReady: boolean;
    lastSync: string | null;
    firstSync: string | null;
    lastInbound: string | null;
  })[];
}
export const orderAPI = {
  list: () => api.get<WorkOrder[]>("/work-orders"),
  options: () => api.get<OrderAccount[]>("/work-orders/options"),
  stats: (id: string) => api.get<OrderStats>(`/work-orders/${id}/stats`),
};
export const platformLabel = (a: { platform: string; connectionType: string }) =>
  a.connectionType === "cloud"
    ? "WhatsApp API"
    : { whatsapp: "WhatsApp", line: "LINE", telegram: "Telegram" }[a.platform] || a.platform;
export const orderDate = (s: string | null) =>
  s
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(s))
    : "—";
export const orderLink = (token: string) => `${location.origin}${location.pathname}#/s/${token}`;
