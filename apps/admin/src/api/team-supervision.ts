import { api } from "./business";

export interface TeamFilters {
  search: string;
  platform: string;
  codeId: string;
  startAt: string;
  endAt: string;
  page: number;
  pageSize: number;
}
export interface TeamOptions {
  codes: { id: string; label: string }[];
  platforms: { id: string; name: string }[];
}
export interface TeamSettings {
  enabled: boolean;
  updatedAt?: string | null;
  historyScope?: "loaded_only";
}
export interface TeamOverview {
  newCustomers: number;
  customers: number;
  inbound: number;
  outbound: number;
  messages?: number;
}
export interface TeamCustomer {
  id: string;
  customer: string;
  name: string;
  platform: string;
  accountId: string;
  accountLabel: string;
  codeId: string;
  codeLabel: string;
  firstAt: string | null;
  lastAt: string | null;
  lastSyncAt?: string | null;
  inbound: number;
  outbound: number;
}
export interface TeamPage<T> {
  items: T[];
  total: number;
}
export interface TeamMessage {
  id: string;
  direction: "in" | "out";
  body: string;
  kind: string;
  at: string;
  truncated?: boolean;
}
export interface TeamMessages extends TeamPage<TeamMessage> {
  historyScope: "loaded_only" | "cloud_retained" | "unavailable";
  collectorReady?: boolean;
  limited?: boolean;
  lastSyncAt?: string | null;
}
function query(filters: Partial<TeamFilters> & { scope?: "leads" }) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "" && value !== undefined && value !== null) q.set(key, String(value));
  }
  return q.toString();
}
export const teamSupervision = {
  options: () => api.get<TeamOptions>("/team/options"),
  settings: () => api.get<TeamSettings>("/team/settings"),
  updateSettings: (enabled: boolean) =>
    api.request<TeamSettings>("/team/settings", { method: "PUT", data: { enabled } }),
  overview: (filters: Partial<TeamFilters> & { scope?: "leads" }) =>
    api.get<TeamOverview>(`/team/overview?${query(filters)}`),
  leads: (filters: TeamFilters) => api.get<TeamPage<TeamCustomer>>(`/team/leads?${query(filters)}`),
  customers: (filters: TeamFilters) =>
    api.get<TeamPage<TeamCustomer>>(`/team/customers?${query(filters)}`),
  messages: (accountId: string, customer: string, page: number, pageSize = 50) =>
    api.get<TeamMessages>(
      `/team/messages?${new URLSearchParams({ accountId, customer, page: String(page), pageSize: String(pageSize) })}`,
    ),
};
export const teamPlatformName = (platform: string) =>
  (({ whatsapp: "WhatsApp", line: "LINE", telegram: "Telegram" }) as Record<string, string>)[
    platform
  ] || platform;
