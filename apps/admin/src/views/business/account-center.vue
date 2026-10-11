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
import {
  type Profile,
  type AccountSummary,
  type AccountBilling,
  rechargeColumns,
  ledgerColumns,
} from "#/api/commerce";
import { useAuthStore } from "#/store";
import FinanceTable from "./components/finance-table.vue";
import CommerceOperations from "./components/commerce-operations.vue";
import "./common.css";
const auth = useAuthStore(),
  tab = ref("billing"),
  loading = ref(false),
  saving = ref(false),
  profile = ref<Profile>(),
  summary = ref<AccountSummary>(),
  billing = ref<AccountBilling>();
const details = reactive({ displayName: "", contact: "", teamName: "" }),
  password = reactive({ currentPassword: "", newPassword: "", confirm: "" });
const topupOpen = ref(false),
  topup = reactive({ amount: "", paymentReference: "", note: "", requestId: "" });
const rechargeTable = ref<InstanceType<typeof FinanceTable>>();
async function refresh() {
  loading.value = true;
  try {
    const [p, s, b] = await Promise.all([
      api.get<Profile>("/account/profile"),
      api.get<AccountSummary>("/account/summary"),
      api.get<AccountBilling>("/account/billing"),
    ]);
    profile.value = p;
    summary.value = s;
    billing.value = b;
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
    ElMessage.success("充值申请已提交，审核到账后计入点数");
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
        <p class="subtitle">翻译免费；实际上线的账号按北京时间自然日扣点，同一账号当天只扣一次。</p>
      </div>
      <ElButton type="primary" :disabled="!summary?.settings.rechargeEnabled" @click="newTopup"
        >申请充值</ElButton
      >
    </div>
    <div class="stats">
      <div class="stat">
        <span>剩余点数</span><strong>{{ billing?.points ?? "—" }}</strong
        ><span>1 点 = 1 元 · 新公司注册赠送 100 点</span>
      </div>
      <div class="stat">
        <span>今日上线账号</span><strong>{{ billing?.todayAccounts ?? "—" }}</strong
        ><span>同一平台账号当天重复上线不重复扣点</span>
      </div>
      <div class="stat">
        <span>累计扣除点数</span><strong>{{ billing?.spentPoints ?? "—" }}</strong
        ><span>每个账号每天 1 点，未上线不扣</span>
      </div>
      <div class="stat">
        <span>翻译字符</span
        ><strong>{{ summary?.translationChars?.toLocaleString() ?? "—" }}</strong
        ><span>免费翻译，不扣余额</span>
      </div>
    </div>
    <ElAlert
      v-if="billing && billing.status !== 'normal'"
      :title="
        billing.status === 'blocked'
          ? '公司累计 3 天缓冲已用完，账号已退登。请联系平台充值后重新登录。'
          : billing.status === 'grace'
            ? `当前正在使用缓冲，公司累计已用 ${billing.graceDaysUsed} 天，剩余 ${billing.graceDaysRemaining} 天。请及时联系平台充值。`
            : '点数不足 1 点，请联系平台充值。实际使用时可启用剩余缓冲期。'
      "
      :type="billing.status === 'blocked' ? 'error' : 'warning'"
      :closable="false"
      style="margin-bottom: 20px"
    />
    <div class="panel">
      <ElTabs v-model="tab">
        <ElTabPane label="账号扣点记录" name="billing">
          <div class="billing-rules">
            <strong>每个账号 1 点 / 天 · 北京时间自然日</strong>
            <p>
              当天在软件内上线过才扣点，关机或退出后未上线的日期不扣；同公司、同平台、同一实际账号当天不重复扣点。
            </p>
            <p>
              公司累计缓冲 {{ billing?.graceDaysUsed ?? 0 }} / 3
              天：只累计点数不足时实际使用的日期，同一天多个账号共用一天缓冲，充值不会重置。用完后逾期未充值，将强制退登全部账号并需重新登录。
            </p>
            <p>缓冲使用单独记账，不扣点；翻译和员工席位免费。</p>
          </div>
          <FinanceTable
            v-if="tab === 'billing'"
            endpoint="/account/billing/days"
            :columns="[
              { key: 'billingDay', label: '计费日期（北京时间）', width: 185 },
              { key: 'accountName', label: '账号名称', width: 165 },
              { key: 'platform', label: '平台', width: 110 },
              { key: 'platformAccount', label: '平台账号', width: 165 },
              { key: 'points', label: '消耗点数', width: 110 },
              {
                key: 'status',
                label: '计费方式',
                formatter: (v: string) => (v === 'paid' ? '点数扣除' : '公司缓冲'),
              },
              { key: 'createdAt', label: '首次上线记录', format: 'date', width: 180 },
            ]"
            search-placeholder="搜索账号名称或平台账号"
            empty-text="暂无扣点记录，账号实际上线后将在这里显示"
          />
        </ElTabPane>
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
        <ElTabPane label="点数流水" name="ledger"
          ><FinanceTable
            v-if="tab === 'ledger'"
            endpoint="/account/ledger"
            :columns="
              ledgerColumns.map((c) => ({
                ...c,
                formatter: ['availableDelta', 'availableAfter', 'heldDelta', 'heldAfter'].includes(
                  c.key,
                )
                  ? (v: string) => String(Number(v))
                  : c.formatter,
                label:
                  c.key === 'availableAfter'
                    ? '剩余点数'
                    : c.key === 'availableDelta'
                      ? '点数变动'
                      : c.label,
              }))
            "
            empty-text="暂无点数变动，注册赠送、充值和账号扣点均会记录"
        /></ElTabPane>
        <ElTabPane label="字符日志" name="usage"
          ><p class="subtitle" style="margin-bottom: 16px">
            记录新版客户端成功翻译的输入、输出字符数，不保存原文和译文。翻译永久免费，不扣点；离线未成功上报的用量不计入。
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
        <ElTabPane v-if="profile?.isOperator" label="运营管理" name="operations"
          ><CommerceOperations v-if="tab === 'operations'" @changed="refresh"
        /></ElTabPane>
      </ElTabs>
    </div>
    <ElDialog v-model="topupOpen" title="申请充值" width="520px" :close-on-click-modal="false"
      ><form class="form-grid" @submit.prevent="createTopup">
        <ElAlert
          title="请先按以下说明完成付款，再提交申请；申请不会直接增加点数。"
          :closable="false"
        />
        <p class="payment-instructions">{{ summary?.settings.paymentInstructions }}</p>
        <label class="field"
          >充值金额（{{ summary?.settings.currency }}）<ElInput
            v-model="topup.amount"
            aria-label="充值金额"
            type="number"
            min="1"
            step="1"
            inputmode="numeric"
            placeholder="例如：100"
            required
          /><small
            >1 元 = 1 点，仅支持整元充值。最低
            {{ Number(summary?.settings.minRecharge || 1) }} 元。</small
          ></label
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
.billing-rules {
  padding: 18px 20px;
  background: var(--el-fill-color-light);
  border-radius: 10px;
  margin: 14px 0 24px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--el-text-color-secondary);
}
.billing-rules strong {
  color: var(--el-text-color-primary);
}
.billing-rules p {
  margin: 6px 0 0;
}

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
