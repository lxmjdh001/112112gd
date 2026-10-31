<script setup lang="ts">
import type { OrderStats } from "#/api/work-orders";
import { orderDate } from "#/api/work-orders";
import { ElTable, ElTableColumn, ElTag } from "element-plus";
defineProps<{ stats: OrderStats }>();
function presence(row: OrderStats["accounts"][number]) {
  if (row.status === "online") return { label: "在线", type: "success" as const };
  if (row.status === "error") return { label: "异常", type: "danger" as const };
  return { label: "离线", type: "info" as const };
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
        <span>累计新增 / 重复</span
        ><strong
          >{{ stats.fresh }} <i>/ {{ stats.duplicate }}</i></strong
        ><small>{{ stats.target ? `目标 ${stats.target} 人` : "同一账号内去重计数" }}</small>
      </article>
    </div>
    <div class="board-table">
      <ElTable :data="stats.accounts" empty-text="暂无参与账号" class="account-stats-table">
        <ElTableColumn label="昵称" min-width="150" show-overflow-tooltip
          ><template #default="{ row }"
            ><span class="account-nickname">{{ row.nickname || row.label || "—" }}</span></template
          ></ElTableColumn
        >
        <ElTableColumn label="账号" min-width="178" show-overflow-tooltip
          ><template #default="{ row }"><span class="account-identity">{{ row.account || "—" }}</span></template></ElTableColumn
        >
        <ElTableColumn prop="todayFresh" label="今日新增" min-width="112" align="right" sortable
          ><template #default="{ row }">{{ row.todayFresh ?? "—" }}</template></ElTableColumn
        >
        <ElTableColumn prop="fresh" label="累积新增" min-width="112" align="right" sortable />
        <ElTableColumn prop="todayDuplicate" label="今日重复" min-width="112" align="right" sortable
          ><template #default="{ row }">{{ row.todayDuplicate ?? "—" }}</template></ElTableColumn
        >
        <ElTableColumn prop="duplicate" label="累积重复" min-width="112" align="right" sortable />
        <ElTableColumn label="状态" min-width="96" align="center"
          ><template #default="{ row }"
            ><ElTag :type="presence(row).type" size="small" effect="light" round class="presence-tag"><span aria-hidden="true" class="presence-dot"></span>{{
              presence(row).label
            }}</ElTag></template
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
.account-stats-table {
  font-variant-numeric: tabular-nums;
}
.account-nickname {
  color: #263750;
  font-weight: 600;
}
.account-identity {
  color: #53647d;
  font-variant-numeric: tabular-nums;
}
.presence-tag {
  gap: 6px;
  padding: 0 10px;
  min-height: 25px;
}
.presence-tag.el-tag--success {
  --el-tag-text-color: #0a7e57;
  --el-tag-bg-color: #edf8f2;
  --el-tag-border-color: #d6ebdf;
}
.presence-tag.el-tag--info {
  --el-tag-text-color: #5f6c82;
  --el-tag-bg-color: #f2f4f8;
  --el-tag-border-color: #e1e6ee;
}
.presence-tag.el-tag--danger {
  --el-tag-text-color: #b83246;
  --el-tag-bg-color: #fff1f3;
  --el-tag-border-color: #f3dce1;
}
.presence-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  background: currentColor;
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
