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
    </div>
    <ElAlert v-if="error" title="统计加载失败，请刷新重试" type="error" :closable="false" />
    <div class="stats">
      <div
        v-for="item in [
          { key: 'codes', label: '有效登录码' },
          { key: 'devices', label: '活跃客户端' },
          { key: 'accounts', label: '平台账号' },
          { key: 'proxies', label: '代理资源' },
        ]"
        :key="item.key"
        class="stat"
      >
        <span>{{ item.label }}</span
        ><strong>{{ stats ? stats[item.key as keyof typeof stats] : "—" }}</strong
        ><span>{{ item.key === "devices" ? "最近 90 秒内心跳" : "当前团队" }}</span>
      </div>
    </div>
    <div class="panel">
      <h2 class="section-title">开始使用</h2>
      <div class="steps">
        <div class="step">
          <b>01</b>
          <h3>创建登录码</h3>
          <p class="subtitle">勾选可用平台并设置有效期。使用者无需账号密码。</p>
          <ElButton link type="primary" @click="router.push('/login-codes')">管理登录码 →</ElButton>
        </div>
        <div class="step">
          <b>02</b>
          <h3>准备代理</h3>
          <p class="subtitle">在后台导入代理，使用者添加账号时在客户端选择。</p>
          <ElButton link type="primary" @click="router.push('/proxies')">管理代理 →</ElButton>
        </div>
        <div class="step">
          <b>03</b>
          <h3>客户端扫码工作</h3>
          <p class="subtitle">
            用登录码进入客户端，添加账号并选择代理，再在 WhatsApp 官方页面扫码登录。
          </p>
          <span class="subtitle">聊天区支持 Google 免费翻译</span>
        </div>
      </div>
    </div>
    <div class="panel">
      <h2 class="section-title">当前版本 · 基础工作流</h2>
      <p class="subtitle">
        已接入登录码、设备、代理、客户端账号、账户账务、推广返佣、底库查重与操作日志。线索及客户运营按后续阶段开放。
      </p>
      <p class="subtitle">
        账号由客户端添加并同步到后台。当前版本不采集 WhatsApp
        手机号或聊天记录，网页就绪状态不等同于消息已送达。
      </p>
    </div>
  </div>
</template>
