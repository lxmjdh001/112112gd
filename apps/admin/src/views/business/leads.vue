<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import {
  ElAlert,
  ElButton,
  ElDatePicker,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElPagination,
  ElSelect,
  ElSwitch,
  ElTable,
  ElTableColumn,
} from "element-plus";
import { date } from "#/api/business";
import {
  teamPlatformName,
  teamSupervision,
  type TeamCustomer,
  type TeamFilters,
  type TeamOptions,
  type TeamOverview,
  type TeamSettings,
} from "#/api/team-supervision";
import "./common.css";

const router = useRouter();
const filters = reactive<TeamFilters>({
  search: "",
  platform: "",
  codeId: "",
  startAt: "",
  endAt: "",
  page: 1,
  pageSize: 20,
});
const range = ref<[string, string] | null>(null);
const options = ref<TeamOptions>({ codes: [], platforms: [] });
const settings = ref<TeamSettings>();
const overview = ref<TeamOverview>();
const rows = ref<TeamCustomer[]>([]),
  total = ref(0),
  busy = ref(false),
  error = ref(false),
  settingsBusy = ref(false);
let generation = 0;
let active = true;
async function load() {
  const current = ++generation;
  busy.value = true;
  error.value = false;
  try {
    const [summary, result] = await Promise.all([
      teamSupervision.overview({ ...filters, scope: "leads" }),
      teamSupervision.leads(filters),
    ]);
    if (active && current === generation) {
      overview.value = summary;
      rows.value = result.items;
      total.value = result.total;
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
    /* The list keeps its own retry state; setup can be retried with refresh. */
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
onMounted(refresh);
onUnmounted(() => {
  active = false;
  generation++;
});
</script>
<template>
  <div class="business team-leads">
    <div class="page-head">
      <div>
        <h1>新增接待</h1>
        <p class="subtitle">按业务员和平台账号查看首次建立对话的客户，仅展示本团队数据。</p>
      </div>
      <ElButton :loading="busy" @click="refresh">刷新接待数据</ElButton>
    </div>
    <div class="team-summary" aria-label="当前筛选范围统计">
      <div>
        <span>新增接待</span><strong>{{ overview?.newCustomers ?? "—" }}</strong
        ><small>首次收到客户消息</small>
      </div>
      <div>
        <span>客户记录</span><strong>{{ overview?.customers ?? "—" }}</strong
        ><small>当前筛选范围</small>
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
        <p class="subtitle">同步本团队客户端已能读取的记录。开启后需使用支持同步的新客户端。</p>
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
          aria-label="搜索接待记录"
          placeholder="客户、账号或业务员"
          clearable
          maxlength="100"
          @keyup.enter="filter"
          @clear="filter"
        />
        <ElSelect
          v-model="filters.codeId"
          aria-label="接待业务员"
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
          aria-label="接待平台"
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
          aria-label="接待日期范围"
          @change="filter"
        />
        <ElButton type="primary" @click="filter">查询接待</ElButton>
      </div>
      <ElAlert
        v-if="error"
        title="接待数据加载失败，请点击刷新接待数据重试"
        type="error"
        :closable="false"
        class="team-alert"
      />
      <ElTable
        v-loading="busy"
        :data="rows"
        row-key="id"
        empty-text="暂无新增接待。客户端同步后会自动显示；仅发送消息、尚未收到回复的客户不计入新增接待。"
      >
        <ElTableColumn label="业务员 / 登录码" min-width="155"
          ><template #default="{ row }"
            ><b>{{ row.codeLabel || "未关联业务员" }}</b
            ><small class="cell-secondary">{{ row.accountLabel || "未关联账号" }}</small></template
          ></ElTableColumn
        >
        <ElTableColumn label="客户" min-width="185"
          ><template #default="{ row }"
            ><span>{{ row.name || row.customer }}</span
            ><small v-if="row.name" class="cell-secondary">{{ row.customer }}</small></template
          ></ElTableColumn
        >
        <ElTableColumn label="平台" min-width="115"
          ><template #default="{ row }">{{
            teamPlatformName(row.platform)
          }}</template></ElTableColumn
        >
        <ElTableColumn label="首次接待" min-width="175"
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
        <ElTableColumn label="操作" width="110" fixed="right"
          ><template #default="{ row }"
            ><ElButton
              link
              type="primary"
              @click="
                router.push({
                  path: '/customers',
                  query: { accountId: row.accountId, customer: row.customer },
                })
              "
              >查看对话</ElButton
            ></template
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
        号码不重复计数。按账号与客户去重，每个账号首次收到该客户消息计一次。消息数量以已归档记录为准；历史同步可能补入更早记录，日期按北京时间统计。
      </p>
    </div>
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
}
</style>
