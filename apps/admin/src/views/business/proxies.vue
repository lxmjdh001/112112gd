<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  ElButton,
  ElInput,
  ElInputNumber,
  ElTable,
  ElTableColumn,
  ElDialog,
  ElSelect,
  ElOption,
  ElMessage,
  ElMessageBox,
  ElAlert,
  ElTag,
  ElSwitch,
} from "element-plus";
import { api, type ProxyItem, type ProxyGroup } from "#/api/business";
import ProxyGroups from "./components/proxy-groups.vue";
import "./common.css";
const rows = ref<ProxyItem[]>([]);
const groups = ref<ProxyGroup[]>([]);
const query = ref("");
const groupFilter = ref("all");
const statusFilter = ref("all");
const groupsOpen = ref(false);
const loading = ref(false);
const show = ref(false);
const saving = ref(false);
const form = reactive({
  protocol: "socks5",
  groupId: "",
  lines: "",
  maxAccountsPerPlatform: 1,
  enabled: true,
});
const edit = ref<ProxyItem>();
const settings = reactive({ groupId: "", maxAccountsPerPlatform: 1, enabled: true });
const errors = ref("");
const table = ref<InstanceType<typeof ElTable>>();
const selected = ref<ProxyItem[]>([]);
const moveOpen = ref(false);
const moveGroupID = ref("");
const visibleRows = computed(() =>
  rows.value.filter(
    (row) =>
      (groupFilter.value === "all" || row.groupId === groupFilter.value) &&
      (statusFilter.value === "all" || row.enabled === (statusFilter.value === "enabled")) &&
      `${row.host}${row.port}${row.username}${row.group}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()),
  ),
);
const ungroupedCount = computed(() => rows.value.filter((row) => !row.groupId).length);
const usageText = (row: ProxyItem) =>
  Object.entries(row.platformUsage)
    .map(
      ([platform, count]) =>
        `${platform === "whatsapp" ? "WhatsApp" : platform} ${count}/${row.maxAccountsPerPlatform}`,
    )
    .join("，") || "尚未关联账号";
watch([query, groupFilter, statusFilter], () => table.value?.clearSelection());
watch([() => form.lines, () => form.protocol], () => {
  errors.value = "";
});
async function load() {
  loading.value = true;
  try {
    [rows.value, groups.value] = await Promise.all([
      api.get<ProxyItem[]>("/proxies"),
      api.get<ProxyGroup[]>("/proxy-groups"),
    ]);
    table.value?.clearSelection();
    if (
      groupFilter.value !== "all" &&
      groupFilter.value &&
      !groups.value.some((group) => group.id === groupFilter.value)
    )
      groupFilter.value = "all";
    if (form.groupId && !groups.value.some((group) => group.id === form.groupId)) form.groupId = "";
    if (settings.groupId && !groups.value.some((group) => group.id === settings.groupId))
      settings.groupId = "";
  } finally {
    loading.value = false;
  }
}
function openImport() {
  form.groupId = groupFilter.value === "all" ? "" : groupFilter.value;
  errors.value = "";
  show.value = true;
}
function groupCreated(group: ProxyGroup) {
  groups.value.push(group);
  if (show.value) {
    form.groupId = group.id;
    groupsOpen.value = false;
  } else if (edit.value) {
    settings.groupId = group.id;
    groupsOpen.value = false;
  }
}
function openSettings(row: ProxyItem) {
  Object.assign(settings, {
    groupId: row.groupId,
    maxAccountsPerPlatform: row.maxAccountsPerPlatform,
    enabled: row.enabled,
  });
  edit.value = row;
}
async function confirmDisable() {
  return ElMessageBox.confirm(
    "禁用后不能新增关联，正在使用此代理的客户端会在下一次同步时暂停对应账号；登录资料保留。重新启用后可再次打开账号。",
    "禁用代理",
    { type: "warning", confirmButtonText: "确认禁用", cancelButtonText: "取消" },
  )
    .then(() => true)
    .catch(() => false);
}
async function toggle(items: ProxyItem[], enabled: boolean) {
  if (!enabled && !(await confirmDisable())) return;
  saving.value = true;
  try {
    await api.post("/proxies/batch", { ids: items.map((item) => item.id), enabled });
    ElMessage.success(enabled ? "代理已启用" : "代理已禁用");
    await load();
  } finally {
    saving.value = false;
  }
}
async function saveSettings() {
  if (!edit.value || saving.value) return;
  if (edit.value.enabled && !settings.enabled && !(await confirmDisable())) return;
  saving.value = true;
  try {
    await api.request(`/proxies/${edit.value.id}`, { method: "PATCH", data: settings });
    edit.value = undefined;
    ElMessage.success("代理设置已保存");
    await load();
  } finally {
    saving.value = false;
  }
}
async function move() {
  saving.value = true;
  try {
    await api.post("/proxies/batch", {
      ids: selected.value.map((item) => item.id),
      groupId: moveGroupID.value,
    });
    moveOpen.value = false;
    ElMessage.success("代理分组已更新");
    await load();
  } finally {
    saving.value = false;
  }
}
async function save() {
  saving.value = true;
  errors.value = "";
  try {
    const result = await api.post<{ imported: number; duplicates: number }>(
      "/proxies/import",
      form,
    );
    ElMessage.success(`已导入 ${result.imported} 个代理，跳过 ${result.duplicates} 个重复行`);
    show.value = false;
    form.lines = "";
    await load();
  } catch (e) {
    const err = e as { message?: string; errors?: { line: number; message: string }[] };
    errors.value =
      err.errors?.map((x) => `第 ${x.line} 行：${x.message}`).join("；") ||
      err.message ||
      "导入未完成，请检查后重试。";
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>代理管理</h1>
        <p class="subtitle">按分组管理代理，为每个平台设置账号额度，统一控制启用状态。</p>
      </div>
      <ElButton type="primary" @click="openImport">＋ 添加 / 批量导入</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar">
        <ElSelect
          v-model="groupFilter"
          :empty-values="[null, undefined]"
          aria-label="筛选代理分组"
          filterable
          style="width: 180px"
        >
          <ElOption :label="`全部分组（${rows.length}）`" value="all" /><ElOption
            :label="`未分组（${ungroupedCount}）`"
            value=""
          />
          <ElOption
            v-for="group in groups"
            :key="group.id"
            :label="`${group.name}（${group.proxyCount}）`"
            :value="group.id"
          />
        </ElSelect>
        <ElSelect v-model="statusFilter" aria-label="筛选代理状态" style="width: 125px"
          ><ElOption label="全部状态" value="all" /><ElOption
            label="已启用"
            value="enabled" /><ElOption label="已禁用" value="disabled"
        /></ElSelect>
        <ElInput
          v-model="query"
          placeholder="搜索主机、用户名或分组"
          clearable
          style="width: 250px"
        />
        <div class="grow" />
        <ElButton @click="groupsOpen = true">管理分组</ElButton
        ><ElButton :loading="loading" @click="load">刷新</ElButton>
      </div>
      <div v-if="selected.length" class="toolbar batch-toolbar">
        <span>已选择 {{ selected.length }} 个代理</span>
        <ElButton
          :disabled="saving || selected.length > 500"
          @click="
            moveGroupID = '';
            moveOpen = true;
          "
          >移动分组</ElButton
        >
        <ElButton :disabled="saving || selected.length > 500" @click="toggle(selected, true)"
          >批量启用</ElButton
        >
        <ElButton :disabled="saving || selected.length > 500" @click="toggle(selected, false)"
          >批量禁用</ElButton
        >
        <span class="muted">每次最多 500 个</span>
      </div>
      <ElTable
        ref="table"
        v-loading="loading"
        :data="visibleRows"
        row-key="id"
        @selection-change="selected = $event"
        :empty-text="rows.length ? '没有符合条件的代理' : '添加代理后，可在客户端添加账号时选择'"
      >
        <ElTableColumn type="selection" width="44" />
        <ElTableColumn prop="protocol" label="协议" width="90" />
        <ElTableColumn label="代理地址" min-width="180" show-overflow-tooltip
          ><template #default="{ row }">{{ row.host }}:{{ row.port }}</template></ElTableColumn
        >
        <ElTableColumn prop="username" label="用户名" min-width="110" show-overflow-tooltip />
        <ElTableColumn label="分组" min-width="120" show-overflow-tooltip
          ><template #default="{ row }">{{ row.group || "未分组" }}</template></ElTableColumn
        >
        <ElTableColumn prop="maxAccountsPerPlatform" label="每平台上限" width="110" />
        <ElTableColumn label="已关联 / 上限" min-width="155" show-overflow-tooltip
          ><template #default="{ row }">{{ usageText(row) }}</template></ElTableColumn
        >
        <ElTableColumn label="状态" width="90"
          ><template #default="{ row }"
            ><ElTag :type="row.enabled ? 'success' : 'info'">{{
              row.enabled ? "已启用" : "已禁用"
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="操作" width="140" fixed="right"
          ><template #default="{ row }"
            ><ElButton link type="primary" :disabled="saving" @click="openSettings(row)"
              >设置</ElButton
            ><ElButton
              link
              :type="row.enabled ? 'danger' : 'primary'"
              :disabled="saving"
              @click="toggle([row], !row.enabled)"
              >{{ row.enabled ? "禁用" : "启用" }}</ElButton
            ></template
          ></ElTableColumn
        >
      </ElTable>
      <p class="subtitle">
        每平台上限按同一代理已关联的账号计算，待扫码及离线账号也占用额度。连接是否可用以客户端实际检测为准。
      </p>
    </div>
    <ElDialog v-model="show" title="批量添加代理" width="620px" :close-on-click-modal="false">
      <form class="form-grid" @submit.prevent="save">
        <div class="toolbar">
          <label class="field"
            >默认协议<ElSelect v-model="form.protocol" style="width: 140px"
              ><ElOption label="SOCKS5" value="socks5" /><ElOption
                label="HTTP"
                value="http" /><ElOption label="HTTPS" value="https" /></ElSelect
          ></label>
          <div class="field grow">
            <span>选择分组</span>
            <div class="group-row">
              <ElSelect
                v-model="form.groupId"
                :empty-values="[null, undefined]"
                aria-label="选择代理分组"
                filterable
                ><ElOption label="未分组" value="" /><ElOption
                  v-for="group in groups"
                  :key="group.id"
                  :label="group.name"
                  :value="group.id" /></ElSelect
              ><ElButton @click="groupsOpen = true">新建分组</ElButton>
            </div>
          </div>
        </div>
        <div class="settings-grid">
          <label class="field"
            >每平台最多关联账号数<ElInputNumber
              v-model="form.maxAccountsPerPlatform"
              aria-label="每平台最多关联账号数"
              :min="1"
              :max="10000" /></label
          ><label class="field"
            >启用状态<ElSwitch
              v-model="form.enabled"
              aria-label="启用代理"
              active-text="启用"
              inactive-text="禁用"
          /></label>
        </div>
        <label class="field"
          >代理地址 · 每行一个<ElInput
            v-model="form.lines"
            type="textarea"
            :rows="6"
            placeholder="127.0.0.1:1080&#10;host:port:username:password&#10;socks5://username:password@host:port"
          /><small
            >本次导入统一使用所选分组、每平台额度和启用状态。回车换行，URL 协议优先，每次最多 100
            行；错误行整批不保存，重复行跳过。密码中的特殊字符请进行 URL 编码。</small
          ></label
        >
        <ElAlert v-if="errors" :title="errors" type="error" :closable="false" /><ElButton
          type="primary"
          native-type="submit"
          :disabled="!form.lines.trim()"
          :loading="saving"
          >识别并保存代理</ElButton
        >
      </form>
    </ElDialog>
    <ElDialog
      :model-value="!!edit"
      title="代理设置"
      width="490px"
      :close-on-click-modal="false"
      @close="edit = undefined"
    >
      <form v-if="edit" class="form-grid" @submit.prevent="saveSettings">
        <p class="muted">{{ edit.protocol }}://{{ edit.host }}:{{ edit.port }}</p>
        <div class="field">
          <span>选择分组</span>
          <div class="group-row">
            <ElSelect
              v-model="settings.groupId"
              :empty-values="[null, undefined]"
              aria-label="调整代理分组"
              filterable
              ><ElOption label="未分组" value="" /><ElOption
                v-for="group in groups"
                :key="group.id"
                :label="group.name"
                :value="group.id" /></ElSelect
            ><ElButton @click="groupsOpen = true">新建分组</ElButton>
          </div>
        </div>
        <label class="field"
          >每平台最多关联账号数<ElInputNumber
            v-model="settings.maxAccountsPerPlatform"
            aria-label="调整每平台上限"
            :min="1"
            :max="10000"
          /><small>{{ usageText(edit) }}；不能低于已有账号数。</small></label
        >
        <label class="field"
          >启用状态<ElSwitch
            v-model="settings.enabled"
            aria-label="调整启用状态"
            active-text="启用"
            inactive-text="禁用"
        /></label>
        <ElButton type="primary" native-type="submit" :loading="saving">保存设置</ElButton>
      </form>
    </ElDialog>
    <ProxyGroups v-model="groupsOpen" :groups="groups" @created="groupCreated" @changed="load" />
    <ElDialog v-model="moveOpen" title="移动代理分组" width="420px" :close-on-click-modal="false"
      ><form class="form-grid" @submit.prevent="move">
        <p>将 {{ selected.length }} 个代理移动到：</p>
        <ElSelect
          v-model="moveGroupID"
          :empty-values="[null, undefined]"
          aria-label="目标代理分组"
          filterable
          ><ElOption label="未分组" value="" /><ElOption
            v-for="group in groups"
            :key="group.id"
            :label="group.name"
            :value="group.id" /></ElSelect
        ><ElButton type="primary" native-type="submit" :loading="saving">确认移动</ElButton>
      </form></ElDialog
    >
  </div>
</template>
<style scoped>
.group-row {
  display: flex;
  gap: 8px;
}
.group-row .el-select {
  flex: 1;
  min-width: 0;
}
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.batch-toolbar {
  padding: 10px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  font-size: 13px;
}
</style>
