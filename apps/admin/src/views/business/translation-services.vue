<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { ElAlert, ElButton, ElOption, ElSelect, ElTable, ElTableColumn, ElTag } from "element-plus";
import { api, date } from "#/api/business";
import type { FinanceColumn } from "#/api/commerce";
import FinanceTable from "./components/finance-table.vue";
import "./common.css";

interface Provider {
  id: string;
  name: string;
  role: string;
  endpoint: string;
  status: string;
  message: string;
  checkedAt: string | null;
  nextCheckAt: string | null;
  latencyMs: number;
  requests: number;
  inputChars: number;
  outputChars: number;
  lastUsedAt: string | null;
}
const rows = ref<Provider[]>([]),
  loading = ref(false),
  error = ref(false);
const period = ref("24h"),
  provider = ref(""),
  channel = ref("");
const checking = ref<string[]>([]),
  checkingAll = ref(false),
  now = ref(Date.now());
const history = ref<InstanceType<typeof FinanceTable>>();
let generation = 0,
  timer: ReturnType<typeof setInterval> | undefined;
const totals = computed(() =>
  rows.value.reduce(
    (all, row) => ({
      requests: all.requests + row.requests,
      input: all.input + row.inputChars,
      output: all.output + row.outputChars,
      backup: all.backup + (row.id === "google-free" ? 0 : row.requests),
    }),
    { requests: 0, input: 0, output: 0, backup: 0 },
  ),
);
const usageEndpoint = computed(
  () =>
    "/translation/usage?" +
    new URLSearchParams({ period: period.value, provider: provider.value, channel: channel.value }),
);
const statusLabels: Record<string, string> = {
  unknown: "未检测",
  checking: "检测中",
  available: "可用",
  limited: "限流中",
  quota: "额度用完",
  timeout: "超时",
  unavailable: "不可用",
  stale: "待重新检测",
  interrupted: "检测未完成",
};
const languageNames: Record<string, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  en: "英语",
  es: "西班牙语",
  pt: "葡萄牙语",
  ar: "阿拉伯语",
  ru: "俄语",
  fr: "法语",
  de: "德语",
  ja: "日语",
  ko: "韩语",
  vi: "越南语",
  th: "泰语",
  id: "印尼语",
  hi: "印地语",
};
const columns: FinanceColumn[] = [
  { key: "createdAt", label: "时间", format: "date", width: 180 },
  { key: "accountName", label: "账号", width: 170 },
  { key: "providerName", label: "翻译接口", width: 145 },
  { key: "channel", label: "使用位置", width: 135 },
  { key: "targetLanguage", label: "目标语言", formatter: (v) => languageNames[v] || v },
  { key: "inputChars", label: "输入字符", formatter: (v) => Number(v).toLocaleString() },
  { key: "outputChars", label: "输出字符", formatter: (v) => Number(v).toLocaleString() },
];
function status(row: Provider) {
  if (checking.value.includes(row.id)) return "checking";
  if (row.checkedAt && now.value - new Date(row.checkedAt).getTime() > 15 * 60_000) return "stale";
  return row.status;
}
function tagType(row: Provider) {
  const value = status(row);
  if (value === "available") return "success";
  if (["timeout", "unavailable"].includes(value)) return "danger";
  if (["limited", "quota"].includes(value)) return "warning";
  return "info";
}
const remaining = (row: Provider) =>
  row.nextCheckAt
    ? Math.max(0, Math.ceil((new Date(row.nextCheckAt).getTime() - now.value) / 1000))
    : 0;
const canCheck = (row: Provider) => !checking.value.includes(row.id) && remaining(row) === 0;
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = false;
  try {
    const data = await api.get<{ items: Provider[] }>(
      "/translation/providers?period=" + period.value,
    );
    if (current === generation) rows.value = data.items;
  } catch {
    if (current === generation) error.value = true;
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function checkOne(row: Provider, reload = true) {
  if (!canCheck(row)) return;
  checking.value = [...checking.value, row.id];
  try {
    await api.post(`/translation/providers/${row.id}/check`, {});
  } catch {
    /* The shared request client displays the API error. */
  } finally {
    checking.value = checking.value.filter((id) => id !== row.id);
    if (reload) await load();
  }
}
async function checkAll() {
  if (checkingAll.value) return;
  checkingAll.value = true;
  try {
    await Promise.all(rows.value.filter(canCheck).map((row) => checkOne(row, false)));
  } finally {
    checkingAll.value = false;
    await load();
  }
}
async function refresh() {
  await Promise.all([load(), history.value?.reload()]);
}
function startTimer() {
  if (!timer)
    timer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
}
function stopTimer() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
watch(period, load);
onMounted(() => {
  void load();
  startTimer();
});
onActivated(startTimer);
onDeactivated(stopTimer);
onBeforeUnmount(() => {
  generation++;
  stopTimer();
});
</script>

<template>
  <div class="business translation-services">
    <div class="page-head">
      <div>
        <h1>翻译接口</h1>
        <p class="subtitle">查看接口连通性与当前团队的翻译使用情况。</p>
      </div>
      <div class="head-actions">
        <ElButton :loading="loading" @click="refresh">刷新数据</ElButton>
        <ElButton
          type="primary"
          :loading="checkingAll"
          :disabled="!rows.some(canCheck) || checking.length > 0"
          @click="checkAll"
          >检测全部</ElButton
        >
      </div>
    </div>
    <div class="toolbar">
      <span>统计时间</span>
      <ElSelect v-model="period" aria-label="统计时间" style="width: 160px">
        <ElOption label="近 24 小时" value="24h" /><ElOption label="近 7 天" value="7d" /><ElOption
          label="近 30 天"
          value="30d"
        /><ElOption label="全部时间" value="all" />
      </ElSelect>
      <span class="muted">Google 主用 · MyMemory 备用 1 · LibreTranslate 备用 2</span>
    </div>
    <ElAlert
      v-if="error"
      title="接口数据加载失败，请刷新重试。"
      type="error"
      :closable="false"
      class="load-error"
    />
    <div class="stats" v-loading="loading">
      <div class="stat">
        <span>成功翻译次数</span
        ><strong>{{ rows.length ? totals.requests.toLocaleString() : "—" }}</strong
        ><span>已记录的成功翻译，不含缓存与检测</span>
      </div>
      <div class="stat">
        <span>输入字符</span><strong>{{ rows.length ? totals.input.toLocaleString() : "—" }}</strong
        ><span>所选时间内累计输入</span>
      </div>
      <div class="stat">
        <span>输出字符</span
        ><strong>{{ rows.length ? totals.output.toLocaleString() : "—" }}</strong
        ><span>所选时间内累计译文</span>
      </div>
      <div class="stat">
        <span>备用接口完成次数</span
        ><strong>{{ rows.length ? totals.backup.toLocaleString() : "—" }}</strong
        ><span>MyMemory 与 LibreTranslate 合计</span>
      </div>
    </div>
    <section class="panel">
      <h2 class="section-title">接口状态与使用汇总</h2>
      <p class="subtitle section-note">
        状态来自服务器的独立连通性检测，有效期 15
        分钟；客户端实际连通性还取决于电脑网络或账号代理。每个接口每分钟可检测一次。
      </p>
      <ElTable v-loading="loading" :data="rows" row-key="id" empty-text="暂无接口数据">
        <ElTableColumn label="翻译接口" min-width="220"
          ><template #default="{ row }">
            <div class="provider-title">
              <strong>{{ row.name }}</strong
              ><ElTag size="small" :type="row.id === 'google-free' ? 'primary' : 'info'">{{
                row.role
              }}</ElTag>
            </div>
            <div class="muted endpoint">{{ row.endpoint }}</div>
            <small class="muted">免费 · 自动切换</small>
          </template></ElTableColumn
        >
        <ElTableColumn label="服务器检测" min-width="200"
          ><template #default="{ row }">
            <ElTag :type="tagType(row)">{{ statusLabels[status(row)] }}</ElTag>
            <p class="check-message">
              {{ status(row) === "stale" ? "检测结果已过期，请重新检测" : row.message }}
            </p>
            <small class="muted">{{ date(row.checkedAt) }}</small>
          </template></ElTableColumn
        >
        <ElTableColumn label="检测耗时" width="105"
          ><template #default="{ row }">{{
            row.checkedAt ? `${row.latencyMs.toLocaleString()} ms` : "—"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="成功次数" width="100" align="right"
          ><template #default="{ row }">{{
            row.requests.toLocaleString()
          }}</template></ElTableColumn
        >
        <ElTableColumn label="翻译字符" min-width="145"
          ><template #default="{ row }"
            ><div>输入 {{ row.inputChars.toLocaleString() }}</div>
            <small class="muted">输出 {{ row.outputChars.toLocaleString() }}</small></template
          ></ElTableColumn
        >
        <ElTableColumn label="最近使用" width="175"
          ><template #default="{ row }">{{ date(row.lastUsedAt) }}</template></ElTableColumn
        >
        <ElTableColumn label="操作" width="100" fixed="right"
          ><template #default="{ row }">
            <ElButton
              type="primary"
              link
              :loading="checking.includes(row.id)"
              :disabled="!canCheck(row)"
              :aria-label="`检测 ${row.name}`"
              @click="checkOne(row)"
              >{{
                checking.includes(row.id)
                  ? "检测中"
                  : remaining(row)
                    ? `${remaining(row)} 秒后`
                    : "检测"
              }}</ElButton
            >
          </template></ElTableColumn
        >
      </ElTable>
    </section>
    <section class="panel">
      <h2 class="section-title">使用明细</h2>
      <p class="subtitle section-note">
        记录成功翻译的字符数，不保存原文和译文。未成功上报的客户端用量不计入；免费接口不提供统一剩余额度。
      </p>
      <div class="toolbar">
        <ElSelect
          v-model="provider"
          aria-label="筛选翻译接口"
          :empty-values="[null, undefined]"
          style="width: 200px"
          ><ElOption label="全部接口" value="" /><ElOption
            v-for="row in rows"
            :key="row.id"
            :label="row.name"
            :value="row.id"
        /></ElSelect>
        <ElSelect
          v-model="channel"
          aria-label="筛选使用位置"
          :empty-values="[null, undefined]"
          style="width: 180px"
          ><ElOption label="全部使用位置" value="" /><ElOption
            label="客户端"
            value="web" /><ElOption label="WhatsApp API" value="cloud"
        /></ElSelect>
      </div>
      <FinanceTable
        ref="history"
        :endpoint="usageEndpoint"
        :columns="columns"
        empty-text="所选条件下暂无翻译记录"
        search-placeholder="搜索账号名称"
      />
    </section>
  </div>
</template>

<style scoped>
.head-actions,
.provider-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.provider-title {
  margin-bottom: 4px;
}
.endpoint {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.section-note {
  margin: -8px 0 18px;
}
.check-message {
  font-size: 12px;
  margin: 6px 0 2px;
}
.load-error {
  margin-bottom: 18px;
}
.translation-services .stat strong {
  font-size: 28px;
}
@media (max-width: 700px) {
  .page-head {
    flex-direction: column;
  }
  .head-actions {
    flex-wrap: wrap;
  }
}
</style>
