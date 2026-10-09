<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { ElTag } from "element-plus";
import "./common.css";
const route = useRoute();
const modules: Record<string, { desc: string; items: string[] }> = {
  "/baseline": {
    desc: "原始联系人将按团队隔离，导入后统一规范化和去重。",
    items: ["联系人导入", "导入记录", "去重规则", "底库统计"],
  },
  "/leads": {
    desc: "线索将关联来源、负责人和跟进状态，与客户库分开管理。",
    items: ["线索列表", "线索分配", "来源追踪", "共享记录"],
  },
  "/customers": {
    desc: "客户资料与运营流程将在基础登录流程验收后接入。聊天归档需先验证官方页面采集能力。",
    items: ["客户列表", "聊天记录", "标签与统计", "跟进记录", "敏感词与行为监控"],
  },
};
const info = computed(() => modules[route.path]);
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>{{ route.meta.title }}</h1>
        <p class="subtitle">{{ info?.desc }}</p>
      </div>
      <ElTag type="info">待开发</ElTag>
    </div>
    <div class="panel">
      <h2 class="section-title">本模块尚未开放</h2>
      <p class="subtitle">当前优先完成登录码 → 客户端 → WhatsApp 登录与翻译流程。</p>
      <div class="toolbar" style="margin-top: 22px">
        <ElTag v-for="item in info?.items" :key="item" type="info" effect="plain">{{ item }}</ElTag>
      </div>
    </div>
  </div>
</template>
