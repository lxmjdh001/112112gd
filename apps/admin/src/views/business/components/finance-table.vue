<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import {
  ElInput,
  ElSelect,
  ElOption,
  ElButton,
  ElTable,
  ElTableColumn,
  ElPagination,
  ElTag,
} from "element-plus";
import { api } from "#/api/business";
import { financeCell, states, type FinanceColumn, type FinanceRow } from "#/api/commerce";
const props = withDefaults(
  defineProps<{
    endpoint: string;
    columns: FinanceColumn[];
    statuses?: string[];
    emptyText?: string;
    actionWidth?: number;
  }>(),
  { emptyText: "暂无记录", actionWidth: 170 },
);
const rows = ref<FinanceRow[]>([]),
  total = ref(0),
  page = ref(1),
  size = ref(20),
  search = ref(""),
  status = ref(""),
  busy = ref(false),
  error = ref(false);
let generation = 0;
async function load() {
  const current = ++generation;
  busy.value = true;
  error.value = false;
  try {
    const query = new URLSearchParams({
      page: String(page.value),
      pageSize: String(size.value),
      search: search.value.trim(),
      status: status.value,
    });
    const data = await api.get<{ items: FinanceRow[]; total: number }>(
      props.endpoint + (props.endpoint.includes("?") ? "&" : "?") + query,
    );
    if (current === generation) {
      rows.value = data.items;
      total.value = data.total;
    }
  } catch {
    if (current === generation) error.value = true;
  } finally {
    if (current === generation) busy.value = false;
  }
}
function filter() {
  page.value = 1;
  void load();
}
watch(() => props.endpoint, filter);
onMounted(load);
defineExpose({ reload: load });
</script>
<template>
  <div>
    <div class="toolbar">
      <ElInput
        v-model="search"
        aria-label="搜索记录"
        placeholder="搜索名称或单号"
        clearable
        style="width: 260px"
        @keyup.enter="filter"
        @clear="filter"
      /><ElSelect
        v-if="statuses?.length"
        v-model="status"
        :empty-values="[null, undefined]"
        aria-label="记录状态"
        style="width: 130px"
        @change="filter"
        ><ElOption label="全部状态" value="" /><ElOption
          v-for="s in statuses"
          :key="s"
          :label="states[s]"
          :value="s" /></ElSelect
      ><ElButton @click="filter">搜索</ElButton>
      <div class="grow" />
      <slot name="toolbar" /><ElButton :loading="busy" @click="load">刷新记录</ElButton>
    </div>
    <p v-if="error" class="subtitle">记录加载失败，请点击刷新重试。</p>
    <ElTable v-loading="busy" :data="rows" :empty-text="emptyText" row-key="id">
      <ElTableColumn
        v-for="col in columns"
        :key="col.key"
        :label="col.label"
        :width="col.width"
        min-width="110"
        show-overflow-tooltip
        ><template #default="{ row }"
          ><ElTag
            v-if="col.format === 'status'"
            :type="
              ['credited', 'paid'].includes(row[col.key])
                ? 'success'
                : ['rejected', 'refunded', 'reversed'].includes(row[col.key])
                  ? 'danger'
                  : 'info'
            "
            >{{ financeCell(row, col) }}</ElTag
          ><span v-else>{{ financeCell(row, col) }}</span></template
        ></ElTableColumn
      >
      <ElTableColumn v-if="$slots.actions" label="操作" :width="actionWidth" fixed="right"
        ><template #default="{ row }"><slot name="actions" :row="row" /></template
      ></ElTableColumn>
    </ElTable>
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
</template>
