<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  ElButton,
  ElInput,
  ElTabs,
  ElTabPane,
  ElDialog,
  ElAlert,
  ElMessage,
  ElMessageBox,
} from "element-plus";
import { api } from "#/api/business";
import { type Profile, type AccountSummary, rechargeColumns, ledgerColumns } from "#/api/commerce";
import { useAuthStore } from "#/store";
import FinanceTable from "./components/finance-table.vue";
import CommerceOperations from "./components/commerce-operations.vue";
import "./common.css";
const auth = useAuthStore(),
  tab = ref("profile"),
  loading = ref(false),
  saving = ref(false),
  profile = ref<Profile>(),
  summary = ref<AccountSummary>();
const details = reactive({ displayName: "", contact: "", teamName: "" }),
  password = reactive({ currentPassword: "", newPassword: "", confirm: "" });
const topupOpen = ref(false),
  topup = reactive({ amount: "", paymentReference: "", note: "", requestId: "" });
const rechargeTable = ref<InstanceType<typeof FinanceTable>>();
async function refresh() {
  loading.value = true;
  try {
    const [p, s] = await Promise.all([
      api.get<Profile>("/account/profile"),
      api.get<AccountSummary>("/account/summary"),
    ]);
    profile.value = p;
    summary.value = s;
    Object.assign(details, {
      displayName: p.displayName,
      contact: p.contact,
      teamName: p.teamName,
    });
  } finally {
    loading.value = false;
  }
}
async function saveProfile() {
  saving.value = true;
  try {
    await api.request("/account/profile", { method: "PATCH", data: details });
    await auth.fetchUserInfo();
    ElMessage.success("个人资料已保存");
  } finally {
    saving.value = false;
  }
}
async function savePassword() {
  if (password.newPassword !== password.confirm) {
    ElMessage.warning("两次新密码不一致");
    return;
  }
  saving.value = true;
  try {
    await api.post("/account/password", {
      currentPassword: password.currentPassword,
      newPassword: password.newPassword,
    });
    Object.assign(password, { currentPassword: "", newPassword: "", confirm: "" });
    ElMessage.success("密码已更新，其他网页会话已退出");
  } finally {
    saving.value = false;
  }
}
function newTopup() {
  Object.assign(topup, {
    amount: "",
    paymentReference: "",
    note: "",
    requestId: crypto.randomUUID(),
  });
  topupOpen.value = true;
}
async function createTopup() {
  saving.value = true;
  try {
    await api.post("/account/recharges", topup);
    topupOpen.value = false;
    tab.value = "recharges";
    await refresh();
    await rechargeTable.value?.reload();
    ElMessage.success("充值申请已提交，审核到账后计入余额");
  } finally {
    saving.value = false;
  }
}
async function cancel(id: string) {
  const confirmed = await ElMessageBox.confirm("取消这笔待审核充值申请？", "取消充值", {
    confirmButtonText: "确认取消",
    cancelButtonText: "返回",
  })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await api.post(`/account/recharges/${id}/cancel`, {});
  await rechargeTable.value?.reload();
  await refresh();
}
onMounted(refresh);
</script>
<template>
  <div class="business" v-loading="loading">
    <div class="page-head">
      <div>
        <h1>账户中心</h1>
        <p class="subtitle">管理个人资料、账户余额与每一笔资金记录。</p>
      </div>
      <ElButton type="primary" :disabled="!summary?.settings.rechargeEnabled" @click="newTopup"
        >申请充值</ElButton
      >
    </div>
    <div class="stats">
      <div class="stat">
        <span>账户余额 {{ summary?.settings.currency }}</span
        ><strong>{{ summary?.balance ?? "—" }}</strong
        ><span>已入账，可用于后续服务购买</span>
      </div>
      <div class="stat">
        <span>累计有效充值</span><strong>{{ summary?.recharged ?? "—" }}</strong
        ><span>不含待审核与已退款订单</span>
      </div>
      <div class="stat">
        <span>累计消费</span><strong>{{ summary?.spent ?? "—" }}</strong
        ><span>按实际购买记录统计</span>
      </div>
      <div class="stat">
        <span>翻译字符</span
        ><strong>{{ summary?.translationChars?.toLocaleString() ?? "—" }}</strong
        ><span>免费翻译，不扣余额</span>
      </div>
    </div>
    <div class="panel">
      <ElTabs v-model="tab">
        <ElTabPane label="个人资料" name="profile"
          ><div class="profile-grid">
            <form class="form-grid" @submit.prevent="saveProfile">
              <h2 class="section-title">个人资料</h2>
              <label class="field"
                >登录账号<ElInput :model-value="profile?.username" disabled /></label
              ><label class="field"
                >显示名称<ElInput
                  v-model="details.displayName"
                  aria-label="显示名称"
                  maxlength="80" /></label
              ><label class="field"
                >团队名称<ElInput
                  v-model="details.teamName"
                  aria-label="团队名称"
                  maxlength="100"
                  required /></label
              ><label class="field"
                >联系方式<ElInput
                  v-model="details.contact"
                  aria-label="联系方式"
                  maxlength="150"
                  placeholder="邮箱、手机或其他联系方式" /></label
              ><ElButton type="primary" native-type="submit" :loading="saving">保存资料</ElButton>
            </form>
            <form class="form-grid" @submit.prevent="savePassword">
              <h2 class="section-title">修改密码</h2>
              <label class="field"
                >当前密码<ElInput
                  v-model="password.currentPassword"
                  aria-label="当前密码"
                  type="password"
                  show-password
                  autocomplete="current-password"
                  required /></label
              ><label class="field"
                >新密码<ElInput
                  v-model="password.newPassword"
                  aria-label="新密码"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  minlength="12"
                  maxlength="72"
                  required /></label
              ><label class="field"
                >确认新密码<ElInput
                  v-model="password.confirm"
                  aria-label="确认新密码"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  required
              /></label>
              <p class="subtitle">
                密码至少 12 位。修改后其他网页会话退出，当前网页及客户端登录码不受影响。
              </p>
              <ElButton native-type="submit" :loading="saving">更新密码</ElButton>
            </form>
          </div></ElTabPane
        >
        <ElTabPane label="充值记录" name="recharges"
          ><ElAlert
            v-if="!summary?.settings.rechargeEnabled"
            title="充值暂未开放，现有记录仍可查询。"
            :closable="false"
            style="margin-bottom: 18px"
          /><FinanceTable
            v-if="tab === 'recharges'"
            ref="rechargeTable"
            endpoint="/account/recharges"
            :columns="rechargeColumns"
            :statuses="['pending', 'credited', 'rejected', 'cancelled', 'refunded']"
            empty-text="暂无充值记录"
            ><template #actions="{ row }"
              ><ElButton v-if="row.status === 'pending'" type="danger" link @click="cancel(row.id)"
                >取消申请</ElButton
              ></template
            ></FinanceTable
          ></ElTabPane
        >
        <ElTabPane label="钱包日志" name="ledger"
          ><FinanceTable
            v-if="tab === 'ledger'"
            endpoint="/account/ledger"
            :columns="ledgerColumns"
            empty-text="暂无资金变动，充值或佣金转入后会显示流水"
        /></ElTabPane>
        <ElTabPane label="字符日志" name="usage"
          ><p class="subtitle" style="margin-bottom: 16px">
            记录新版客户端成功翻译的输入、输出字符数，不保存原文和译文。当前免费，不扣费；离线未成功上报的用量不计入。
          </p>
          <FinanceTable
            v-if="tab === 'usage'"
            endpoint="/account/usage"
            :columns="[
              { key: 'accountName', label: '平台账号', width: 180 },
              { key: 'provider', label: '翻译服务', width: 130 },
              { key: 'inputChars', label: '输入字符' },
              { key: 'outputChars', label: '输出字符' },
              { key: 'targetLanguage', label: '目标语言' },
              { key: 'createdAt', label: '记录时间', format: 'date', width: 180 },
            ]"
            empty-text="暂无已上报的翻译用量"
        /></ElTabPane>
        <ElTabPane label="购买记录" name="purchases"
          ><ElAlert
            title="套餐与付费服务尚未上架，当前不会产生购买扣费。"
            :closable="false"
            style="margin-bottom: 18px" /><FinanceTable
            v-if="tab === 'purchases'"
            endpoint="/account/purchases"
            :columns="[
              { key: 'id', label: '订单号', width: 200 },
              { key: 'productName', label: '服务名称', width: 200 },
              { key: 'amount', label: '金额' },
              { key: 'currency', label: '币种' },
              { key: 'status', label: '状态', format: 'status' },
              { key: 'createdAt', label: '时间', format: 'date', width: 180 },
            ]"
            empty-text="暂无购买记录"
        /></ElTabPane>
        <ElTabPane v-if="profile?.isOperator" label="运营管理" name="operations"
          ><CommerceOperations v-if="tab === 'operations'" @changed="refresh"
        /></ElTabPane>
      </ElTabs>
    </div>
    <ElDialog v-model="topupOpen" title="申请充值" width="520px" :close-on-click-modal="false"
      ><form class="form-grid" @submit.prevent="createTopup">
        <ElAlert
          title="请先按以下说明完成付款，再提交申请；申请不会直接增加余额。"
          :closable="false"
        />
        <p class="payment-instructions">{{ summary?.settings.paymentInstructions }}</p>
        <label class="field"
          >充值金额（{{ summary?.settings.currency }}）<ElInput
            v-model="topup.amount"
            aria-label="充值金额"
            inputmode="decimal"
            placeholder="0.00"
            required
          /><small>最低 {{ summary?.settings.minRecharge }}，最多两位小数。</small></label
        ><label class="field"
          >付款流水号 / 付款说明<ElInput
            v-model="topup.paymentReference"
            aria-label="付款流水号"
            maxlength="150"
            required /></label
        ><label class="field"
          >备注<ElInput v-model="topup.note" type="textarea" maxlength="300" /></label
        ><ElButton native-type="submit" type="primary" :loading="saving">提交充值申请</ElButton>
      </form></ElDialog
    >
  </div>
</template>
<style scoped>
.profile-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 48px;
  max-width: 1000px;
  padding: 20px 0;
}
.profile-grid .form-grid {
  align-content: start;
}
.payment-instructions {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 14px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.7;
}
@media (max-width: 900px) {
  .profile-grid {
    grid-template-columns: 1fr;
    gap: 30px;
  }
}
</style>
