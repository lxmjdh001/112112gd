<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  ElButton,
  ElInput,
  ElTag,
  ElTabs,
  ElTabPane,
  ElDialog,
  ElAlert,
  ElMessage,
  ElMessageBox,
} from "element-plus";
import { api } from "#/api/business";
import { type PromotionSummary, withdrawalColumns, ledgerColumns } from "#/api/commerce";
import FinanceTable from "./components/finance-table.vue";
import "./common.css";
const info = ref<PromotionSummary>(),
  tab = ref("referrals"),
  loading = ref(false),
  saving = ref(false),
  dialog = ref<"transfer" | "withdraw" | "">("");
const form = reactive({ amount: "", destination: "", requestId: "" }),
  withdrawTable = ref<InstanceType<typeof FinanceTable>>();
const link = computed(() =>
  info.value
    ? `${location.origin}${location.pathname}#/auth/register?ref=${encodeURIComponent(info.value.code)}`
    : "",
);
async function load() {
  loading.value = true;
  try {
    info.value = await api.get<PromotionSummary>("/promotion");
  } finally {
    loading.value = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(link.value);
    ElMessage.success("推广链接已复制");
  } catch {
    ElMessage.warning("未能自动复制，请从链接框手动复制");
  }
}
async function toggle() {
  if (!info.value) return;
  saving.value = true;
  try {
    await api.request("/promotion", { method: "PATCH", data: { enabled: !info.value.enabled } });
    await load();
    ElMessage.success("推广链接状态已更新");
  } finally {
    saving.value = false;
  }
}
function open(kind: "transfer" | "withdraw") {
  Object.assign(form, { amount: "", destination: "", requestId: crypto.randomUUID() });
  dialog.value = kind;
}
async function submit() {
  saving.value = true;
  try {
    await api.post(
      dialog.value === "transfer" ? "/promotion/transfers" : "/promotion/withdrawals",
      form,
    );
    const was = dialog.value;
    dialog.value = "";
    await load();
    await withdrawTable.value?.reload();
    ElMessage.success(was === "transfer" ? "佣金已转入账户余额" : "提现申请已提交，对应佣金已冻结");
  } finally {
    saving.value = false;
  }
}
async function cancel(id: string) {
  const confirmed = await ElMessageBox.confirm("取消提现申请并释放冻结佣金？", "取消提现", {
    confirmButtonText: "确认取消",
    cancelButtonText: "返回",
  })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await api.post(`/promotion/withdrawals/${id}/cancel`, {});
  await load();
  await withdrawTable.value?.reload();
}
onMounted(load);
</script>
<template>
  <div class="business" v-loading="loading">
    <div class="page-head">
      <div>
        <h1>推广中心</h1>
        <p class="subtitle">邀请客户注册，查看推广归属、充值返佣与结算记录。</p>
      </div>
      <ElButton @click="load">刷新概况</ElButton>
    </div>
    <div class="stats">
      <div class="stat">
        <span>推广客户</span><strong>{{ info?.referrals ?? "—" }}</strong
        ><span>通过链接完成注册的团队</span>
      </div>
      <div class="stat">
        <span>可用佣金 {{ info?.settings.currency }}</span
        ><strong>{{ info?.available ?? "—" }}</strong
        ><span>可转余额或申请提现</span>
      </div>
      <div class="stat">
        <span>冻结佣金</span><strong>{{ info?.held ?? "—" }}</strong
        ><span>等待审核或打款</span>
      </div>
      <div class="stat">
        <span>累计有效佣金</span><strong>{{ info?.earned ?? "—" }}</strong
        ><span>已提现 {{ info?.paid ?? "0.00" }} · 已转余额 {{ info?.transferred ?? "0.00" }}</span>
      </div>
    </div>
    <div class="panel">
      <div class="toolbar">
        <h2 class="section-title" style="margin: 0">专属推广链接</h2>
        <ElTag :type="info?.enabled ? 'success' : 'info'">{{
          info?.enabled ? "已启用" : "已停用"
        }}</ElTag>
        <div class="grow" />
        <ElButton :loading="saving" @click="toggle">{{
          info?.enabled ? "停用链接" : "启用链接"
        }}</ElButton>
      </div>
      <div class="toolbar promotion-link">
        <ElInput :model-value="link" aria-label="推广链接" readonly /><ElButton
          type="primary"
          @click="copy"
          >复制链接</ElButton
        >
      </div>
      <p class="subtitle">
        当前佣金比例
        {{
          (info?.settings.commissionBps ?? 0) / 100
        }}%。受邀客户充值审核到账后计入佣金；退款会冲回对应佣金。仅通过此链接完成新账户注册时绑定，已有账户不可补绑。
      </p>
      <ElAlert
        v-if="info && !info.settings.registrationEnabled"
        title="网站注册暂未开放，推广链接可保存，开放后再邀请客户注册。"
        :closable="false"
        style="margin-top: 14px"
      />
      <div class="toolbar" style="margin: 18px 0 0">
        <ElButton
          type="primary"
          :disabled="!info || info.available === '0.00'"
          @click="open('transfer')"
          >佣金转余额</ElButton
        ><ElButton
          :disabled="!info?.settings.withdrawalEnabled || info.available === '0.00'"
          @click="open('withdraw')"
          >申请提现</ElButton
        ><span class="subtitle">{{
          info?.settings.withdrawalEnabled
            ? `最低提现 ${info.settings.minWithdrawal} ${info.settings.currency} · ${info.settings.payoutChannel}`
            : "提现暂未开放"
        }}</span>
      </div>
    </div>
    <div class="panel">
      <ElTabs v-model="tab"
        ><ElTabPane label="推广客户" name="referrals"
          ><FinanceTable
            v-if="tab === 'referrals'"
            endpoint="/promotion/referrals"
            :columns="[
              { key: 'teamName', label: '客户团队', width: 230 },
              { key: 'recharged', label: '有效充值' },
              { key: 'commission', label: '产生佣金' },
              { key: 'createdAt', label: '注册时间', format: 'date', width: 200 },
            ]"
            empty-text="暂无推广客户，分享链接后将在这里显示注册归属" /></ElTabPane
        ><ElTabPane label="佣金明细" name="commissions"
          ><FinanceTable
            v-if="tab === 'commissions'"
            endpoint="/promotion/commissions"
            :columns="[
              { key: 'teamName', label: '客户团队', width: 180 },
              { key: 'orderId', label: '来源充值单', width: 210 },
              { key: 'amount', label: '佣金金额' },
              { key: 'rateBps', label: '入账比例', format: 'rate' },
              { key: 'status', label: '状态', format: 'status' },
              { key: 'createdAt', label: '入账时间', format: 'date', width: 180 },
            ]"
            :statuses="['credited', 'reversed']" /></ElTabPane
        ><ElTabPane label="佣金流水" name="ledger"
          ><FinanceTable
            v-if="tab === 'ledger'"
            endpoint="/account/ledger?kind=commission"
            :columns="ledgerColumns" /></ElTabPane
        ><ElTabPane label="提现记录" name="withdrawals"
          ><FinanceTable
            v-if="tab === 'withdrawals'"
            ref="withdrawTable"
            endpoint="/promotion/withdrawals"
            :columns="withdrawalColumns"
            :statuses="['pending', 'approved', 'paid', 'rejected', 'cancelled']"
            ><template #actions="{ row }"
              ><ElButton v-if="row.status === 'pending'" type="danger" link @click="cancel(row.id)"
                >取消申请</ElButton
              ></template
            ></FinanceTable
          ></ElTabPane
        ></ElTabs
      >
    </div>
    <ElDialog
      :model-value="!!dialog"
      :title="dialog === 'transfer' ? '佣金转余额' : '申请提现'"
      width="490px"
      :close-on-click-modal="false"
      @close="dialog = ''"
      ><form class="form-grid" @submit.prevent="submit">
        <ElAlert
          :title="
            dialog === 'transfer'
              ? '仅支持整元转入，1 元兑换 1 点，此操作不产生新的推广佣金。'
              : '提交后冻结相应佣金，审核通过后由运营人工打款。'
          "
          :closable="false"
        />
        <p>可用佣金 {{ info?.available }} {{ info?.settings.currency }}</p>
        <label class="field"
          >金额<ElInput
            v-model="form.amount"
            aria-label="佣金操作金额"
            :inputmode="dialog === 'transfer' ? 'numeric' : 'decimal'"
            :placeholder="dialog === 'transfer' ? '请输入整元金额' : '0.00'"
            required /></label
        ><label v-if="dialog === 'withdraw'" class="field"
          >收款信息 · {{ info?.settings.payoutChannel
          }}<ElInput
            v-model="form.destination"
            aria-label="提现收款信息"
            type="textarea"
            :rows="3"
            maxlength="300"
            placeholder="填写完整收款账号或地址、收款人及所需说明"
            required
          /><small
            >请核对渠道、币种及收款信息。列表脱敏显示，运营审核时可查看完整内容。</small
          ></label
        ><ElButton type="primary" native-type="submit" :loading="saving">{{
          dialog === "transfer" ? "确认转入余额" : "提交提现申请"
        }}</ElButton>
      </form></ElDialog
    >
  </div>
</template>

<style scoped>
.promotion-link .el-input {
  flex: 1;
  width: auto;
  min-width: 240px;
}
</style>
