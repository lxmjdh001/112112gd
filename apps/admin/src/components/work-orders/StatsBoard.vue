<script setup lang="ts">
import type { OrderStats } from "#/api/work-orders";
import { orderDate, platformLabel } from "#/api/work-orders";
import { ElTable, ElTableColumn, ElTag } from "element-plus";
defineProps<{ stats: OrderStats }>();
function syncLabel(row: OrderStats["accounts"][number]) {
  if (row.removed) return "已移除 · 历史保留";
  if (!row.collectorReady) return "等待同步";
  if (row.connectionType === "cloud") return "API 回调已配置";
  if (!row.lastSync || Date.now() - Date.parse(row.lastSync) > 120000) return "客户端离线";
  return "同步中";
}
</script>
<template>
  <section class="order-board">
    <div class="metrics">
      <article>
        <span>今日进线</span><strong>{{ stats.today }}</strong
        ><small>北京时间统计</small>
      </article>
      <article>
        <span>昨日进线</span><strong>{{ stats.yesterday }}</strong
        ><small>与今天相同统计口径</small>
      </article>
      <article>
        <span>累计进线</span><strong>{{ stats.total }}</strong
        ><small>工单统计期间</small>
      </article>
      <article>
        <span>有效新客 / 重复</span
        ><strong
          >{{ stats.fresh }} <i>/ {{ stats.duplicate }}</i></strong
        ><small>{{ stats.target ? `目标 ${stats.target} 人` : "同一账号内去重计数" }}</small>
      </article>
    </div>
    <div class="board-table">
      <ElTable :data="stats.accounts" empty-text="暂无参与账号">
        <ElTableColumn label="平台账号" min-width="190"
          ><template #default="{ row }"
            ><b>{{ row.label }}</b>
            <div class="muted">{{ platformLabel(row) }}</div></template
          ></ElTableColumn
        >
        <ElTableColumn prop="today" label="今日" min-width="80" sortable />
        <ElTableColumn prop="yesterday" label="昨日" min-width="80" sortable />
        <ElTableColumn prop="total" label="累计" min-width="80" sortable />
        <ElTableColumn prop="fresh" label="新客" min-width="80" />
        <ElTableColumn prop="duplicate" label="重复" min-width="80" />
        <ElTableColumn label="数据状态" min-width="165"
          ><template #default="{ row }"
            ><ElTag :type="row.collectorReady && !row.removed ? 'success' : 'info'" size="small">{{
              syncLabel(row)
            }}</ElTag>
            <div class="muted">{{ orderDate(row.lastSync) }}</div></template
          ></ElTableColumn
        >
      </ElTable>
    </div>
    <div class="rules">
      <p>
        统计期间：{{ orderDate(stats.startAt) }} 至
        {{ stats.endAt ? orderDate(stats.endAt) : "持续统计" }} · 每日
        {{ String(Math.floor(stats.resetMinutes / 60)).padStart(2, "0") }}:{{
          String(stats.resetMinutes % 60).padStart(2, "0")
        }}（北京时间）划分日期
      </p>
      <p>
        工单期间，同一客户向同一账号首次发来消息计 1
        人，后续消息不重复计入；同一客户进入多个账号时分别计数，后进入的账号标记重复。群聊不计入。
      </p>
      <p>
        原生账号由新版客户端同步实际消息；离线期间需恢复同步后才更新。仅统计已同步的数据，历史消息未完整同步时不能视作完整历史。移除账号后保留已上报统计。
      </p>
    </div>
  </section>
</template>
<style scoped>
.order-board {
  color: #263750;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin: 18px 0 24px;
}
.metrics article {
  background: #f5f8ff;
  border: 1px solid #e4ebf8;
  border-radius: 16px;
  padding: 22px;
}
.metrics span,
.metrics small {
  display: block;
  color: #72829c;
  font-size: 12px;
}
.metrics strong {
  display: block;
  font-size: 34px;
  line-height: 1.5;
  color: #245de1;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.metrics i {
  font-style: normal;
  color: #9aaccc;
  font-size: 22px;
}
.board-table {
  border: 1px solid #e6ebf3;
  border-radius: 14px;
  overflow: hidden;
  padding: 8px 14px;
}
.muted {
  font-size: 11px;
  color: #8593a7;
  margin-top: 5px;
}
.rules {
  color: #8894a6;
  font-size: 12px;
  line-height: 1.9;
  margin-top: 18px;
}
.rules p {
  margin: 5px 0;
}
@media (max-width: 700px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .metrics article {
    padding: 14px;
  }
  .metrics strong {
    font-size: 28px;
  }
  .board-table {
    padding: 4px;
  }
}
</style>
