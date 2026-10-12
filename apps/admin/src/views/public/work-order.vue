<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ElButton, ElInput } from "element-plus";
import type { OrderStats } from "#/api/work-orders";
import { orderDate } from "#/api/work-orders";
import StatsBoard from "#/components/work-orders/StatsBoard.vue";
const route = useRoute(),
  stats = ref<OrderStats>(),
  password = ref(""),
  needPassword = ref(false),
  error = ref(""),
  loading = ref(false);
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
    <header>
      <a href="#/home" class="brand"><b>D1</b> Scrm <span>工单统计</span></a
      ><span class="privacy">只读统计看板</span>
    </header>
    <section class="content">
      <div class="heading">
        <div>
          <p class="eyebrow">ACCOUNT PERFORMANCE</p>
          <h1>{{ stats?.name || "工单统计" }}</h1>
          <p class="subtitle">
            {{
              stats
                ? `更新于 ${orderDate(stats.updatedAt)} · 页面每 30 秒自动更新`
                : "查看各平台账号的客户进线情况"
            }}
          </p>
        </div>
        <ElButton v-if="stats" :loading="loading" @click="load">刷新</ElButton>
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
header {
  height: 84px;
  max-width: 1200px;
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e4eaf4;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 21px;
  font-weight: 650;
  color: inherit;
  text-decoration: none;
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
.brand span {
  font-size: 12px;
  font-weight: 400;
  color: #8b99af;
  border-left: 1px solid #dce4f2;
  padding-left: 12px;
  margin-left: 6px;
}
.privacy {
  font-size: 12px;
  color: #8392ab;
}
.content {
  max-width: 1200px;
  margin: 46px auto;
  background: #fff;
  padding: 32px;
  border: 1px solid #e8eef7;
  border-radius: 22px;
  box-shadow: 0 14px 55px #2854a008;
}
.heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.eyebrow {
  color: #6084ce;
  letter-spacing: 2px;
  font-size: 10px;
  margin-bottom: 12px;
}
h1 {
  font-size: 28px;
  margin: 0;
  font-weight: 650;
}
.subtitle {
  font-size: 12px;
  color: #8a98ae;
  margin-top: 12px;
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
  h1 {
    font-size: 22px;
  }
  .privacy {
    display: none;
  }
  .brand span {
    font-size: 11px;
  }
}
</style>
