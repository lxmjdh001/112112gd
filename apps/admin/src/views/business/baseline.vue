<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  ElButton,
  ElSelect,
  ElOption,
  ElInput,
  ElTable,
  ElTableColumn,
  ElTag,
  ElPagination,
  ElTabs,
  ElTabPane,
  ElDialog,
  ElAlert,
  ElMessage,
  ElMessageBox,
} from "element-plus";
import { api, date, type Account } from "#/api/business";
import {
  platformNames,
  resultText,
  matchText,
  type Platform,
  type BaselineRow,
  type Conversation,
  type Batch,
  type Match,
} from "#/api/baseline";
import BaselineImport from "./components/baseline-import.vue";
import "./common.css";
const tab = ref("entries"),
  platform = ref(""),
  search = ref(""),
  status = ref(""),
  page = ref(1),
  size = ref(20),
  total = ref(0),
  busy = ref(false),
  loadError = ref(false),
  mutation = ref(false);
const entries = ref<BaselineRow[]>([]),
  conversations = ref<Conversation[]>([]),
  batches = ref<Batch[]>([]),
  accounts = ref<Account[]>([]);
const stats = reactive({
  entries: 0,
  identifiers: 0,
  ips: 0,
  conversations: 0,
  newUsers: 0,
  repeatedUsers: 0,
});
const importer = ref<InstanceType<typeof BaselineImport>>();
const detail = ref<Batch>(),
  detailOpen = ref(false);
const checking = ref(false),
  mode = ref<"check" | "record">("check"),
  customer = reactive({ platform: "whatsapp" as Platform, identifier: "", ip: "", accountId: "" }),
  match = ref<Match>(),
  registered = ref(false);
const options = computed(() => accounts.value.filter((a) => a.platform === customer.platform));
let generation = 0;
async function summary() {
  Object.assign(stats, await api.get("/baselines/summary"));
}
async function load() {
  const current = ++generation;
  busy.value = true;
  loadError.value = false;
  try {
    const query = new URLSearchParams({
      page: String(page.value),
      pageSize: String(size.value),
      platform: platform.value,
      search: search.value,
      enabled: status.value,
      duplicate: status.value,
    });
    const endpoint =
      tab.value === "entries"
        ? "/baselines"
        : tab.value === "conversations"
          ? "/conversations"
          : "/baselines/batches";
    const result = await api.get<{ items: any[]; total: number }>(endpoint + "?" + query);
    if (current !== generation) return;
    if (tab.value === "entries") entries.value = result.items;
    else if (tab.value === "conversations") conversations.value = result.items;
    else batches.value = result.items;
    total.value = result.total;
  } catch {
    if (current === generation) loadError.value = true;
  } finally {
    if (current === generation) busy.value = false;
  }
}
function filter() {
  page.value = 1;
  void load();
}
watch(tab, () => {
  status.value = "";
  search.value = "";
  filter();
});
watch(
  () => customer.platform,
  () => (customer.accountId = ""),
);
watch(
  () => [customer.platform, customer.identifier, customer.ip, customer.accountId],
  () => {
    match.value = undefined;
    registered.value = false;
  },
);
async function refresh() {
  const results = await Promise.allSettled([
    load(),
    summary(),
    api.get<Account[]>("/platform-accounts"),
  ]);
  if (results[2].status === "fulfilled") accounts.value = results[2].value;
}
onMounted(refresh);
async function toggle(row: BaselineRow) {
  if (mutation.value) return;
  try {
    await ElMessageBox.confirm(
      row.enabled
        ? "停用后不再参与后续查重，历史结果需重新计算后更新。"
        : "启用后参与同团队、同平台的查重。",
      row.enabled ? "停用底库记录" : "启用底库记录",
      { type: "warning" },
    );
  } catch {
    return;
  }
  mutation.value = true;
  try {
    await api.request("/baselines/" + row.id, { method: "PATCH", data: { enabled: !row.enabled } });
    await refresh();
  } finally {
    mutation.value = false;
  }
}
async function edit(row: BaselineRow) {
  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt("备注最多 200 字", "编辑底库备注", {
      inputValue: row.note,
      inputValidator: (v) => !v || v.length <= 200 || "备注最多 200 字",
    }));
  } catch {
    return;
  }
  await api.request("/baselines/" + row.id, { method: "PATCH", data: { note: value || "" } });
  await load();
}
function openCheck(record = false) {
  mode.value = record ? "record" : "check";
  customer.identifier = "";
  customer.ip = "";
  customer.accountId = "";
  match.value = undefined;
  registered.value = false;
  checking.value = true;
}
async function check() {
  mutation.value = true;
  try {
    match.value = await api.post<Match>("/baselines/check", customer);
  } finally {
    mutation.value = false;
  }
}
async function record() {
  mutation.value = true;
  try {
    const result = await api.post<{ match: Match; existing: boolean }>("/conversations", customer);
    match.value = result.match;
    registered.value = true;
    ElMessage.success(result.existing ? "该客户与客服的对话已登记，未重复计数" : "对话已登记");
    await refresh();
  } finally {
    mutation.value = false;
  }
}
async function recalculate() {
  if (!platform.value) {
    ElMessage.warning("请先选择需要重新计算的平台");
    return;
  }
  try {
    await ElMessageBox.confirm(
      "按当前启用的底库重新计算该平台全部对话；此前的新用户可能变为重复用户。对话总数保持不变。",
      "重新计算查重结果",
      { type: "warning" },
    );
  } catch {
    return;
  }
  mutation.value = true;
  try {
    const result = await api.post<{ updated: number }>("/conversations/recalculate", {
      platform: platform.value,
    });
    ElMessage.success(`已重新计算 ${result.updated} 条对话`);
    await refresh();
  } finally {
    mutation.value = false;
  }
}
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>底库管理</h1>
        <p class="subtitle">管理客户账号与实际网络 IP，同一团队、同一平台跨客服账号查重。</p>
      </div>
      <div>
        <ElButton @click="openCheck()">客户查重</ElButton
        ><ElButton type="primary" @click="importer?.open(true)">新增客户</ElButton>
      </div>
    </div>
    <div class="stats">
      <div class="stat">
        <span>启用底库记录</span><strong>{{ stats.entries }}</strong
        ><span>{{ stats.identifiers }} 个平台账号 · {{ stats.ips }} 个 IP</span>
      </div>
      <div class="stat">
        <span>已登记对话</span><strong>{{ stats.conversations }}</strong
        ><span>同一客服与客户只计一次</span>
      </div>
      <div class="stat">
        <span>新用户对话</span><strong>{{ stats.newUsers }}</strong
        ><span>未命中底库与在先对话</span>
      </div>
      <div class="stat">
        <span>重复用户对话</span><strong class="repeat-number">{{ stats.repeatedUsers }}</strong
        ><span>账号或 IP 重复</span>
      </div>
    </div>
    <div class="panel">
      <div class="baseline-rule">
        <ElTag type="success">团队内查重</ElTag
        ><span
          >WhatsApp 与 LINE 分开判断；IP 重复只标记命中，不合并客户。WhatsApp 聊天页不提供客户真实
          IP。</span
        >
      </div>
      <ElTabs v-model="tab"
        ><ElTabPane label="底库客户" name="entries" /><ElTabPane
          label="对话查重记录"
          name="conversations" /><ElTabPane label="导入记录" name="batches"
      /></ElTabs>
      <div class="toolbar">
        <ElSelect
          v-model="platform"
          aria-label="筛选平台"
          :empty-values="[null, undefined]"
          style="width: 145px"
          @change="filter"
          ><ElOption label="全部平台" value="" /><ElOption
            v-for="(name, id) in platformNames"
            :key="id"
            :label="name"
            :value="id" /></ElSelect
        ><ElInput
          v-if="tab !== 'batches'"
          v-model="search"
          aria-label="搜索底库"
          placeholder="客户账号 / IP / 备注或客服"
          clearable
          style="width: 250px"
          @keyup.enter="filter"
          @clear="filter"
        /><ElSelect
          v-if="tab !== 'batches'"
          v-model="status"
          aria-label="查重状态筛选"
          :empty-values="[null, undefined]"
          style="width: 135px"
          @change="filter"
          ><ElOption label="全部状态" value="" /><ElOption
            :label="tab === 'entries' ? '启用' : '重复用户'"
            value="true" /><ElOption
            :label="tab === 'entries' ? '停用' : '新用户'"
            value="false" /></ElSelect
        ><ElButton v-if="tab !== 'batches'" @click="filter">搜索</ElButton>
        <div class="grow" />
        <template v-if="tab === 'entries'"
          ><ElButton type="primary" plain @click="importer?.open()">批量导入</ElButton></template
        ><template v-if="tab === 'conversations'"
          ><ElButton :loading="mutation" @click="recalculate">重新计算</ElButton
          ><ElButton type="primary" plain @click="openCheck(true)">登记对话</ElButton></template
        ><ElButton :loading="busy" @click="refresh">刷新</ElButton>
      </div>
      <ElAlert v-if="loadError" type="error" title="数据加载失败，请刷新重试" :closable="false" />
      <ElTable
        v-if="tab === 'entries'"
        v-loading="busy"
        :data="entries"
        empty-text="暂无底库客户，录入或导入后即可参与查重。"
        row-key="id"
        ><ElTableColumn label="平台" width="110"
          ><template #default="{ row }">{{ platformNames[row.platform] }}</template></ElTableColumn
        ><ElTableColumn prop="identifier" label="客户账号" min-width="170"
          ><template #default="{ row }"
            ><span class="code">{{ row.identifier || "—" }}</span></template
          ></ElTableColumn
        ><ElTableColumn prop="ip" label="客户实际 IP" min-width="150"
          ><template #default="{ row }">{{ row.ip || "—" }}</template></ElTableColumn
        ><ElTableColumn prop="accountName" label="来源客服账号" min-width="140"
          ><template #default="{ row }">{{ row.accountName || "未指定" }}</template></ElTableColumn
        ><ElTableColumn
          prop="note"
          label="备注"
          min-width="130"
          show-overflow-tooltip
        /><ElTableColumn label="状态" width="85"
          ><template #default="{ row }"
            ><ElTag :type="row.enabled ? 'success' : 'info'">{{
              row.enabled ? "启用" : "停用"
            }}</ElTag></template
          ></ElTableColumn
        ><ElTableColumn label="录入时间" min-width="165"
          ><template #default="{ row }">{{ date(row.createdAt) }}</template></ElTableColumn
        ><ElTableColumn label="操作" width="135" fixed="right"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="edit(row)">备注</ElButton
            ><ElButton
              link
              :type="row.enabled ? 'danger' : 'primary'"
              :disabled="mutation"
              @click="toggle(row)"
              >{{ row.enabled ? "停用" : "启用" }}</ElButton
            ></template
          ></ElTableColumn
        ></ElTable
      >
      <template v-if="tab === 'conversations'"
        ><p class="subtitle" style="margin: 0 0 15px">
          仅登记实际接待的对话。同一客户联系不同客服会再次查重；打开历史聊天、重试提交不会增加计数。补录底库后，可选择平台重新计算。
        </p>
        <ElTable v-loading="busy" :data="conversations" empty-text="暂无登记对话" row-key="id"
          ><ElTableColumn label="平台" width="100"
            ><template #default="{ row }">{{
              platformNames[row.platform]
            }}</template></ElTableColumn
          ><ElTableColumn prop="identifier" label="客户账号" min-width="170" /><ElTableColumn
            prop="ip"
            label="客户 IP"
            min-width="145"
            ><template #default="{ row }">{{ row.ip || "—" }}</template></ElTableColumn
          ><ElTableColumn prop="accountName" label="客服账号" min-width="130" /><ElTableColumn
            label="查重结果"
            width="115"
            ><template #default="{ row }"
              ><ElTag :type="row.duplicateAccount || row.duplicateIP ? 'warning' : 'success'">{{
                resultText(row)
              }}</ElTag></template
            ></ElTableColumn
          ><ElTableColumn label="命中依据" min-width="170"
            ><template #default="{ row }"
              >{{ matchText(row) }}
              <div class="subtitle">
                {{
                  [row.baselineMatch ? "底库" : "", row.historyMatch ? "在先对话" : ""]
                    .filter(Boolean)
                    .join(" / ")
                }}
              </div></template
            ></ElTableColumn
          ><ElTableColumn label="登记 / 最近计算" min-width="175"
            ><template #default="{ row }"
              >{{ date(row.createdAt) }}
              <div class="subtitle">{{ date(row.checkedAt) }}</div></template
            ></ElTableColumn
          ></ElTable
        ></template
      >
      <ElTable v-if="tab === 'batches'" v-loading="busy" :data="batches" empty-text="暂无导入记录"
        ><ElTableColumn label="平台" width="110"
          ><template #default="{ row }">{{ platformNames[row.platform] }}</template></ElTableColumn
        ><ElTableColumn prop="source" label="导入来源" min-width="150" /><ElTableColumn
          prop="accountName"
          label="来源客服"
          min-width="130"
        /><ElTableColumn prop="total" label="总行数" width="85" /><ElTableColumn
          prop="added"
          label="新增"
          width="80"
        /><ElTableColumn prop="skipped" label="重复跳过" width="95" /><ElTableColumn
          prop="invalid"
          label="无效"
          width="80"
        /><ElTableColumn label="导入时间" min-width="180"
          ><template #default="{ row }">{{ date(row.createdAt) }}</template></ElTableColumn
        ><ElTableColumn label="操作" width="110"
          ><template #default="{ row }"
            ><ElButton
              v-if="row.invalid"
              link
              type="primary"
              @click="
                detail = row;
                detailOpen = true;
              "
              >失败行</ElButton
            ><span v-else class="muted">已完成</span></template
          ></ElTableColumn
        ></ElTable
      >
      <ElPagination
        v-model:current-page="page"
        v-model:page-size="size"
        :total="total"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        style="margin-top: 18px; justify-content: flex-end"
        @current-change="load"
        @size-change="filter"
      />
    </div>
    <BaselineImport ref="importer" :accounts="accounts" @saved="refresh" />
    <ElDialog v-model="detailOpen" title="导入失败行" width="700px"
      ><ElTable :data="detail?.errors" max-height="400"
        ><ElTableColumn prop="line" label="行号" width="65" /><ElTableColumn
          prop="identifier"
          label="客户账号" /><ElTableColumn prop="ip" label="客户IP" /><ElTableColumn
          prop="error"
          label="原因"
          min-width="220" /></ElTable
    ></ElDialog>
    <ElDialog
      v-model="checking"
      :title="mode === 'check' ? '客户查重' : '登记对话'"
      width="540px"
      :close-on-click-modal="false"
      :show-close="!mutation"
      :close-on-press-escape="!mutation"
      ><div class="form-grid">
        <label class="field"
          >平台<ElSelect v-model="customer.platform" aria-label="查重平台" :disabled="mutation"
            ><ElOption
              v-for="(name, id) in platformNames"
              :key="id"
              :value="id"
              :label="name" /></ElSelect></label
        ><label v-if="mode === 'record'" class="field"
          >客服账号<ElSelect
            v-model="customer.accountId"
            aria-label="登记客服账号"
            :disabled="mutation"
            placeholder="选择实际接待的客服账号"
            ><ElOption
              v-for="a in options"
              :key="a.id"
              :value="a.id"
              :label="a.label" /></ElSelect></label
        ><label class="field"
          >客户账号<ElInput
            v-model="customer.identifier"
            aria-label="查重客户账号"
            :disabled="mutation"
            placeholder="WhatsApp 手机号 / LINE 账号 ID" /></label
        ><label class="field"
          >客户实际网络 IP（选填）<ElInput
            v-model="customer.ip"
            aria-label="查重客户IP"
            :disabled="mutation"
            placeholder="公网 IPv4 / IPv6" /></label
        ><ElAlert
          v-if="match"
          :closable="false"
          :type="match.duplicateAccount || match.duplicateIP ? 'warning' : 'success'"
          :title="resultText(match)"
          :description="
            matchText(match) +
            (match.baselineMatch ? ' · 命中底库' : '') +
            (match.historyMatch ? ' · 命中在先对话' : '')
          "
        />
        <p class="subtitle">
          {{
            mode === "check"
              ? "查询不会新增底库或对话，也不会改变计数。"
              : "仅登记已实际接待的对话；同一客服与同一客户重复提交不会重复计数。"
          }}
          LID 与手机号没有可靠对应关系时分别查重。
        </p>
      </div>
      <template #footer
        ><ElButton :disabled="mutation" @click="checking = false">关闭</ElButton
        ><ElButton
          v-if="mode === 'check'"
          type="primary"
          :loading="mutation"
          :disabled="!customer.identifier && !customer.ip"
          @click="check"
          >查重</ElButton
        ><ElButton
          v-else
          type="primary"
          :loading="mutation"
          :disabled="!customer.identifier || !customer.accountId || registered"
          @click="record"
          >登记并查重</ElButton
        ></template
      ></ElDialog
    >
  </div>
</template>
<style scoped>
.baseline-rule {
  display: flex;
  gap: 12px;
  align-items: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.7;
  margin-bottom: 20px;
}
.repeat-number {
  color: var(--el-color-warning);
}
</style>
