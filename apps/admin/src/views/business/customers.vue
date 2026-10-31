<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  ElAlert,
  ElButton,
  ElDatePicker,
  ElDrawer,
  ElEmpty,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElPagination,
  ElSelect,
  ElSwitch,
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import { date } from "#/api/business";
import {
  teamPlatformName,
  teamSupervision,
  type TeamCustomer,
  type TeamFilters,
  type TeamMessages,
  type TeamOptions,
  type TeamOverview,
  type TeamSettings,
} from "#/api/team-supervision";
import "./common.css";

const route = useRoute();
const filters = reactive<TeamFilters>({
  search: typeof route.query.customer === "string" ? route.query.customer : "",
  platform: "",
  codeId: "",
  startAt: "",
  endAt: "",
  page: 1,
  pageSize: 20,
});
const range = ref<[string, string] | null>(null);
const options = ref<TeamOptions>({ codes: [], platforms: [] }),
  settings = ref<TeamSettings>(),
  overview = ref<TeamOverview>();
const rows = ref<TeamCustomer[]>([]),
  total = ref(0),
  busy = ref(false),
  error = ref(false),
  settingsBusy = ref(false);
const selected = ref<TeamCustomer>(),
  messagePage = ref(1),
  chat = ref<TeamMessages>(),
  chatBusy = ref(false),
  chatError = ref(false);
const messages = computed(() =>
  [...(chat.value?.items || [])].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  ),
);
const kindNames: Record<string, string> = {
  image: "图片",
  video: "视频",
  audio: "语音",
  document: "文件",
  sticker: "表情",
  location: "位置",
  contact: "联系人",
  poll: "投票",
};
let generation = 0,
  chatGeneration = 0,
  active = true;
let pendingOpen =
  typeof route.query.accountId === "string" && typeof route.query.customer === "string"
    ? { accountId: route.query.accountId, customer: route.query.customer }
    : undefined;
async function load() {
  const current = ++generation;
  busy.value = true;
  error.value = false;
  try {
    const [summary, result] = await Promise.all([
      teamSupervision.overview(filters),
      teamSupervision.customers(filters),
    ]);
    if (active && current === generation) {
      overview.value = summary;
      rows.value = result.items;
      total.value = result.total;
      if (pendingOpen) {
        const row = rows.value.find(
          (item) =>
            item.accountId === pendingOpen!.accountId && item.customer === pendingOpen!.customer,
        );
        pendingOpen = undefined;
        if (row) openChat(row);
        else ElMessage.info("未找到这条对话，请调整筛选后重试");
      }
    }
  } catch {
    if (active && current === generation) {
      error.value = true;
      rows.value = [];
      total.value = 0;
      overview.value = undefined;
    }
  } finally {
    if (active && current === generation) busy.value = false;
  }
}
function filter() {
  filters.page = 1;
  filters.startAt = range.value?.[0] || "";
  filters.endAt = range.value?.[1] || "";
  void load();
}
async function loadSetup() {
  try {
    const [o, s] = await Promise.all([teamSupervision.options(), teamSupervision.settings()]);
    if (active) {
      options.value = o;
      settings.value = s;
    }
  } catch {
    /* Refresh retries setup without hiding saved customer records. */
  }
}
async function refresh() {
  await Promise.all([loadSetup(), load()]);
}
async function toggleCollection(value: string | number | boolean) {
  const enabled = value === true;
  try {
    await ElMessageBox.confirm(
      enabled
        ? "开启后，本团队客户端会同步已能读取的私聊记录，团队管理员可查看内容。不会自动发送消息或标记已读。"
        : "关闭后停止后续客户端同步；已经保存的记录仍可查看，不会删除。",
      enabled ? "开启团队聊天同步" : "关闭团队聊天同步",
      {
        confirmButtonText: enabled ? "确认开启" : "确认关闭",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  settingsBusy.value = true;
  try {
    settings.value = await teamSupervision.updateSettings(enabled);
    ElMessage.success(enabled ? "团队聊天同步已开启" : "团队聊天同步已关闭");
  } finally {
    settingsBusy.value = false;
  }
}
function openChat(row: TeamCustomer) {
  if (!row.accountId) return;
  selected.value = row;
  messagePage.value = 1;
  chat.value = undefined;
  void loadMessages();
}
function closeChat() {
  selected.value = undefined;
  chatGeneration++;
  chatBusy.value = false;
  chat.value = undefined;
}
async function loadMessages() {
  const target = selected.value;
  if (!target) return;
  const current = ++chatGeneration;
  chatBusy.value = true;
  chatError.value = false;
  try {
    const result = await teamSupervision.messages(
      target.accountId,
      target.customer,
      messagePage.value,
    );
    if (active && current === chatGeneration) chat.value = result;
  } catch {
    if (active && current === chatGeneration) {
      chatError.value = true;
      chat.value = undefined;
    }
  } finally {
    if (active && current === chatGeneration) chatBusy.value = false;
  }
}
const scopeDescription = computed(() => {
  if (chat.value?.historyScope === "cloud_retained")
    return "展示系统已保存的 API 消息，不代表平台的全部历史。";
  if (chat.value?.historyScope === "unavailable")
    return "这个账号暂未提供可查看的聊天内容。请确认同步已开启，并使用支持同步的新客户端。";
  return "仅展示已同步记录；更早记录需由客户端继续同步，不代表完整历史。";
});
watch(
  () => [route.path, route.query.accountId, route.query.customer],
  ([path, accountId, customer]) => {
    if (path !== "/customers" || typeof accountId !== "string" || typeof customer !== "string")
      return;
    filters.search = customer;
    filters.page = 1;
    pendingOpen = { accountId, customer };
    void load();
  },
);
onMounted(refresh);
onUnmounted(() => {
  active = false;
  generation++;
  chatGeneration++;
});
</script>
<template>
  <div class="business team-customers">
    <div class="page-head">
      <div>
        <h1>客户运营</h1>
        <p class="subtitle">查看本团队客户、业务员跟进情况和已同步的聊天记录。</p>
      </div>
      <ElButton :loading="busy" @click="refresh">刷新客户数据</ElButton>
    </div>
    <div class="team-summary" aria-label="当前筛选范围统计">
      <div>
        <span>客户记录</span><strong>{{ overview?.customers ?? "—" }}</strong
        ><small>当前筛选范围</small>
      </div>
      <div>
        <span>新增接待</span><strong>{{ overview?.newCustomers ?? "—" }}</strong
        ><small>首次收到客户消息</small>
      </div>
      <div>
        <span>接收消息</span><strong>{{ overview?.inbound ?? "—" }}</strong
        ><small>已归档记录</small>
      </div>
      <div>
        <span>发送消息</span><strong>{{ overview?.outbound ?? "—" }}</strong
        ><small>已归档记录</small>
      </div>
    </div>
    <div class="team-sync panel">
      <div>
        <b>团队聊天同步</b>
        <p class="subtitle">
          开启后，本团队管理员可查看客户端同步的私聊内容。关闭不会删除已有记录。
        </p>
      </div>
      <ElSwitch
        v-if="settings"
        :model-value="settings.enabled"
        :loading="settingsBusy"
        aria-label="团队聊天同步"
        active-text="已开启"
        inactive-text="未开启"
        @change="toggleCollection"
      />
      <ElButton v-else link type="primary" @click="loadSetup">重新获取同步设置</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar team-filters">
        <ElInput
          v-model="filters.search"
          aria-label="搜索团队客户"
          placeholder="客户、账号或业务员"
          clearable
          maxlength="100"
          @keyup.enter="filter"
          @clear="filter"
        />
        <ElSelect
          v-model="filters.codeId"
          aria-label="客户业务员"
          :empty-values="[null, undefined]"
          @change="filter"
          ><ElOption label="全部业务员" value="" /><ElOption
            v-for="item in options.codes"
            :key="item.id"
            :label="item.label"
            :value="item.id"
        /></ElSelect>
        <ElSelect
          v-model="filters.platform"
          aria-label="客户平台"
          :empty-values="[null, undefined]"
          @change="filter"
          ><ElOption label="全部平台" value="" /><ElOption
            v-for="item in options.platforms"
            :key="item.id"
            :label="item.name"
            :value="item.id"
        /></ElSelect>
        <ElDatePicker
          v-model="range"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          aria-label="对话日期范围"
          @change="filter"
        />
        <ElButton type="primary" @click="filter">查询客户</ElButton>
      </div>
      <ElAlert
        v-if="error"
        title="客户数据加载失败，请点击刷新客户数据重试"
        type="error"
        :closable="false"
        class="team-alert"
      />
      <ElTable
        v-loading="busy"
        :data="rows"
        row-key="id"
        empty-text="暂无客户记录。客户端同步对话或保存客户资料后，记录会显示在这里。"
      >
        <ElTableColumn label="客户" min-width="190"
          ><template #default="{ row }"
            ><b>{{ row.name || row.customer }}</b
            ><small v-if="row.name" class="cell-secondary">{{ row.customer }}</small></template
          ></ElTableColumn
        >
        <ElTableColumn label="业务员 / 登录码" min-width="160"
          ><template #default="{ row }"
            >{{ row.codeLabel || "未关联业务员"
            }}<small class="cell-secondary">{{ row.accountLabel || "未关联账号" }}</small></template
          ></ElTableColumn
        >
        <ElTableColumn label="平台" min-width="110"
          ><template #default="{ row }">{{
            teamPlatformName(row.platform)
          }}</template></ElTableColumn
        >
        <ElTableColumn label="首次对话" min-width="175"
          ><template #default="{ row }">{{ date(row.firstAt) }}</template></ElTableColumn
        >
        <ElTableColumn label="最近对话" min-width="175"
          ><template #default="{ row }">{{ date(row.lastAt) }}</template></ElTableColumn
        >
        <ElTableColumn label="接收 / 发送" min-width="120"
          ><template #default="{ row }"
            >{{ row.inbound }} / {{ row.outbound }}</template
          ></ElTableColumn
        >
        <ElTableColumn label="操作" width="115" fixed="right"
          ><template #default="{ row }"
            ><ElButton v-if="row.accountId" link type="primary" @click="openChat(row)"
              >查看聊天</ElButton
            ><span v-else class="cell-secondary">暂无对话</span></template
          ></ElTableColumn
        >
      </ElTable>
      <div class="team-pagination">
        <ElPagination
          v-model:current-page="filters.page"
          v-model:page-size="filters.pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="filter"
        />
      </div>
      <p class="subtitle team-footnote">
        按登录码区分业务员，同码多设备合并统计；共享 API
        号码不重复计数。按账号与客户去重，消息数量以已归档记录为准；日期按北京时间统计。
      </p>
    </div>
    <ElDrawer
      :model-value="!!selected"
      title="聊天记录"
      size="min(720px, 100vw)"
      class="team-chat-drawer"
      @close="closeChat"
    >
      <div v-if="selected" class="team-chat-content">
        <div class="chat-customer">
          <div>
            <h2>{{ selected.name || selected.customer }}</h2>
            <p>{{ selected.customer }}</p>
          </div>
          <ElTag type="info">只读</ElTag>
        </div>
        <div class="chat-context">
          <span>{{ teamPlatformName(selected.platform) }}</span
          ><span>{{ selected.codeLabel || "未关联业务员" }}</span
          ><span>{{ selected.accountLabel }}</span>
        </div>
        <ElAlert :title="scopeDescription" type="info" :closable="false" class="team-alert" />
        <p v-if="chat?.lastSyncAt" class="chat-sync-time">最近同步：{{ date(chat.lastSyncAt) }}</p>
        <p v-if="chat?.collectorReady === false" class="chat-sync-time">
          当前账号尚未完成同步初始化，已保存的记录仍可查看。
        </p>
        <p v-if="chat?.limited" class="chat-sync-time">
          本次同步范围有限，更早或更多记录需由客户端继续同步。
        </p>
        <div class="chat-actions">
          <span>当前批次按时间排列</span
          ><ElButton :loading="chatBusy" @click="loadMessages">刷新聊天记录</ElButton>
        </div>
        <ElAlert
          v-if="chatError"
          title="聊天记录加载失败，请点击刷新聊天记录重试"
          type="error"
          :closable="false"
          class="team-alert"
        />
        <div v-loading="chatBusy" class="chat-history" aria-label="已同步聊天内容">
          <ElEmpty
            v-if="!chatBusy && !chatError && !messages.length"
            description="暂未同步到聊天内容。请确认客户端在线并开启团队聊天同步。"
          />
          <article
            v-for="message in messages"
            :key="message.id"
            class="chat-message"
            :class="{ outbound: message.direction === 'out' }"
          >
            <div class="message-meta">
              <b>{{
                message.direction === "out"
                  ? selected.codeLabel || "业务员"
                  : selected.name || selected.customer
              }}</b
              ><time :datetime="message.at">{{ date(message.at) }}</time>
            </div>
            <div class="message-bubble">
              <span v-if="kindNames[message.kind]" class="message-kind"
                >[{{ kindNames[message.kind] }}]</span
              >
              <p v-if="message.body">{{ message.body }}</p>
              <p v-else-if="!kindNames[message.kind]" class="message-kind">非文本消息</p>
              <small v-if="message.truncated" class="message-limit">内容较长，仅同步部分文字</small>
            </div>
          </article>
        </div>
        <div v-if="chat?.total" class="team-pagination chat-pagination">
          <ElPagination
            v-model:current-page="messagePage"
            :page-size="50"
            :total="chat.total"
            layout="total, prev, pager, next"
            @current-change="loadMessages"
          />
        </div>
        <p class="chat-footer">仅供本团队管理员查看。打开记录不会代业务员发送消息或标记已读。</p>
      </div>
    </ElDrawer>
  </div>
</template>
<style scoped>
.team-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-bottom: 24px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  overflow: hidden;
}
.team-summary > div {
  padding: 22px 24px;
  min-width: 0;
}
.team-summary > div + div {
  border-left: 1px solid var(--el-border-color-lighter);
}
.team-summary span,
.team-summary small {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.team-summary strong {
  display: block;
  font-size: 29px;
  line-height: 1.3;
  margin: 10px 0;
  color: var(--el-text-color-primary);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.team-sync {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.team-sync b {
  font-weight: 600;
}
.team-sync :deep(.el-switch) {
  flex: none;
}
.team-filters > .el-input {
  width: 230px;
}
.team-filters > .el-select {
  width: 160px;
}
.team-filters :deep(.el-date-editor) {
  max-width: 280px;
  min-width: 220px;
  flex: none;
}
.cell-secondary {
  display: block;
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.team-alert {
  margin-bottom: 16px;
}
.team-pagination {
  overflow-x: auto;
  padding-top: 18px;
  display: flex;
  justify-content: flex-end;
}
.team-footnote {
  margin-top: 18px;
}
.team-chat-content {
  min-width: 0;
}
.chat-customer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.chat-customer h2 {
  font-size: 20px;
  font-weight: 650;
  margin: 0;
  overflow-wrap: anywhere;
}
.chat-customer p {
  color: var(--el-text-color-secondary);
  margin: 6px 0 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.chat-context {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 15px 0 18px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.chat-sync-time {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.7;
  margin: 6px 0 12px;
}
.chat-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 20px 0 8px;
}
.chat-history {
  min-height: 180px;
  padding: 12px 0;
}
.chat-message {
  max-width: 88%;
  margin: 0 auto 22px 0;
}
.chat-message.outbound {
  margin-left: auto;
  margin-right: 0;
}
.message-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 5px 10px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-bottom: 7px;
}
.message-meta b {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.outbound .message-meta {
  justify-content: flex-end;
}
.message-bubble {
  border: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
  padding: 12px 15px;
  border-radius: 10px;
  color: var(--el-text-color-primary);
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
}
.outbound .message-bubble {
  background: hsl(var(--primary) / 6%);
  border-color: hsl(var(--primary) / 15%);
}
.message-bubble p {
  white-space: pre-wrap;
  margin: 0;
  overflow-wrap: anywhere;
}
.message-kind {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.message-limit {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin-top: 8px;
}
.chat-footer {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.8;
  margin: 22px 0 0;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 16px;
}
@media (max-width: 740px) {
  .team-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .team-summary > div {
    padding: 16px;
  }
  .team-summary > div:nth-child(3) {
    border-left: 0;
  }
  .team-summary > div:nth-child(n + 3) {
    border-top: 1px solid var(--el-border-color-lighter);
  }
  .team-summary strong {
    font-size: 25px;
  }
  .team-sync {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
  .team-filters > .el-input,
  .team-filters > .el-select {
    width: 100%;
  }
  .team-filters :deep(.el-date-editor) {
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }
  .team-pagination {
    justify-content: flex-start;
  }
  .chat-message {
    max-width: 96%;
  }
  .chat-actions {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
}
</style>
