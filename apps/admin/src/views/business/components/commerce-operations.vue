<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  ElButton,
  ElInput,
  ElInputNumber,
  ElSelect,
  ElOption,
  ElSwitch,
  ElTabs,
  ElTabPane,
  ElDialog,
  ElAlert,
  ElMessage,
  ElMessageBox,
} from "element-plus";
import { api } from "#/api/business";
import {
  type CommerceSettings,
  type FinanceRow,
  rechargeColumns,
  withdrawalColumns,
} from "#/api/commerce";
import FinanceTable from "./finance-table.vue";
const emit = defineEmits<{ changed: [] }>();
const tab = ref("recharges"),
  busy = ref(false),
  rate = ref(0);
const config = reactive<CommerceSettings>({
  currency: "",
  paymentInstructions: "",
  payoutChannel: "",
  rechargeEnabled: false,
  withdrawalEnabled: false,
  registrationEnabled: false,
  commissionBps: 0,
  minRecharge: "1.00",
  minWithdrawal: "1.00",
});
const table = ref<InstanceType<typeof FinanceTable>>(),
  withdrawTable = ref<InstanceType<typeof FinanceTable>>();
const review = ref<{
  kind: "recharges" | "withdrawals";
  row: FinanceRow;
  action: string;
  title: string;
}>();
const form = reactive({ reference: "", note: "" });
async function load() {
  Object.assign(config, await api.get<CommerceSettings>("/operations/settings"));
  rate.value = config.commissionBps / 100;
}
async function save() {
  busy.value = true;
  try {
    await api.request("/operations/settings", {
      method: "PUT",
      data: { ...config, commissionBps: Math.round(rate.value * 100) },
    });
    ElMessage.success("结算规则已保存");
    emit("changed");
  } finally {
    busy.value = false;
  }
}
function open(kind: "recharges" | "withdrawals", row: FinanceRow, action: string, title: string) {
  form.reference = "";
  form.note = "";
  review.value = { kind, row, action, title };
}
async function submit() {
  if (!review.value) return;
  busy.value = true;
  try {
    const r = review.value;
    await api.post(`/operations/${r.kind}/${r.row.id}/review`, {
      action: r.action,
      note: form.note,
      receiptReference: form.reference,
      refundReference: form.reference,
      payoutReference: form.reference,
    });
    review.value = undefined;
    await Promise.all([table.value?.reload(), withdrawTable.value?.reload()]);
    emit("changed");
    ElMessage.success("审核结果已保存");
  } finally {
    busy.value = false;
  }
}
async function destination(row: FinanceRow) {
  const data = await api.post<{ destination: string }>(
    `/operations/withdrawals/${row.id}/destination`,
    {},
  );
  await ElMessageBox.alert(data.destination, `收款信息 · ${row.teamName}`, {
    confirmButtonText: "关闭",
  }).catch(() => {});
}
onMounted(load);
</script>
<template>
  <ElAlert
    title="平台运营专用。这里记录人工核实的收款、退款和打款结果，不会自动发起转账。"
    :closable="false"
    style="margin-bottom: 18px"
  />
  <ElTabs v-model="tab">
    <ElTabPane label="充值审核" name="recharges"
      ><FinanceTable
        v-if="tab === 'recharges'"
        ref="table"
        endpoint="/operations/recharges"
        :columns="[{ key: 'teamName', label: '账户 / 团队', width: 150 }, ...rechargeColumns]"
        :statuses="['pending', 'credited', 'rejected', 'cancelled', 'refunded']"
        ><template #actions="{ row }"
          ><template v-if="row.status === 'pending'"
            ><ElButton type="primary" link @click="open('recharges', row, 'credit', '确认充值到账')"
              >确认到账</ElButton
            ><ElButton type="danger" link @click="open('recharges', row, 'reject', '拒绝充值申请')"
              >拒绝</ElButton
            ></template
          ><ElButton
            v-if="row.status === 'credited'"
            type="danger"
            link
            @click="open('recharges', row, 'refund', '登记退款并冲正')"
            >退款冲正</ElButton
          ></template
        ></FinanceTable
      ></ElTabPane
    >
    <ElTabPane label="提现审核" name="withdrawals"
      ><FinanceTable
        v-if="tab === 'withdrawals'"
        ref="withdrawTable"
        endpoint="/operations/withdrawals"
        :columns="[{ key: 'teamName', label: '账户 / 团队', width: 150 }, ...withdrawalColumns]"
        :statuses="['pending', 'approved', 'paid', 'rejected', 'cancelled']"
        :action-width="260"
        ><template #actions="{ row }"
          ><ElButton link @click="destination(row)">收款信息</ElButton
          ><ElButton
            v-if="row.status === 'pending'"
            type="primary"
            link
            @click="open('withdrawals', row, 'approve', '通过提现审核')"
            >通过审核</ElButton
          ><ElButton
            v-if="row.status === 'approved'"
            type="primary"
            link
            @click="open('withdrawals', row, 'pay', '确认已打款')"
            >登记打款</ElButton
          ><ElButton
            v-if="['pending', 'approved'].includes(row.status)"
            type="danger"
            link
            @click="open('withdrawals', row, 'reject', '拒绝提现申请')"
            >拒绝</ElButton
          ></template
        ></FinanceTable
      ></ElTabPane
    >
    <ElTabPane label="结算规则" name="settings"
      ><form class="settings-form" @submit.prevent="save">
        <label class="field"
          >结算币种<ElSelect v-model="config.currency" aria-label="结算币种" placeholder="请选择"
            ><ElOption label="人民币 CNY" value="CNY" /><ElOption
              label="美元 USD"
              value="USD" /><ElOption label="USDT" value="USDT" /></ElSelect
          ><small>统一保留两位小数。产生账务记录后不可更换币种。</small></label
        >
        <label class="field"
          >推广佣金比例（%）<ElInputNumber
            v-model="rate"
            aria-label="推广佣金比例"
            :min="0"
            :max="100"
            :precision="2"
          /><small
            >对已确认到账的充值金额返佣，比例按入账时的规则记录；转余额不重复返佣。0
            表示暂不返佣。</small
          ></label
        >
        <label class="field full"
          >充值收款说明<ElInput
            v-model="config.paymentInstructions"
            aria-label="充值收款说明"
            type="textarea"
            :rows="4"
            maxlength="2000"
            placeholder="填写已确认的收款渠道、收款信息、币种及提交要求"
        /></label>
        <label class="field"
          >最低充值金额<ElInput
            v-model="config.minRecharge"
            aria-label="最低充值金额"
            inputmode="decimal"
            required /></label
        ><label class="field"
          >充值开放状态<ElSwitch
            v-model="config.rechargeEnabled"
            aria-label="开放充值"
            active-text="开放"
            inactive-text="关闭"
        /></label>
        <label class="field"
          >提现渠道名称<ElInput
            v-model="config.payoutChannel"
            aria-label="提现渠道名称"
            maxlength="80"
            placeholder="例如：银行转账，或已确认支持的网络" /></label
        ><label class="field"
          >最低提现金额<ElInput
            v-model="config.minWithdrawal"
            aria-label="最低提现金额"
            inputmode="decimal"
            required
        /></label>
        <label class="field"
          >提现开放状态<ElSwitch
            v-model="config.withdrawalEnabled"
            aria-label="开放提现"
            active-text="开放"
            inactive-text="关闭" /></label
        ><label class="field"
          >网站注册<ElSwitch
            v-model="config.registrationEnabled"
            aria-label="开放注册"
            active-text="开放"
            inactive-text="关闭"
          /><small>开启后可使用推广链接注册独立团队；已注册账户不可补绑推广关系。</small></label
        >
        <ElButton class="full" type="primary" native-type="submit" :loading="busy"
          >保存结算规则</ElButton
        >
      </form></ElTabPane
    >
  </ElTabs>
  <ElDialog
    :model-value="!!review"
    :title="review?.title"
    width="520px"
    :close-on-click-modal="false"
    @close="review = undefined"
    ><form v-if="review" class="form-grid" @submit.prevent="submit">
      <p>{{ review.row.teamName }} · {{ review.row.amount }} {{ review.row.currency }}</p>
      <p class="code">{{ review.row.id }}</p>
      <ElAlert
        v-if="review.action === 'credit'"
        title="请核对实际到账金额与订单一致。实收流水号不可重复使用。"
        :closable="false"
      /><ElAlert
        v-if="review.action === 'refund'"
        title="仅支持整单退款。需已完成线下退款；账户余额及对应可用佣金必须足够冲回。"
        :closable="false"
      /><ElAlert
        v-if="review.action === 'pay'"
        title="请完成线下打款并核对收款信息后，再填写实际付款流水。"
        :closable="false"
      /><label v-if="['credit', 'refund', 'pay'].includes(review.action)" class="field"
        >{{
          review.action === "credit"
            ? "实收流水号"
            : review.action === "refund"
              ? "退款流水号"
              : "打款流水号"
        }}<ElInput
          v-model="form.reference"
          aria-label="审核流水号"
          required
          maxlength="150" /></label
      ><label class="field"
        >审核说明<ElInput
          v-model="form.note"
          aria-label="审核说明"
          type="textarea"
          :required="['reject', 'refund'].includes(review.action)"
          maxlength="300" /></label
      ><ElButton type="primary" native-type="submit" :loading="busy">确认提交审核结果</ElButton>
    </form></ElDialog
  >
</template>
<style scoped>
.settings-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  max-width: 900px;
  padding: 18px 0;
}
.full {
  grid-column: 1/-1;
}
@media (max-width: 800px) {
  .settings-form {
    grid-template-columns: 1fr;
  }
}
</style>
