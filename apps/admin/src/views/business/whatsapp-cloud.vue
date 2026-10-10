<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTabPane,
  ElTabs,
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import { api, date, type LoginCode } from "#/api/business";
import CloudChat from "./cloud-chat.vue";
import "./common.css";
interface CloudNumber {
  id: string;
  label: string;
  phoneId: string;
  wabaId: string;
  appId: string;
  displayPhone: string;
  verifiedName: string;
  quality: string;
  enabled: boolean;
  authStatus: string;
  lastError: string;
  checkedAt: string;
  subscribedAt: string | null;
  webhookVerifiedAt: string | null;
  lastEventAt: string | null;
  templatesAt: string | null;
  codeIds: string[];
  chatCount: number;
}
const qualities: Record<string, string> = {
  GREEN: "良好",
  YELLOW: "一般",
  RED: "较低",
  UNKNOWN: "待确认",
  NA: "暂无",
};
const rows = ref<CloudNumber[]>([]),
  codes = ref<LoginCode[]>([]),
  tab = ref("numbers"),
  selected = ref("");
const query = ref(""),
  loading = ref(false),
  saving = ref(false),
  editing = ref("");
const formOpen = ref(false),
  assignmentOpen = ref(false),
  callbackOpen = ref(false),
  assignmentNumber = ref<CloudNumber>();
const assigned = ref<string[]>([]),
  callback = reactive({ url: "", path: "", verifyToken: "" });
const config = ref({ publicURL: "", graphVersion: "" });
const form = reactive({
  label: "",
  appId: "",
  appSecret: "",
  phoneId: "",
  wabaId: "",
  token: "",
  enabled: true,
});
const filtered = computed(() =>
  rows.value.filter((r) =>
    `${r.label}${r.displayPhone}${r.verifiedName}${r.phoneId}`
      .toLowerCase()
      .includes(query.value.toLowerCase()),
  ),
);
const codeNames = computed(() => new Map(codes.value.map((c) => [c.id, c.label])));
const eligible = (c: LoginCode) =>
  c.enabled &&
  new Date(c.expiresAt).getTime() > Date.now() &&
  c.allowedPlatforms.includes("whatsapp_cloud");
async function load() {
  loading.value = true;
  try {
    const [n, c, settings] = await Promise.all([
      api.get<CloudNumber[]>("/whatsapp-cloud/numbers"),
      api.get<LoginCode[]>("/login-codes"),
      api.get<typeof config.value>("/whatsapp-cloud/config"),
    ]);
    rows.value = n;
    codes.value = c;
    config.value = settings;
    if (selected.value && !n.some((x) => x.id === selected.value)) selected.value = "";
  } finally {
    loading.value = false;
  }
}
function openCreate() {
  editing.value = "";
  Object.assign(form, {
    label: "",
    appId: "",
    appSecret: "",
    phoneId: "",
    wabaId: "",
    token: "",
    enabled: true,
  });
  formOpen.value = true;
}
function openEdit(n: CloudNumber) {
  editing.value = n.id;
  Object.assign(form, {
    label: n.label,
    appId: n.appId,
    phoneId: n.phoneId,
    wabaId: n.wabaId,
    appSecret: "",
    token: "",
    enabled: n.enabled,
  });
  formOpen.value = true;
}
async function save() {
  if (!form.label.trim()) {
    ElMessage.warning("请填写号码名称");
    return;
  }
  if (
    !editing.value &&
    (!form.appId || !form.appSecret || !form.phoneId || !form.wabaId || !form.token)
  ) {
    ElMessage.warning("请完整填写 Meta 接入资料");
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await api.request(`/whatsapp-cloud/numbers/${editing.value}`, {
        method: "PATCH",
        data: {
          label: form.label,
          enabled: form.enabled,
          token: form.token,
          appSecret: form.appSecret,
        },
        timeout: 30000,
      });
      ElMessage.success("号码设置已保存");
    } else {
      await api.post("/whatsapp-cloud/numbers", form, { timeout: 30000 });
      ElMessage.success("号码已验证并接入，请继续配置回调和分配登录码");
    }
    formOpen.value = false;
    form.token = "";
    form.appSecret = "";
    await load();
  } finally {
    saving.value = false;
  }
}
async function perform(n: CloudNumber, action: string, message: string) {
  saving.value = true;
  try {
    await api.post(`/whatsapp-cloud/numbers/${n.id}/${action}`, {}, { timeout: 30000 });
    ElMessage.success(message);
    await load();
  } finally {
    saving.value = false;
  }
}
function assignments(n: CloudNumber) {
  assignmentNumber.value = n;
  assigned.value = [...n.codeIds];
  assignmentOpen.value = true;
}
async function saveAssignments() {
  if (!assignmentNumber.value) return;
  saving.value = true;
  try {
    await api.put(`/whatsapp-cloud/numbers/${assignmentNumber.value.id}/assignments`, {
      codeIds: assigned.value,
    });
    assignmentOpen.value = false;
    ElMessage.success("登录码分配已保存");
    await load();
  } finally {
    saving.value = false;
  }
}
async function showCallback(n: CloudNumber) {
  Object.assign(callback, await api.post(`/whatsapp-cloud/numbers/${n.id}/webhook`, {}));
  callbackOpen.value = true;
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("复制失败，请选中文字手动复制");
  }
}
function chat(n: CloudNumber) {
  selected.value = n.id;
  tab.value = "chat";
}
onMounted(load);
</script>
<template>
  <div class="business cloud-module">
    <div class="page-head">
      <div>
        <h1>WhatsApp API</h1>
        <p class="subtitle">接入官方业务号码，分配登录码，集中处理客户消息。</p>
      </div>
      <ElButton v-if="tab === 'numbers'" type="primary" @click="openCreate"
        >＋ 添加 API 号码</ElButton
      >
    </div>
    <ElTabs v-model="tab" class="cloud-tabs">
      <ElTabPane label="号码管理" name="numbers">
        <div class="cloud-steps panel">
          <div>
            <span>01</span><strong>准备 Meta 资料</strong>
            <p>应用 ID、应用密钥、号码 ID、WABA ID 和系统用户令牌。</p>
          </div>
          <div>
            <span>02</span><strong>验证并配置回调</strong>
            <p>添加号码后复制回调地址与校验串，在 Meta 订阅 messages。</p>
          </div>
          <div>
            <span>03</span><strong>分配登录码，开始聊天</strong>
            <p>勾选 WhatsApp API 平台的登录码可使用被分配的号码。</p>
          </div>
        </div>
        <ElAlert
          v-if="!config.publicURL"
          class="cloud-alert"
          title="本地开发模式：接收 Meta 消息需要公网 HTTPS 回调地址。部署时配置 GONGDAN_PUBLIC_URL 后，这里会生成完整地址。"
          type="info"
          :closable="false"
          show-icon
        />
        <div class="panel">
          <div class="toolbar">
            <ElInput
              v-model="query"
              clearable
              placeholder="搜索号码 / 名称 / 号码 ID"
              style="width: 310px"
            />
            <div class="grow" />
            <ElButton :loading="loading" @click="load">刷新状态</ElButton>
          </div>
          <ElTable
            :data="filtered"
            empty-text="暂无 API 号码，点击右上角添加已在 Meta 注册的业务号码"
          >
            <ElTableColumn label="号码" min-width="180"
              ><template #default="{ row }"
                ><strong>{{ row.label }}</strong>
                <div>{{ row.displayPhone }}</div>
                <small class="muted">{{ row.verifiedName }}</small></template
              ></ElTableColumn
            >
            <ElTableColumn label="号码 ID / WABA ID" min-width="190"
              ><template #default="{ row }"
                ><div>{{ row.phoneId }}</div>
                <small class="muted">{{ row.wabaId }}</small></template
              ></ElTableColumn
            >
            <ElTableColumn label="授权 / 质量" min-width="130"
              ><template #default="{ row }"
                ><ElTag :type="row.authStatus === 'valid' ? 'success' : 'warning'">{{
                  row.authStatus === "valid" ? "授权已验证" : "需检查授权"
                }}</ElTag>
                <div class="cloud-small">
                  质量：{{ qualities[row.quality] || row.quality }}
                </div></template
              ></ElTableColumn
            >
            <ElTableColumn label="回调" min-width="135"
              ><template #default="{ row }"
                ><ElTag :type="row.webhookVerifiedAt && row.subscribedAt ? 'success' : 'info'">{{
                  row.webhookVerifiedAt && row.subscribedAt ? "已验证并订阅" : "待配置"
                }}</ElTag>
                <div class="cloud-small">
                  {{ row.lastEventAt ? `最近 ${date(row.lastEventAt)}` : "尚未收到事件" }}
                </div></template
              ></ElTableColumn
            >
            <ElTableColumn label="分配登录码" min-width="140"
              ><template #default="{ row }"
                ><span>{{
                  row.codeIds.map((id: string) => codeNames.get(id) || "未知登录码").join("、") ||
                  "未分配"
                }}</span></template
              ></ElTableColumn
            >
            <ElTableColumn prop="chatCount" label="会话" width="75" />
            <ElTableColumn label="状态" width="85"
              ><template #default="{ row }"
                ><ElTag :type="row.enabled ? 'success' : 'info'">{{
                  row.enabled ? "启用" : "停用"
                }}</ElTag></template
              ></ElTableColumn
            >
            <ElTableColumn label="操作" min-width="260" fixed="right"
              ><template #default="{ row }"
                ><div class="cloud-actions">
                  <ElButton link type="primary" @click="chat(row)">聊天</ElButton
                  ><ElButton link type="primary" @click="openEdit(row)">编辑</ElButton
                  ><ElButton link type="primary" @click="assignments(row)">分配</ElButton
                  ><ElButton link type="primary" @click="showCallback(row)">回调配置</ElButton
                  ><ElButton link :disabled="saving" @click="perform(row, 'verify', '授权验证成功')"
                    >验证授权</ElButton
                  ><ElButton
                    link
                    :disabled="saving"
                    @click="perform(row, 'templates/sync', '模板同步完成')"
                    >同步模板</ElButton
                  ><ElButton
                    link
                    :disabled="saving"
                    @click="perform(row, 'subscribe', '号码对应的 WABA 已订阅')"
                    >订阅消息</ElButton
                  >
                </div></template
              ></ElTableColumn
            >
          </ElTable>
        </div>
      </ElTabPane>
      <ElTabPane label="在线聊天" name="chat"
        ><div class="cloud-chat-selector">
          <span>客服号码</span
          ><ElSelect v-model="selected" placeholder="选择 API 号码" style="width: 320px"
            ><ElOption
              v-for="n in rows"
              :key="n.id"
              :value="n.id"
              :label="`${n.label} · ${n.displayPhone}${n.enabled ? '' : '（已停用）'}`" /></ElSelect
          ><span class="subtitle">同一团队内跨客服账号查重</span>
        </div>
        <CloudChat v-if="selected && tab === 'chat'" :key="selected" :number-id="selected" />
        <div v-else class="panel cloud-empty">
          请选择已接入的 API 号码，查看对话与消息。
        </div></ElTabPane
      >
    </ElTabs>
    <ElDialog
      v-model="formOpen"
      :title="editing ? '编辑 API 号码' : '添加 WhatsApp API 号码'"
      width="640px"
      destroy-on-close
      @closed="
        form.token = '';
        form.appSecret = '';
      "
    >
      <ElForm label-position="top" @submit.prevent="save"
        ><div class="cloud-form-grid">
          <ElFormItem label="号码名称" required
            ><ElInput v-model="form.label" maxlength="100" placeholder="如：售前客服" /></ElFormItem
          ><ElFormItem label="Meta 应用 ID" required
            ><ElInput v-model="form.appId" :disabled="!!editing" placeholder="App ID" /></ElFormItem
          ><ElFormItem label="号码 ID" required
            ><ElInput
              v-model="form.phoneId"
              :disabled="!!editing"
              placeholder="Phone Number ID" /></ElFormItem
          ><ElFormItem label="WABA ID" required
            ><ElInput
              v-model="form.wabaId"
              :disabled="!!editing"
              placeholder="WhatsApp Business Account ID"
          /></ElFormItem>
        </div>
        <ElFormItem
          :label="editing ? '更新应用密钥（留空保留原值）' : '应用密钥 App Secret'"
          :required="!editing"
          ><ElInput
            v-model="form.appSecret"
            type="password"
            show-password
            autocomplete="off" /></ElFormItem
        ><ElFormItem
          :label="editing ? '更新访问令牌（留空保留原值）' : '系统用户访问令牌'"
          :required="!editing"
          ><ElInput v-model="form.token" type="password" show-password autocomplete="off"
        /></ElFormItem>
        <p class="subtitle">
          令牌需要 whatsapp_business_messaging 和 whatsapp_business_management
          权限。应用密钥用于验证 Meta 消息来源，同一应用下的号码共用回调。
        </p>
        <ElFormItem v-if="editing" label="启用状态"
          ><ElSwitch v-model="form.enabled" active-text="启用" inactive-text="停用" /></ElFormItem
      ></ElForm>
      <template #footer
        ><ElButton @click="formOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="save">{{
          editing ? "保存设置" : "验证并添加"
        }}</ElButton></template
      >
    </ElDialog>
    <ElDialog v-model="assignmentOpen" title="分配登录码" width="520px"
      ><p class="subtitle">
        登录码须已勾选 WhatsApp API 平台。取消分配后，该登录码将无法再读取或发送此号码的消息。
      </p>
      <ElSelect
        v-model="assigned"
        multiple
        filterable
        placeholder="选择可使用此号码的登录码"
        style="width: 100%"
        ><ElOption
          v-for="code in codes"
          :key="code.id"
          :value="code.id"
          :disabled="!eligible(code)"
          :label="code.label + (eligible(code) ? '' : '（未授权或已停用/到期）')" /></ElSelect
      ><template #footer
        ><ElButton @click="assignmentOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="saving" @click="saveAssignments"
          >保存分配</ElButton
        ></template
      ></ElDialog
    >
    <ElDialog
      v-model="callbackOpen"
      title="配置 Meta Webhook"
      width="660px"
      @closed="callback.verifyToken = ''"
    >
      <p class="subtitle">
        在 Meta 应用的 WhatsApp → 配置 → Webhook 中填写以下内容，订阅
        messages，然后回到号码列表点击“订阅消息”。
      </p>
      <ElAlert
        v-if="!callback.url"
        title="尚未配置公网域名，本地地址不能用于 Meta 回调。部署时设置 GONGDAN_PUBLIC_URL=https://你的域名。"
        type="warning"
        :closable="false"
      />
      <ElForm label-position="top"
        ><ElFormItem label="回调地址"
          ><ElInput :model-value="callback.url || callback.path" readonly
            ><template #append
              ><ElButton @click="copy(callback.url || callback.path)">复制</ElButton></template
            ></ElInput
          ></ElFormItem
        ><ElFormItem label="校验串 Verify Token"
          ><ElInput :model-value="callback.verifyToken" readonly
            ><template #append
              ><ElButton @click="copy(callback.verifyToken)">复制</ElButton></template
            ></ElInput
          ></ElFormItem
        ></ElForm
      >
      <p class="subtitle">同一 Meta 应用的多个号码使用这一个回调地址，无需反复覆盖配置。</p>
    </ElDialog>
  </div>
</template>
<style scoped>
.cloud-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 28px;
}
.cloud-steps span {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: #edf0ff;
  color: #5266ef;
  margin-right: 10px;
  font-size: 12px;
  font-weight: 700;
}
.cloud-steps p {
  font-size: 13px;
  color: #8a95a9;
  margin: 12px 0 0;
}
.cloud-alert {
  margin-bottom: 20px;
}
.cloud-actions {
  display: flex;
  gap: 4px 10px;
  flex-wrap: wrap;
}
.cloud-actions :deep(.el-button) {
  margin-left: 0;
}
.cloud-small {
  font-size: 11px;
  color: #8a95a9;
  margin-top: 7px;
}
.cloud-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 20px;
}
.cloud-chat-selector {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 4px 0 18px;
}
.cloud-empty {
  padding: 80px;
  text-align: center;
  color: #8a95a9;
}
.cloud-module :deep(.el-tabs__header) {
  margin-bottom: 20px;
}
.cloud-tabs :deep(.el-tabs__item) {
  font-size: 15px;
}
.muted {
  color: #8a95a9;
}
</style>
