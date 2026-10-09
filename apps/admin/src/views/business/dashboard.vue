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
        <h1>团队控制台</h1>
        <p class="subtitle">统一管理工作账号，让员工在熟悉的官方界面中开始工作。</p>
      </div>
      <ElButton type="primary" @click="router.push('/login-codes')">创建登录码</ElButton>
    </div>
    <ElAlert v-if="error" title="统计加载失败，请刷新重试" type="error" :closable="false" />
    <div class="stats">
      <div
        v-for="item in [
          { key: 'codes', label: '有效登录码' },
          { key: 'devices', label: '活跃客户端' },
          { key: 'accounts', label: '平台账号位' },
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
          <h3>创建员工登录码</h3>
          <p class="subtitle">设置有效期、设备数与平台账号额度。员工无需账号密码。</p>
          <ElButton link type="primary" @click="router.push('/login-codes')">管理登录码 →</ElButton>
        </div>
        <div class="step">
          <b>02</b>
          <h3>分配代理与账号</h3>
          <p class="subtitle">批量导入代理，再为登录码创建 WhatsApp 账号位。</p>
          <ElButton link type="primary" @click="router.push('/platform-accounts')"
            >配置账号 →</ElButton
          >
        </div>
        <div class="step">
          <b>03</b>
          <h3>客户端扫码工作</h3>
          <p class="subtitle">用登录码进入客户端，打开 WhatsApp 官方页面，手机扫码关联。</p>
          <span class="subtitle">聊天区支持 Google 免费翻译</span>
        </div>
      </div>
    </div>
    <div class="panel">
      <h2 class="section-title">当前版本 · 基础工作流</h2>
      <p class="subtitle">
        已接入登录码、设备、代理、账号位和操作日志。推广、账户账务、底库、线索及客户运营按后续阶段开放。
      </p>
      <p class="subtitle">
        账号位是供员工登录的平台环境；当前版本不采集 WhatsApp
        手机号或聊天记录。网页就绪状态不等同于消息已送达。
      </p>
    </div>
  </div>
</template>
