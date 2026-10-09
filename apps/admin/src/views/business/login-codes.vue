<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
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
} from "element-plus";
import { api, date, type LoginCode } from "#/api/business";
import "./common.css";
const rows = ref<LoginCode[]>([]);
const loading = ref(false);
const saving = ref(false);
const show = ref(false);
const secret = ref("");
const query = ref("");
const form = reactive({
  label: "",
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
    rows.value = await api.get("/login-codes");
  } finally {
    loading.value = false;
  }
}
async function create() {
  saving.value = true;
  try {
    const result = await api.post<{ code: string }>("/login-codes", form);
    secret.value = result.code;
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
      : "恢复后员工可再次使用该登录码登录。",
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
        <p class="subtitle">长期有效、可重复登录。通过设备额度控制员工使用范围。</p>
      </div>
      <ElButton type="primary" @click="show = true">＋ 创建登录码</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar">
        <ElInput
          v-model="query"
          placeholder="搜索名称或登录码尾号"
          clearable
          style="width: 270px"
        />
        <div class="grow" />
        <ElButton @click="deviceList">管理设备</ElButton><ElButton @click="load">刷新</ElButton>
      </div>
      <ElTable
        v-loading="loading"
        :data="
          rows.filter((r) =>
            `${r.label}${r.maskedCode}`.toLowerCase().includes(query.toLowerCase()),
          )
        "
        empty-text="还没有登录码，先为一名员工创建登录码"
        ><ElTableColumn prop="label" label="名称 / 员工" min-width="140" /><ElTableColumn
          label="登录码"
          min-width="175"
          ><template #default="{ row }"
            ><span class="code">{{ row.maskedCode }}</span></template
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
        ><ElTableColumn label="操作" width="155" fixed="right"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="reset(row)">重置</ElButton
            ><ElButton link :type="row.enabled ? 'danger' : 'primary'" @click="toggle(row)">{{
              row.enabled ? "停用" : "启用"
            }}</ElButton></template
          ></ElTableColumn
        ></ElTable
      >
    </div>
    <ElDialog v-model="show" title="创建长期登录码" width="480px" :close-on-click-modal="false"
      ><form class="form-grid" @submit.prevent="create">
        <label class="field"
          >员工 / 备注名称<ElInput
            v-model="form.label"
            maxlength="100"
            placeholder="例如：客服小林"
            required /></label
        ><label class="field"
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
        ><ElButton native-type="submit" type="primary" :loading="saving">生成登录码</ElButton>
      </form></ElDialog
    ><ElDialog
      :model-value="!!secret"
      title="登录码已生成"
      width="540px"
      :close-on-click-modal="false"
      @close="secret = ''"
      ><ElAlert title="完整登录码仅显示本次，请复制后交给员工。" type="success" :closable="false" />
      <p class="secret" style="margin-top: 18px">{{ secret }}</p>
      <template #footer
        ><ElButton @click="secret = ''">已保存，关闭</ElButton
        ><ElButton type="primary" @click="copy">复制登录码</ElButton></template
      ></ElDialog
    ><ElDialog v-model="devicesOpen" title="设备管理" width="760px"
      ><ElTable :data="devices" empty-text="员工登录客户端后，设备会出现在这里"
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
  </div>
</template>
