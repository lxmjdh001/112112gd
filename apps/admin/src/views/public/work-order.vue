<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElButton, ElInput } from "element-plus";
import type { OrderStats } from "#/api/work-orders";
import { orderDate, platformLabel } from "#/api/work-orders";
import StatsBoard from "#/components/work-orders/StatsBoard.vue";
const route = useRoute(),
  stats = ref<OrderStats>(),
  password = ref(""),
  needPassword = ref(false),
  error = ref(""),
  loading = ref(false);
const platforms = computed(() => {
  if (!stats.value) return [];
  const names: Record<string, string> = {
    whatsapp: "WhatsApp",
    whatsapp_cloud: "WhatsApp API",
    line: "LINE",
    telegram: "Telegram",
  };
  return stats.value.platforms?.length
    ? stats.value.platforms.map((platform) => names[platform] || platform)
    : [...new Set(stats.value.accounts.map(platformLabel))];
});
let generation = 0;
let controller: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
async function load() {
  if (loading.value) return;
  const version = generation;
  loading.value = true;
  controller = new AbortController();
  try {
    const response = await fetch(
      `/api/v1/public/work-orders/${encodeURIComponent(String(route.params.token))}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password.value }),
        signal: controller.signal,
        credentials: "omit",
      },
    );
    const body = await response.json();
    if (version !== generation) return;
    if (!response.ok) {
      stats.value = undefined;
      needPassword.value = response.status === 403;
      throw Error(body.message || "暂时无法获取统计，请稍后重试");
    }
    stats.value = body.data;
    needPassword.value = false;
    error.value = "";
    document.title = `${stats.value!.name} · D1 工单统计`;
  } catch (e) {
    if (version === generation) error.value = e instanceof Error ? e.message : "加载失败";
  } finally {
    if (version === generation) loading.value = false;
  }
}
watch(
  () => route.params.token,
  () => {
    generation++;
    controller?.abort();
    loading.value = false;
    stats.value = undefined;
    password.value = "";
    needPassword.value = false;
    error.value = "";
    void load();
  },
  { immediate: true },
);
timer = setInterval(() => {
  if (!document.hidden && !needPassword.value) void load();
}, 30000);
onBeforeUnmount(() => {
  generation++;
  controller?.abort();
  clearInterval(timer);
});
</script>
<template>
  <main class="public-order">
    <header class="share-header">
      <div class="header-context">
        <a href="#/home" class="brand" aria-label="D1 Scrm 首页"><b>D1</b> Scrm</a>
        <div class="title-context">
          <span class="section-name">工单统计</span>
          <h1 v-if="stats" class="order-name" :title="stats.name">{{ stats.name }}</h1>
          <div v-if="platforms.length" class="platforms" aria-label="参与平台">
            <span v-for="platform in platforms" :key="platform">{{ platform }}</span>
          </div>
        </div>
      </div>
      <span class="privacy">只读统计看板</span>
    </header>
    <section class="content">
      <div v-if="stats" class="board-toolbar">
        <p class="updated-at">
          更新于 {{ orderDate(stats.updatedAt) }}
          <span class="auto-refresh">每 30 秒自动更新</span>
        </p>
        <ElButton :loading="loading" @click="load">刷新</ElButton>
      </div>
      <div v-if="error" class="error" role="alert">{{ error }}</div>
      <form v-if="needPassword" class="password-box" @submit.prevent="load">
        <h2>此统计链接设有访问密码</h2>
        <ElInput
          v-model="password"
          type="password"
          show-password
          placeholder="请输入访问密码"
          autocomplete="current-password"
        /><ElButton native-type="submit" type="primary" :loading="loading">查看统计</ElButton>
      </form>
      <StatsBoard v-if="stats" :stats="stats" />
      <div v-else-if="!needPassword" class="empty">
        {{ loading ? "正在加载统计…" : "请联系工单创建者确认链接是否有效。"
        }}<ElButton v-if="!loading" @click="load">重新加载</ElButton>
      </div>
    </section>
    <footer>D1 Scrm · 让每一次客户连接都有记录</footer>
  </main>
</template>
<style scoped>
.public-order {
  min-height: 100vh;
  background: linear-gradient(160deg, #f0f5ff 0, #fff 45%, #f8faff 100%);
  color: #203350;
  padding: 0 32px;
  font-family: Inter, system-ui, sans-serif;
}
.share-header {
  min-height: 84px;
  max-width: 1200px;
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e4eaf4;
  gap: 16px;
  padding: 18px 0;
}
.header-context {
  display: flex;
  align-items: center;
  gap: 24px;
  min-width: 0;
}
.title-context {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  min-width: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 21px;
  font-weight: 650;
  color: inherit;
  text-decoration: none;
  white-space: nowrap;
  flex-shrink: 0;
}
.brand b {
  background: #3269e7;
  color: white;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  font-size: 18px;
}
.section-name {
  font-size: 12px;
  font-weight: 400;
  color: #66758d;
  border-left: 1px solid #dce4f2;
  padding-left: 18px;
  white-space: nowrap;
}
.order-name {
  font-size: 14px;
  line-height: 1.6;
  font-weight: 600;
  color: #354966;
  margin: 0;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.platforms {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  color: #66758d;
  font-size: 12px;
  line-height: 1.6;
}
.platforms span {
  white-space: nowrap;
}
.privacy {
  font-size: 12px;
  color: #8392ab;
  flex-shrink: 0;
}
.content {
  max-width: 1200px;
  margin: 24px auto;
  background: #fff;
  padding: 32px;
  border: 1px solid #e8eef7;
  border-radius: 22px;
  box-shadow: 0 14px 55px #2854a008;
}
.board-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.updated-at {
  font-size: 12px;
  line-height: 1.6;
  color: #6d7e97;
  margin: 0;
}
.auto-refresh {
  display: inline-block;
  margin-left: 16px;
  color: #8392ab;
}
.board-toolbar :deep(.el-button) {
  min-height: 40px;
  padding: 0 18px;
}
.brand:focus-visible {
  outline: 2px solid #3269e7;
  outline-offset: 5px;
  border-radius: 5px;
}
.error {
  color: #b65349;
  background: #fff4f2;
  padding: 14px;
  border-radius: 10px;
  margin: 20px 0;
}
.password-box {
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 50px auto;
}
.password-box h2 {
  font-size: 16px;
}
.empty {
  padding: 70px 0;
  text-align: center;
  color: #8795aa;
  display: grid;
  justify-content: center;
  gap: 18px;
}
footer {
  text-align: center;
  font-size: 11px;
  color: #9da9bb;
  padding-bottom: 28px;
}
@media (max-width: 700px) {
  .public-order {
    padding: 0 14px;
  }
  .content {
    padding: 18px;
    margin: 22px auto;
  }
  .header-context {
    flex-wrap: wrap;
    gap: 12px;
  }
  .title-context {
    width: 100%;
    gap: 6px 12px;
  }
  .section-name {
    padding-left: 0;
    border-left: 0;
  }
  .order-name {
    max-width: min(48vw, 240px);
    font-size: 13px;
  }
  .privacy {
    display: none;
  }
  .auto-refresh {
    display: block;
    margin-left: 0;
  }
}
</style>
