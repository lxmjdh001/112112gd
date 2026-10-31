<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElButton, ElAlert } from "element-plus";
import { api } from "#/api/business";
import "./common.css";
const stats = ref<{ codes: number; devices: number; accounts: number; proxies: number }>();
const error = ref(false);
const router = useRouter();
onMounted(async () => {
  try {
    stats.value = await api.get("/dashboard");
  } catch {
    error.value = true;
  }
});
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>工作台</h1>
        <p class="subtitle">统一管理工作账号，让使用者在熟悉的官方界面中开始工作。</p>
      </div>
      <ElButton type="primary" @click="router.push('/login-codes')">管理登录码</ElButton>
    </div>
    <ElAlert v-if="error" title="统计加载失败，请刷新重试" type="error" :closable="false" />
    <div class="stats dashboard-stats">
      <div
        v-for="item in [
          {
            key: 'codes',
            label: '有效登录码',
            icon: 'M15 7a4 4 0 1 1-3.5 6L5 19H2v-3l6-6A4 4 0 0 1 15 7Z',
          },
          { key: 'devices', label: '活跃客户端', icon: 'M4 3h16v12H4zM8 21h8m-4-6v6' },
          {
            key: 'accounts',
            label: '平台账号',
            icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M13 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
          },
          {
            key: 'proxies',
            label: '代理资源',
            icon: 'M9 3h6v6H9zM3 15h6v6H3zm12 0h6v6h-6zM12 9v3M6 15v-3h12v3',
          },
        ]"
        :key="item.key"
        class="stat"
      >
        <div class="stat-heading">
          <span>{{ item.label }}</span
          ><svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="item.icon" />
          </svg>
        </div>
        <strong>{{ stats ? stats[item.key as keyof typeof stats] : "—" }}</strong
        ><span>{{ item.key === "devices" ? "最近 90 秒内心跳" : "当前团队" }}</span>
      </div>
    </div>
    <div class="panel dashboard-flow">
      <h2 class="section-title">开始使用</h2>
      <div class="steps">
        <div class="step">
          <b>01</b>
          <h3>创建登录码</h3>
          <p class="subtitle">勾选可用平台并设置有效期。使用者无需账号密码。</p>
          <ElButton link type="primary" @click="router.push('/login-codes')">管理登录码</ElButton>
        </div>
        <div class="step">
          <b>02</b>
          <h3>准备代理</h3>
          <p class="subtitle">在后台导入代理，使用者添加账号时在客户端选择。</p>
          <ElButton link type="primary" @click="router.push('/proxies')">管理代理</ElButton>
        </div>
        <div class="step">
          <b>03</b>
          <h3>客户端扫码工作</h3>
          <p class="subtitle">用登录码进入客户端，添加账号并选择代理，再在 WhatsApp 扫码登录。</p>
          <span class="subtitle">聊天区支持收发自动翻译</span>
        </div>
      </div>
    </div>
    <div class="panel dashboard-note">
      <h2 class="section-title">当前版本 · 基础工作流</h2>
      <p class="subtitle">
        已接入登录码、设备、代理、客户端账号、账户账务、推广返佣、底库查重与操作日志。线索及客户运营按后续阶段开放。
      </p>
      <p class="subtitle">
        账号由客户端添加并同步到后台。当前版本不采集 WhatsApp
        手机号或聊天记录，账号在线状态不代表消息已送达。
      </p>
    </div>
  </div>
</template>
