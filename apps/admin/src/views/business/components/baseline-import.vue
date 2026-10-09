<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  ElDialog,
  ElSelect,
  ElOption,
  ElInput,
  ElButton,
  ElTable,
  ElTableColumn,
  ElAlert,
  ElTag,
  ElMessage,
} from "element-plus";
import { api, type Account } from "#/api/business";
import {
  platformNames,
  type Platform,
  type Preview,
  type Batch,
  type ImportRow,
} from "#/api/baseline";
const props = defineProps<{ accounts: Account[] }>();
const emit = defineEmits<{ saved: [] }>();
const visible = ref(false),
  single = ref(false),
  platform = ref<Platform>("whatsapp"),
  accountId = ref(""),
  text = ref(""),
  identifier = ref(""),
  ip = ref(""),
  note = ref(""),
  source = ref("粘贴导入"),
  busy = ref(false),
  preview = ref<Preview>(),
  result = ref<Batch>(),
  requestId = ref("");
const fileInput = ref<HTMLInputElement>();
const options = computed(() => props.accounts.filter((a) => a.platform === platform.value));
const csvCell = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const content = computed(() =>
  single.value ? [identifier.value, ip.value, note.value].map(csvCell).join(",") : text.value,
);
watch(platform, () => (accountId.value = ""));
watch([content, platform, accountId, source], () => {
  preview.value = undefined;
  result.value = undefined;
  requestId.value = crypto.randomUUID();
});
function open(one = false) {
  single.value = one;
  visible.value = true;
  identifier.value = "";
  ip.value = "";
  note.value = "";
  text.value = "";
  accountId.value = "";
  source.value = one ? "手动录入" : "粘贴导入";
  preview.value = undefined;
  result.value = undefined;
  requestId.value = crypto.randomUUID();
}
async function readFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 160000) {
    ElMessage.warning("每批最多 160 KB，请分批导入");
    input.value = "";
    return;
  }
  text.value = await file.text();
  source.value = file.name.slice(0, 100);
  input.value = "";
}
function download(name: string, value: string) {
  const url = URL.createObjectURL(new Blob(["\ufeff" + value], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function template() {
  download(
    "底库导入模板.csv",
    "客户账号,客户IP,备注\n447410419512,,已有客户\n,203.0.113.10,客户提供的IP\n",
  );
}
function errors() {
  if (!result.value) return;
  download(
    "底库导入失败行.csv",
    "行号,客户账号,客户IP,备注,错误\n" +
      result.value.errors
        .map((r: ImportRow) =>
          [String(r.line), r.identifier, r.ip, r.note, r.error || ""]
            .map((value) => csvCell(/^[=+@\-\t\r]/.test(value) ? "'" + value : value))
            .join(","),
        )
        .join("\n"),
  );
}
async function check() {
  busy.value = true;
  try {
    preview.value = await api.post<Preview>("/baselines/preview", {
      platform: platform.value,
      accountId: accountId.value,
      text: content.value,
    });
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (!preview.value || busy.value) return;
  busy.value = true;
  try {
    result.value = await api.post<Batch>("/baselines/import", {
      platform: platform.value,
      accountId: accountId.value,
      text: content.value,
      source: source.value,
      requestId: requestId.value,
    });
    ElMessage.success("底库已更新");
    emit("saved");
  } finally {
    busy.value = false;
  }
}
defineExpose({ open });
</script>
<template>
  <ElDialog
    v-model="visible"
    :title="single ? '新增底库客户' : '批量导入底库'"
    width="820px"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <div v-if="!result" class="form-grid">
      <div class="baseline-import-grid">
        <label class="field"
          >平台<ElSelect v-model="platform" aria-label="底库平台" :disabled="busy"
            ><ElOption
              v-for="(name, id) in platformNames"
              :key="id"
              :label="name"
              :value="id" /></ElSelect
        ></label>
        <label class="field"
          >来源客服账号（选填）<ElSelect
            v-model="accountId"
            aria-label="来源客服账号"
            clearable
            :disabled="busy"
            ><ElOption v-for="a in options" :key="a.id" :label="a.label" :value="a.id" /></ElSelect
          ><small>仅记录来源，不限制查重范围。</small></label
        >
      </div>
      <ElAlert
        v-if="platform === 'line'"
        type="info"
        :closable="false"
        title="支持预先维护 LINE 底库；LINE 客户端登录与自动识别将在平台接入后开放。"
      />
      <template v-if="single"
        ><label class="field"
          >客户账号<ElInput
            v-model="identifier"
            aria-label="客户账号"
            :placeholder="
              platform === 'whatsapp' ? '手机号，包含国家区号' : 'LINE 账号 ID（不是昵称）'
            "
            :disabled="busy" /></label
        ><label class="field"
          >客户实际网络 IP<ElInput
            v-model="ip"
            aria-label="客户IP"
            placeholder="选填，公网 IPv4 / IPv6"
            :disabled="busy" /></label
        ><label class="field"
          >备注<ElInput
            v-model="note"
            aria-label="底库备注"
            maxlength="200"
            :disabled="busy" /></label
      ></template>
      <template v-else
        ><div class="toolbar" style="margin: 0">
          <ElButton @click="fileInput?.click()" :disabled="busy">选择 CSV / TXT 文件</ElButton
          ><ElButton @click="template">下载模板</ElButton
          ><input
            ref="fileInput"
            type="file"
            accept=".csv,.txt,.tsv"
            hidden
            @change="readFile"
          /><span class="muted">每批最多 1000 行 / 160 KB</span>
        </div>
        <label class="field"
          >一行一个客户<ElInput
            v-model="text"
            type="textarea"
            :rows="8"
            aria-label="批量底库内容"
            placeholder="客户账号,客户IP,备注&#10;447410419512,,已有客户&#10;,203.0.113.10,客户提供的IP"
            :disabled="busy"
          /><small
            >逗号或制表符分列；账号和 IP 至少填写一项。IP 不会从 WhatsApp 聊天页自动获取。</small
          ></label
        ></template
      >
      <template v-if="preview"
        ><ElAlert
          :type="preview.invalid ? 'warning' : 'success'"
          :closable="false"
          :title="`共 ${preview.total} 行：预计新增 ${preview.added}，跳过重复 ${preview.skipped}，无效 ${preview.invalid}`"
        /><ElTable :data="preview.rows" max-height="240"
          ><ElTableColumn prop="line" label="行号" width="60" /><ElTableColumn
            prop="identifier"
            label="客户账号"
            min-width="160"
          /><ElTableColumn prop="ip" label="客户IP" min-width="130" /><ElTableColumn
            label="检查结果"
            min-width="220"
            ><template #default="{ row }"
              ><ElTag :type="row.error ? 'danger' : row.status === '新增' ? 'success' : 'info'">{{
                row.status
              }}</ElTag>
              {{ row.error }}</template
            ></ElTableColumn
          ></ElTable
        >
        <p class="subtitle">
          仅导入有效行；已存在的记录保持原备注与启停状态。录入完成后可到“对话查重记录”重新计算历史结果。
        </p></template
      >
    </div>
    <div v-else class="form-grid">
      <ElAlert
        type="success"
        :closable="false"
        :title="`导入完成：新增 ${result.added}，跳过重复 ${result.skipped}，无效 ${result.invalid}`"
      /><ElButton v-if="result.invalid" @click="errors">下载失败行</ElButton>
      <p class="subtitle">同一团队、同一平台立即使用新底库查重。此前登记的对话可手动重新计算。</p>
    </div>
    <template #footer
      ><ElButton :disabled="busy" @click="visible = false">{{ result ? "完成" : "取消" }}</ElButton
      ><template v-if="!result"
        ><ElButton :loading="busy" :disabled="!content.trim()" @click="check">校验预览</ElButton
        ><ElButton type="primary" :loading="busy" :disabled="!preview?.valid" @click="save"
          >确认{{ preview?.invalid ? "导入有效行" : "导入" }}</ElButton
        ></template
      ></template
    >
  </ElDialog>
</template>
<style scoped>
.baseline-import-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
</style>
