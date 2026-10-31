<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  ElButton,
  ElCheckbox,
  ElDatePicker,
  ElDialog,
  ElEmpty,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTimeSelect,
} from "element-plus";
import { api } from "#/api/business";
import { orderAPI, orderDate, orderLink, platformLabel } from "#/api/work-orders";
import type { OrderAccount, OrderStats, WorkOrder } from "#/api/work-orders";
import StatsBoard from "#/components/work-orders/StatsBoard.vue";
import "./common.css";
const orders = ref<WorkOrder[]>([]),
  accounts = ref<OrderAccount[]>([]),
  loading = ref(false),
  saving = ref(false),
  editor = ref(false),
  detail = ref(false),
  stats = ref<OrderStats>(),
  activeId = ref("");
const form = ref({
  id: "",
  name: "",
  accountIds: [] as string[],
  startAt: "",
  endAt: "",
  resetTime: "00:00",
  target: 0,
  dedupBaseline: false,
  enabled: true,
  expiresAt: "",
  password: "",
});
const group = ref("*"),
  platform = ref(""),
  search = ref(""),
  replacePassword = ref(false);
const groups = computed(() =>
  Array.from(
    new Map(
      accounts.value.flatMap((a) => a.codes.map((c) => [c.groupId, c.groupName] as const)),
    ).entries(),
  ),
);
const filtered = computed(() =>
  accounts.value.filter(
    (a) =>
      (group.value === "*" ||
        (group.value === ""
          ? !a.codes.length || a.codes.some((c) => !c.groupId)
          : a.codes.some((c) => c.groupId === group.value))) &&
      (!platform.value ||
        (a.connectionType === "cloud" ? "cloud" : a.platform) === platform.value) &&
      (!search.value ||
        `${a.label} ${a.codes.map((c) => c.label).join(" ")}`
          .toLowerCase()
          .includes(search.value.toLowerCase())),
  ),
);
const allSelected = computed(
  () =>
    filtered.value.length > 0 && filtered.value.every((a) => form.value.accountIds.includes(a.id)),
);
function selectVisible(checked: boolean | string | number) {
  const selected = new Set(form.value.accountIds);
  for (const a of filtered.value) checked ? selected.add(a.id) : selected.delete(a.id);
  form.value.accountIds = [...selected];
}
async function load() {
  loading.value = true;
  try {
    [orders.value, accounts.value] = await Promise.all([orderAPI.list(), orderAPI.options()]);
  } finally {
    loading.value = false;
  }
}
function edit(w?: WorkOrder) {
  const bj = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  form.value = w
    ? {
        id: w.id,
        name: w.name,
        accountIds: [...w.accountIds],
        startAt: w.startAt,
        endAt: w.endAt || "",
        resetTime: `${String(Math.floor(w.resetMinutes / 60)).padStart(2, "0")}:${String(w.resetMinutes % 60).padStart(2, "0")}`,
        target: w.target,
        dedupBaseline: w.dedupBaseline,
        enabled: w.enabled,
        expiresAt: w.expiresAt || "",
        password: "",
      }
    : {
        id: "",
        name: "",
        accountIds: [],
        startAt: `${bj}T00:00:00+08:00`,
        endAt: "",
        resetTime: "00:00",
        target: 0,
        dedupBaseline: false,
        enabled: true,
        expiresAt: "",
        password: "",
      };
  replacePassword.value = false;
  group.value = "*";
  platform.value = "";
  search.value = "";
  editor.value = true;
}
async function save() {
  if (!form.value.name.trim() || !form.value.accountIds.length || !form.value.startAt) {
    ElMessage.warning("请填写名称、统计开始时间，并选择账号");
    return;
  }
  const [h, m] = form.value.resetTime.split(":").map(Number);
  const f = form.value;
  const payload = {
    ...f,
    startAt: new Date(f.startAt).toISOString(),
    endAt: f.endAt ? new Date(f.endAt).toISOString() : null,
    expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null,
    resetMinutes: h! * 60 + m!,
    password: !f.id || replacePassword.value ? f.password : undefined,
  };
  saving.value = true;
  try {
    if (f.id) await api.put(`/work-orders/${f.id}`, payload);
    else await api.post("/work-orders", payload);
    editor.value = false;
    await load();
    ElMessage.success("工单已保存，可复制统计链接");
  } finally {
    saving.value = false;
  }
}
async function copy(w: WorkOrder) {
  try {
    await navigator.clipboard.writeText(orderLink(w.token));
    ElMessage.success("统计链接已复制");
  } catch {
    await ElMessageBox.alert(orderLink(w.token), "统计链接");
  }
}
async function preview(w: WorkOrder) {
  activeId.value = w.id;
  stats.value = undefined;
  detail.value = true;
  await refresh();
}
async function refresh() {
  const id = activeId.value;
  const result = await orderAPI.stats(id);
  if (activeId.value === id) stats.value = result;
}
async function toggle(w: WorkOrder) {
  await api.put(`/work-orders/${w.id}`, { ...w, enabled: !w.enabled });
  await load();
}
async function rotate(w: WorkOrder) {
  try {
    await ElMessageBox.confirm("更换后旧链接立即失效，需重新发送新链接。", "更换统计链接", {
      type: "warning",
    });
  } catch {
    return;
  }
  await api.post(`/work-orders/${w.id}/rotate`, {});
  await load();
  ElMessage.success("已生成新链接");
}
async function remove(w: WorkOrder) {
  try {
    await ElMessageBox.confirm("删除工单后分享链接失效，账号和原始进线数据仍保留。", "删除工单", {
      type: "warning",
    });
  } catch {
    return;
  }
  await api.delete(`/work-orders/${w.id}`);
  await load();
}
onMounted(() => void load());
</script>
<template>
  <div class="business work-orders">
    <div class="order-heading">
      <div>
        <h1>工单管理</h1>
        <p class="subtitle">按登录码分组选择平台账号，制作可分享的进线统计链接。</p>
      </div>
      <ElButton type="primary" @click="edit()">＋ 创建工单</ElButton>
    </div>
    <div class="panel">
      <ElTable v-loading="loading" :data="orders" empty-text="还没有工单，点击右上角创建">
        <ElTableColumn label="工单" min-width="190"
          ><template #default="{ row }"
            ><b>{{ row.name }}</b>
            <div class="secondary">
              {{ row.accountIds.length }} 个账号 · {{ orderDate(row.startAt) }} 起
            </div></template
          ></ElTableColumn
        >
        <ElTableColumn label="分享状态" min-width="150"
          ><template #default="{ row }"
            ><ElTag
              :type="
                row.enabled && (!row.expiresAt || Date.parse(row.expiresAt) > Date.now())
                  ? 'success'
                  : 'info'
              "
              >{{
                !row.enabled
                  ? "已停用"
                  : row.expiresAt && Date.parse(row.expiresAt) <= Date.now()
                    ? "已到期"
                    : "分享中"
              }}</ElTag
            ><span v-if="row.hasPassword" class="secondary"> 密码保护</span></template
          ></ElTableColumn
        >
        <ElTableColumn label="操作" min-width="410"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="preview(row)">查看统计</ElButton
            ><ElButton link type="primary" @click="copy(row)">复制链接</ElButton
            ><ElButton link @click="edit(row)">编辑</ElButton
            ><ElButton link @click="toggle(row)">{{ row.enabled ? "停用" : "启用" }}</ElButton
            ><ElButton link @click="rotate(row)">更换链接</ElButton
            ><ElButton link type="danger" @click="remove(row)">删除</ElButton></template
          ></ElTableColumn
        >
      </ElTable>
    </div>
    <ElDialog
      v-model="editor"
      :title="form.id ? '编辑工单' : '创建工单统计链接'"
      width="900px"
      align-center
      class="work-order-dialog"
      :close-on-click-modal="false"
    >
      <div class="edit-grid">
        <section class="settings">
          <label
            >工单名称
            <ElInput v-model="form.name" placeholder="例如：十月 WhatsApp 推广" maxlength="80"
          /></label>
          <label
            >统计开始时间
            <ElDatePicker
              v-model="form.startAt"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm:ssZ"
              :clearable="false"
          /></label>
          <label
            >统计结束时间
            <ElDatePicker
              v-model="form.endAt"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm:ssZ"
              placeholder="留空持续统计"
          /></label>
          <label
            >每日分界（北京时间）
            <ElTimeSelect
              v-model="form.resetTime"
              start="00:00"
              end="23:59"
              step="00:01"
              :clearable="false"
          /></label>
          <label
            >目标人数（0 表示不设置）<ElInputNumber
              v-model="form.target"
              :min="0"
              :max="100000000"
              :precision="0"
          /></label>
          <ElCheckbox v-model="form.dedupBaseline">同时使用公司底库标记重复</ElCheckbox>
          <label
            >链接有效期
            <ElDatePicker
              v-model="form.expiresAt"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm:ssZ"
              placeholder="留空长期有效"
          /></label>
          <ElCheckbox v-if="form.id" v-model="replacePassword"
            >修改访问密码（留空取消密码）</ElCheckbox
          >
          <label v-if="!form.id || replacePassword"
            >访问密码（选填）<ElInput
              v-model="form.password"
              type="password"
              show-password
              autocomplete="new-password"
              placeholder="留空无需密码"
              maxlength="72"
          /></label>
          <div class="share-switch">允许通过链接查看 <ElSwitch v-model="form.enabled" /></div>
        </section>
        <section class="account-picker">
          <h3>
            参与统计的账号 <span>已选 {{ form.accountIds.length }}</span>
          </h3>
          <div class="filters">
            <ElSelect :empty-values="[]" v-model="group" placeholder="登录码分组"
              ><ElOption label="全部分组" value="*" /><ElOption label="未分组" value="" /><ElOption
                v-for="[id, name] in groups.filter((g) => g[0])"
                :key="id"
                :label="name"
                :value="id" /></ElSelect
            ><ElSelect :empty-values="[]" v-model="platform"
              ><ElOption label="全部平台" value="" /><ElOption
                label="WhatsApp"
                value="whatsapp" /><ElOption label="WhatsApp API" value="cloud" /><ElOption
                label="LINE"
                value="line" /><ElOption label="Telegram" value="telegram"
            /></ElSelect>
          </div>
          <ElInput v-model="search" placeholder="搜索账号 / 登录码名称" clearable />
          <div class="selection-bar">
            <ElCheckbox :model-value="allSelected" @change="selectVisible"
              >全选当前结果（{{ filtered.length }}）</ElCheckbox
            ><ElButton link @click="form.accountIds = []">清空选择</ElButton>
          </div>
          <div class="account-choices">
            <label
              v-for="a in filtered"
              :key="a.id"
              class="account-choice"
              :class="{ selected: form.accountIds.includes(a.id) }"
              ><ElCheckbox
                :model-value="form.accountIds.includes(a.id)"
                @change="
                  (value) => {
                    form.accountIds = value
                      ? [...form.accountIds, a.id]
                      : form.accountIds.filter((id) => id !== a.id);
                  }
                "
              />
              <div>
                <b>{{ a.label }}</b
                ><small
                  >{{ platformLabel(a) }} ·
                  {{ a.codes.map((c) => c.label).join("、") || "尚未分配登录码" }}</small
                ><small>{{
                  [...new Set(a.codes.map((c) => c.groupName))].join("、") || "未分组"
                }}</small>
              </div></label
            ><ElEmpty v-if="!filtered.length" description="当前条件下没有账号" :image-size="55" />
          </div>
          <p class="secondary">
            分组用于批量选择当前账号；之后新增的账号需编辑工单加入。已移除的历史账号会保留统计。
          </p>
        </section>
      </div>
      <template #footer
        ><ElButton @click="editor = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">保存工单</ElButton></template
      >
    </ElDialog>
    <ElDialog v-model="detail" :title="stats?.name || '工单统计'" width="1100px" align-center
      ><div v-if="stats">
        <ElButton size="small" @click="refresh">刷新统计</ElButton><StatsBoard :stats="stats" />
      </div>
      <ElEmpty v-else description="正在加载统计…"
    /></ElDialog>
  </div>
</template>
<style scoped>
.order-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 18px;
}
.order-heading h1 {
  margin-bottom: 8px;
  font-size: 22px;
  font-weight: 650;
}
.secondary {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.8;
  margin-top: 5px;
}
.edit-grid {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 28px;
  max-height: 65vh;
  overflow: auto;
}
.settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
  border-right: 1px solid var(--el-border-color-lighter);
  padding-right: 22px;
}
.settings > label:not(.el-checkbox) {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.settings :deep(.el-date-editor),
.settings :deep(.el-input-number) {
  width: 100%;
}
.share-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
}
.account-picker h3 {
  display: flex;
  justify-content: space-between;
  font-weight: 600;
  margin: 0 0 16px;
}
.account-picker h3 span {
  font-size: 12px;
  color: var(--el-color-primary);
}
.filters {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}
.selection-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 12px 0;
}
.account-choices {
  max-height: 360px;
  overflow: auto;
  display: grid;
  gap: 8px;
}
.account-choice {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  padding: 11px 14px;
  cursor: pointer;
}
.account-choice.selected {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}
.account-choice b {
  font-size: 13px;
}
.account-choice small {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.7;
}
.account-picker {
  min-width: 0;
}
@media (max-width: 720px) {
  .edit-grid {
    grid-template-columns: 1fr;
  }
  .settings {
    border-right: 0;
    padding-right: 0;
  }
  .order-heading {
    align-items: flex-start;
  }
}
</style>
