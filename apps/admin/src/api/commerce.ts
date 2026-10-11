import { date } from "./business";
export interface CommerceSettings {
  currency: string;
  paymentInstructions: string;
  payoutChannel: string;
  rechargeEnabled: boolean;
  withdrawalEnabled: boolean;
  registrationEnabled: boolean;
  commissionBps: number;
  minRecharge: string;
  minWithdrawal: string;
}
export interface Profile {
  username: string;
  displayName: string;
  contact: string;
  teamName: string;
  isOperator: boolean;
}
export interface AccountSummary {
  balance: string;
  held: string;
  recharged: string;
  spent: string;
  translationChars: number;
  settings: CommerceSettings;
}
export interface PromotionSummary {
  code: string;
  enabled: boolean;
  available: string;
  held: string;
  earned: string;
  paid: string;
  transferred: string;
  referrals: number;
  settings: CommerceSettings;
}
export type FinanceRow = Record<string, any>;
export interface FinanceColumn {
  key: string;
  label: string;
  width?: number;
  format?: "date" | "status" | "event" | "rate";
  formatter?: (value: any) => string;
}
export const states: Record<string, string> = {
  pending: "待审核",
  credited: "已入账",
  rejected: "已拒绝",
  cancelled: "已取消",
  refunded: "已退款",
  approved: "待打款",
  paid: "已支付",
  reversed: "已冲回",
};
export const events: Record<string, string> = {
  recharge: "充值入账",
  refund: "充值退款",
  commission: "推广返佣",
  commission_reversal: "佣金冲回",
  transfer_in: "佣金转入",
  transfer_out: "转入账户余额",
  withdraw_hold: "提现冻结",
  withdraw_release: "提现解冻",
  withdraw_paid: "提现支付",
};
export function financeCell(row: FinanceRow, col: FinanceColumn) {
  const v = row[col.key];
  if (col.formatter) return col.formatter(v);
  if (col.format === "date") return date(v);
  if (col.format === "status") return states[v] || v;
  if (col.format === "event") return events[v] || v;
  if (col.format === "rate") return `${Number(v) / 100}%`;
  return v ?? "—";
}
export const rechargeColumns: FinanceColumn[] = [
  { key: "id", label: "订单号", width: 190 },
  { key: "amount", label: "金额", width: 100 },
  { key: "currency", label: "币种", width: 75 },
  { key: "status", label: "状态", format: "status", width: 95 },
  { key: "paymentReference", label: "付款说明 / 流水", width: 180 },
  { key: "receiptReference", label: "实收流水", width: 180 },
  { key: "refundReference", label: "退款流水", width: 180 },
  { key: "reviewNote", label: "审核说明", width: 180 },
  { key: "createdAt", label: "申请时间", format: "date", width: 170 },
];
export const withdrawalColumns: FinanceColumn[] = [
  { key: "id", label: "申请号", width: 190 },
  { key: "amount", label: "金额", width: 100 },
  { key: "currency", label: "币种", width: 75 },
  { key: "status", label: "状态", format: "status", width: 95 },
  { key: "channel", label: "渠道", width: 130 },
  { key: "destination", label: "收款信息", width: 150 },
  { key: "payoutReference", label: "打款流水", width: 180 },
  { key: "reviewNote", label: "审核说明", width: 180 },
  { key: "createdAt", label: "申请时间", format: "date", width: 170 },
];
export const ledgerColumns: FinanceColumn[] = [
  { key: "event", label: "业务类型", format: "event", width: 140 },
  { key: "availableDelta", label: "可用变动", width: 110 },
  { key: "heldDelta", label: "冻结变动", width: 110 },
  { key: "availableAfter", label: "可用余额", width: 120 },
  { key: "heldAfter", label: "冻结余额", width: 110 },
  { key: "sourceId", label: "关联单号", width: 200 },
  { key: "note", label: "说明", width: 190 },
  { key: "createdAt", label: "时间", format: "date", width: 170 },
];
