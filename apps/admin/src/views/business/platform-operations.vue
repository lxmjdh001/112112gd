<script setup lang="ts">
import { computed } from "vue";
import CommerceOperations from "./components/commerce-operations.vue";
import FinanceTable from "./components/finance-table.vue";
import { rechargeColumns } from "#/api/commerce";
import "./common.css";
const props = defineProps<{ section: "records" | "recharges" | "withdrawals" | "settings" }>();
const titles = {
  records: "充值记录",
  recharges: "充值审核",
  withdrawals: "提现审核",
  settings: "平台设置",
};
const descriptions = {
  records: "查看所有团队的充值申请、到账和退款记录。",
  recharges: "核实客户付款后确认到账，沿用现有点数与返佣规则。",
  withdrawals: "处理提现申请，记录人工审核与实际打款结果。",
  settings: "统一设置注册、收款说明、充值提现和推广佣金规则。",
};
const title = computed(() => titles[props.section]);
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>{{ title }}</h1>
        <p class="subtitle">{{ descriptions[section] }}</p>
      </div>
    </div>
    <div class="panel">
      <FinanceTable
        v-if="section === 'records'"
        endpoint="/operations/recharges"
        :columns="[{ key: 'teamName', label: '账户 / 团队', width: 160 }, ...rechargeColumns]"
        :statuses="['pending', 'credited', 'rejected', 'cancelled', 'refunded']"
        empty-text="暂无客户充值记录"
      />
      <CommerceOperations v-else :key="section" :section="section" />
    </div>
  </div>
</template>
