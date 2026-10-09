<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  ElButton,
  ElInput,
  ElInputNumber,
  ElTable,
  ElTableColumn,
  ElTag,
  ElDialog,
  ElDatePicker,
  ElMessage,
  ElMessageBox,
  ElAlert,
  ElSelect,
  ElOption,
  ElCheckbox,
  ElCheckboxGroup,
} from "element-plus";
import {
  api,
  date,
  type LoginCode,
  type LoginCodeGroup,
  type PlatformOption,
} from "#/api/business";
import LoginCodeGroups from "./components/login-code-groups.vue";
import "./common.css";
const rows = ref<LoginCode[]>([]);
const platforms = ref<PlatformOption[]>([]);
const editing = ref<LoginCode>();
const platformName = (id: string) => platforms.value.find((p) => p.id === id)?.name || id;
const loading = ref(false);
const saving = ref(false);
const show = ref(false);
const secret = ref("");
const query = ref("");
const groups = ref<LoginCodeGroup[]>([]);
const groupFilter = ref("all");
const groupsOpen = ref(false);
const selected = ref<LoginCode[]>([]);
const table = ref<InstanceType<typeof ElTable>>();
const moveOpen = ref(false);
const moveIDs = ref<string[]>([]);
const moveGroupID = ref("");
const moving = ref(false);
const visibleRows = computed(() =>
  rows.value.filter(
    (row) =>
      (groupFilter.value === "all" || row.groupId === groupFilter.value) &&
      `${row.label}${row.maskedCode}`.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
);
const ungroupedCount = computed(() => rows.value.filter((row) => !row.groupId).length);
watch([query, groupFilter], () => table.value?.clearSelection());
const form = reactive({
  allowedPlatforms: [] as string[],
  label: "",
  groupId: "",
  maxDevices: 1,
  maxAccounts: 3,
  expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
});
interface Device {
  id: string;
  name: string;
  codeLabel: string;
  active: boolean;
  lastSeen: string;
}
const devices = ref<Device[]>([]);
const devicesOpen = ref(false);
async function load() {
  loading.value = true;
  try {
    const [codes, codeGroups, catalog] = await Promise.all([
      api.get<LoginCode[]>("/login-codes"),
      api.get<LoginCodeGroup[]>("/login-code-groups"),
      api.get<PlatformOption[]>("/platforms"),
    ]);
    rows.value = codes;
    platforms.value = catalog;
    groups.value = codeGroups;
    table.value?.clearSelection();
    if (
      groupFilter.value !== "all" &&
      groupFilter.value &&
      !codeGroups.some((g) => g.id === groupFilter.value)
    )
      groupFilter.value = "all";
    if (form.groupId && !codeGroups.some((g) => g.id === form.groupId)) form.groupId = "";
  } finally {
    loading.value = false;
  }
}
function openCreate() {
  editing.value = undefined;
  Object.assign(form, {
    label: "",
    allowedPlatforms: [],
    maxDevices: 1,
    maxAccounts: 3,
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  form.groupId = groupFilter.value === "all" ? "" : groupFilter.value;
  show.value = true;
}
function openEdit(row: LoginCode) {
  editing.value = row;
  Object.assign(form, {
    label: row.label,
    groupId: row.groupId,
    allowedPlatforms: [...row.allowedPlatforms],
    maxDevices: row.maxDevices,
    maxAccounts: row.maxAccounts,
    expiresAt: row.expiresAt,
  });
  show.value = true;
}
function groupCreated(group: LoginCodeGroup) {
  if (show.value) {
    groups.value.push(group);
    form.groupId = group.id;
    groupsOpen.value = false;
  }
}
function openMove(codes: LoginCode[]) {
  if (!codes.length || codes.length > 500) {
    ElMessage.warning("每次请选择 1–500 个登录码");
    return;
  }
  moveIDs.value = codes.map((row) => row.id);
  moveGroupID.value = codes.every((row) => row.groupId === codes[0]!.groupId)
    ? codes[0]!.groupId
    : "";
  moveOpen.value = true;
}
async function move() {
  moving.value = true;
  try {
    await api.post("/login-codes/move-group", { ids: moveIDs.value, groupId: moveGroupID.value });
    moveOpen.value = false;
    ElMessage.success(`已更新 ${moveIDs.value.length} 个登录码的分组`);
    await load();
  } finally {
    moving.value = false;
  }
}
async function create() {
  if (saving.value || (!editing.value && !form.allowedPlatforms.length)) return;
  saving.value = true;
  try {
    if (editing.value) {
      await api.request(`/login-codes/${editing.value.id}`, {
        method: "PATCH",
        data: { ...form, enabled: editing.value.enabled },
      });
      ElMessage.success("登录码已更新");
    } else {
      const result = await api.post<{ code: string }>("/login-codes", form);
      secret.value = result.code;
    }
    show.value = false;
    form.label = "";
    await load();
  } finally {
    saving.value = false;
  }
}
async function toggle(row: LoginCode) {
  await ElMessageBox.confirm(
    row.enabled
      ? "停用后，在线客户端将在下一次心跳失去访问权限。"
      : "恢复后使用者可再次使用该登录码登录。",
    row.enabled ? "停用登录码" : "启用登录码",
    { type: "warning" },
  );
  await api.request(`/login-codes/${row.id}`, {
    method: "PATCH",
    data: { ...row, enabled: !row.enabled },
  });
  await load();
}
async function reset(row: LoginCode) {
  await ElMessageBox.confirm(
    "旧码和已有客户端会话将失效，账号绑定与本地平台登录资料会保留。",
    "重置登录码",
    { type: "warning" },
  );
  const result = await api.post<{ code: string }>(`/login-codes/${row.id}/reset`);
  secret.value = result.code;
  await load();
}
async function deviceList() {
  devices.value = await api.get("/devices");
  devicesOpen.value = true;
}
async function unbind(row: Device) {
  await ElMessageBox.confirm(
    "将收回该设备的访问权限并释放名额。新设备打开账号需要重新扫码。持有码的人仍可重新登录；如需禁止，请同时重置登录码。",
    "解绑设备",
    { type: "warning" },
  );
  await api.delete(`/devices/${row.id}`);
  await deviceList();
  await load();
}
async function copy() {
  try {
    await navigator.clipboard.writeText(secret.value);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("请手动选择并复制登录码");
  }
}
const expired = (value: string) => Date.parse(value) < Date.now();
onMounted(load);
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>登录码列表</h1>
        <p class="subtitle">创建时勾选客户端可用平台，并设置有效期、设备数与账号额度。</p>
      </div>
      <ElButton type="primary" @click="openCreate">＋ 创建登录码</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar">
        <ElSelect v-model="groupFilter" aria-label="筛选分组" style="width: 190px" filterable>
          <ElOption :label="`全部分组（${rows.length}）`" value="all" />
          <ElOption :label="`未分组（${ungroupedCount}）`" value="" />
          <ElOption
            v-for="group in groups"
            :key="group.id"
            :label="`${group.name}（${group.codeCount}）`"
            :value="group.id"
          />
        </ElSelect>
        <ElInput
          v-model="query"
          placeholder="搜索名称或登录码尾号"
          clearable
          style="width: 270px"
        />
        <div class="grow" />
        <ElButton @click="groupsOpen = true">管理分组</ElButton>
        <ElButton :disabled="!selected.length || loading" @click="openMove(selected)"
          >移动分组<span v-if="selected.length">（{{ selected.length }}）</span></ElButton
        >
        <ElButton @click="deviceList">管理设备</ElButton><ElButton @click="load">刷新</ElButton>
      </div>
      <ElTable
        ref="table"
        row-key="id"
        v-loading="loading"
        :data="visibleRows"
        @selection-change="selected = $event"
        :empty-text="rows.length ? '没有符合条件的登录码' : '还没有登录码，点击“创建登录码”开始'"
        ><ElTableColumn type="selection" width="44" /><ElTableColumn
          prop="label"
          label="名称 / 使用者"
          min-width="140"
        /><ElTableColumn label="登录码" min-width="175"
          ><template #default="{ row }"
            ><span class="code">{{ row.maskedCode }}</span></template
          ></ElTableColumn
        ><ElTableColumn label="分组" min-width="120" show-overflow-tooltip>
          <template #default="{ row }"
            ><span :class="{ muted: !row.groupId }">{{ row.groupName || "未分组" }}</span></template
          > </ElTableColumn
        ><ElTableColumn label="可用平台" min-width="155"
          ><template #default="{ row }"
            ><span v-if="!row.allowedPlatforms.length" class="muted">未分配平台</span
            ><ElTag
              v-for="platform in row.allowedPlatforms"
              :key="platform"
              size="small"
              style="margin: 2px 4px 2px 0"
              >{{ platformName(platform) }}</ElTag
            ></template
          ></ElTableColumn
        ><ElTableColumn label="状态" width="100"
          ><template #default="{ row }"
            ><ElTag :type="!row.enabled ? 'info' : expired(row.expiresAt) ? 'danger' : 'success'">{{
              !row.enabled ? "已停用" : expired(row.expiresAt) ? "已到期" : "正常"
            }}</ElTag></template
          ></ElTableColumn
        ><ElTableColumn label="设备 / 额度" width="110"
          ><template #default="{ row }"
            >{{ row.deviceCount }} / {{ row.maxDevices }}</template
          ></ElTableColumn
        ><ElTableColumn label="账号 / 额度" width="110"
          ><template #default="{ row }"
            >{{ row.accountCount }} / {{ row.maxAccounts }}</template
          ></ElTableColumn
        ><ElTableColumn label="到期时间" min-width="170"
          ><template #default="{ row }">{{ date(row.expiresAt) }}</template></ElTableColumn
        ><ElTableColumn label="操作" width="250" fixed="right"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="openEdit(row)">编辑</ElButton
            ><ElButton link type="primary" @click="openMove([row])">分组</ElButton
            ><ElButton link type="primary" @click="reset(row)">重置</ElButton
            ><ElButton link :type="row.enabled ? 'danger' : 'primary'" @click="toggle(row)">{{
              row.enabled ? "停用" : "启用"
            }}</ElButton></template
          ></ElTableColumn
        ></ElTable
      >
    </div>
    <ElDialog
      v-model="show"
      :title="editing ? '编辑登录码' : '创建长期登录码'"
      width="560px"
      :close-on-click-modal="false"
      :show-close="!saving"
      :close-on-press-escape="!saving"
      ><form class="form-grid" @submit.prevent="create">
        <label class="field"
          >使用者 / 备注名称<ElInput
            v-model="form.label"
            maxlength="100"
            placeholder="例如：客服小林、投手小王"
            required
        /></label>
        <div v-if="!editing" class="field">
          <span>选择分组</span>
          <div class="group-select-row">
            <ElSelect v-model="form.groupId" aria-label="选择分组" filterable>
              <ElOption label="未分组" value="" />
              <ElOption
                v-for="group in groups"
                :key="group.id"
                :label="group.name"
                :value="group.id"
              />
            </ElSelect>
            <ElButton @click="groupsOpen = true">新建分组</ElButton>
          </div>
        </div>
        <div class="field">
          <span
            >客户端可用平台
            <span v-if="!editing" style="color: var(--el-color-danger)">*</span></span
          >
          <ElCheckboxGroup
            v-model="form.allowedPlatforms"
            aria-label="客户端可用平台"
            :disabled="saving"
            class="platform-choices"
          >
            <ElCheckbox
              v-for="platform in platforms"
              :key="platform.id"
              :value="platform.id"
              :disabled="!platform.available"
              border
              >{{ platform.name
              }}<span v-if="!platform.available" class="muted"> · 待开放</span></ElCheckbox
            >
          </ElCheckboxGroup>
          <small>客户端只能添加和打开已勾选的平台，平台账号由使用者在客户端登录。</small>
          <small v-if="editing"
            >取消授权后，已打开的对应平台会在客户端下次同步时暂停，本地登录资料保留。</small
          >
          <ElAlert
            v-if="!form.allowedPlatforms.length"
            :title="
              editing
                ? '未选择任何平台，客户端将无法添加或打开平台账号。'
                : '请至少勾选一个已开放的平台。'
            "
            type="warning"
            :closable="false"
          />
        </div>
        <label class="field"
          >有效期至<ElDatePicker
            v-model="form.expiresAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            style="width: 100%"
            :clearable="false" /></label
        ><label class="field"
          >最多设备数<ElInputNumber v-model="form.maxDevices" :min="1" :max="100" /></label
        ><label class="field"
          >平台账号额度<ElInputNumber v-model="form.maxAccounts" :min="1" :max="500" /></label
        ><ElButton
          native-type="submit"
          type="primary"
          :loading="saving"
          :disabled="!editing && !form.allowedPlatforms.length"
          >{{ editing ? "保存更改" : "生成登录码" }}</ElButton
        >
      </form></ElDialog
    ><ElDialog
      :model-value="!!secret"
      title="登录码已生成"
      width="540px"
      :close-on-click-modal="false"
      @close="secret = ''"
      ><ElAlert
        title="完整登录码仅显示本次，请复制后交给使用者。"
        type="success"
        :closable="false"
      />
      <p class="secret" style="margin-top: 18px">{{ secret }}</p>
      <template #footer
        ><ElButton @click="secret = ''">已保存，关闭</ElButton
        ><ElButton type="primary" @click="copy">复制登录码</ElButton></template
      ></ElDialog
    ><ElDialog v-model="devicesOpen" title="设备管理" width="760px"
      ><ElTable :data="devices" empty-text="使用者登录客户端后，设备会出现在这里"
        ><ElTableColumn prop="name" label="设备" /><ElTableColumn
          prop="codeLabel"
          label="所属登录码"
        /><ElTableColumn label="最近心跳" width="180"
          ><template #default="{ row }">{{ date(row.lastSeen) }}</template></ElTableColumn
        ><ElTableColumn width="100"
          ><template #default="{ row }"
            ><ElButton v-if="row.active" link type="danger" @click="unbind(row)">解绑</ElButton
            ><span v-else class="muted">已解绑</span></template
          ></ElTableColumn
        ></ElTable
      ></ElDialog
    >
    <LoginCodeGroups
      v-model="groupsOpen"
      :groups="groups"
      @created="groupCreated"
      @changed="load"
    />
    <ElDialog v-model="moveOpen" title="移动分组" width="420px" :close-on-click-modal="false">
      <form class="form-grid" @submit.prevent="move">
        <p>将 {{ moveIDs.length }} 个登录码移动到：</p>
        <ElSelect v-model="moveGroupID" aria-label="目标分组" filterable>
          <ElOption label="未分组" value="" />
          <ElOption v-for="group in groups" :key="group.id" :label="group.name" :value="group.id" />
        </ElSelect>
        <ElButton native-type="submit" type="primary" :loading="moving">确认移动</ElButton>
      </form>
    </ElDialog>
  </div>
</template>
<style scoped>
.platform-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.platform-choices .el-checkbox {
  margin: 0;
}
.group-select-row {
  display: flex;
  gap: 10px;
}
.group-select-row .el-select {
  flex: 1;
  min-width: 0;
}
</style>
