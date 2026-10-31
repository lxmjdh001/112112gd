<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { ElButton, ElInput, ElTable, ElTableColumn, ElTag, ElTooltip, ElAlert } from "element-plus";
import { api, date, accountListStatus, type Account } from "#/api/business";
import "./common.css";
const rows = ref<Account[]>([]);
const query = ref("");
const platformNames: Record<string, string> = {
  whatsapp: "WhatsApp",
  line: "LINE",
  telegram: "Telegram",
};
const now = ref(Date.now()),
  busy = ref(false),
  error = ref(false);
let stopped = false,
  timer: ReturnType<typeof setInterval> | undefined;
async function load() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await api.get<Account[]>("/platform-accounts");
    if (!stopped) {
      rows.value = data;
      error.value = false;
      now.value = Date.now();
    }
  } catch {
    if (!stopped) error.value = true;
  } finally {
    if (!stopped) busy.value = false;
  }
}
function visible() {
  if (!document.hidden) void load();
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    now.value = Date.now();
    if (!document.hidden) void load();
  }, 15000);
  document.addEventListener("visibilitychange", visible);
});
onUnmounted(() => {
  stopped = true;
  clearInterval(timer);
  document.removeEventListener("visibilitychange", visible);
});
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>账号列表</h1>
        <p class="subtitle">
          原生平台账号在客户端添加并登录；业务号码在 WhatsApp API 模块接入，统一展示于此。
        </p>
      </div>
    </div>
    <div class="panel">
      <div class="toolbar">
        <ElTag>全部平台</ElTag
        ><ElInput
          v-model="query"
          placeholder="搜索账号名称 / 登录码名称"
          clearable
          style="width: 270px"
        />
        <div class="grow" />
        <ElButton :loading="busy" @click="load">刷新状态</ElButton>
      </div>
      <ElAlert
        v-if="error"
        title="账号状态同步失败，请刷新重试"
        type="error"
        :closable="false"
        style="margin-bottom: 16px"
      />
      <ElTable
        row-key="id"
        :data="rows.filter((r) => `${r.label}${r.codeLabel}`.includes(query))"
        empty-text="暂无账号，请在客户端点击“添加账号”并登录平台"
        ><ElTableColumn prop="label" label="账号名称" min-width="140" /><ElTableColumn
          prop="codeLabel"
          label="所属登录码"
          min-width="130"
        /><ElTableColumn label="平台" width="120"
          ><template #default="{ row }">{{
            row.connectionType === "cloud"
              ? "WhatsApp API"
              : platformNames[row.platform] || row.platform
          }}</template></ElTableColumn
        ><ElTableColumn label="账号状态" min-width="160"
          ><template #default="{ row }"
            ><ElTooltip :content="accountListStatus(row, now).reason" placement="top">
              <ElTag
                :type="
                  accountListStatus(row, now).kind === 'online'
                    ? 'success'
                    : accountListStatus(row, now).kind === 'error'
                      ? 'danger'
                      : 'info'
                "
                tabindex="0"
                :aria-label="
                  accountListStatus(row, now).label + '，' + accountListStatus(row, now).reason
                "
                >{{ accountListStatus(row, now).label }}</ElTag
              >
            </ElTooltip></template
          ></ElTableColumn
        ><ElTableColumn label="账号网络" min-width="170"
          ><template #default="{ row }">{{
            row.connectionType === "cloud"
              ? "官方 Cloud API"
              : row.networkMode === "system"
                ? "当前电脑网络"
                : `${row.proxyHost}:${row.proxyPort}`
          }}</template></ElTableColumn
        ><ElTableColumn prop="deviceName" label="绑定设备" min-width="130" /><ElTableColumn
          label="最近状态上报"
          min-width="170"
          ><template #default="{ row }">{{ date(row.observedAt) }}</template></ElTableColumn
        ></ElTable
      >
      <p class="subtitle">
        状态每 15 秒自动同步；超过 90
        秒未收到更新时显示“离线”，不会清除登录或账号资料。悬停状态可查看具体原因。
      </p>
    </div>
  </div>
</template>
