<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElButton, ElInput } from "element-plus";
import { useAuthStore } from "#/store";
import { useRouter } from "vue-router";
import { api } from "#/api/business";
const router = useRouter(),
  registrationEnabled = ref(false);
onMounted(async () => {
  try {
    registrationEnabled.value = (await api.get<{ enabled: boolean }>("/auth/registration")).enabled;
  } catch {}
});
const auth = useAuthStore();
const form = reactive({ username: "", password: "" });
</script>
<template>
  <form class="login-form" @submit.prevent="auth.authLogin(form)">
    <h1>登录管理中心</h1>
    <p>管理员登录后，可生成客户端登录码。</p>
    <label for="username">登录账号</label
    ><ElInput
      id="username"
      v-model="form.username"
      autocomplete="username"
      size="large"
      placeholder="请输入账号"
      required
    /><label for="password">密码</label
    ><ElInput
      id="password"
      v-model="form.password"
      type="password"
      autocomplete="current-password"
      show-password
      size="large"
      placeholder="请输入密码"
      required
    /><ElButton native-type="submit" type="primary" size="large" :loading="auth.loginLoading"
      >登录</ElButton
    ><small>请在客户端使用管理员分配的长期登录码。</small
    ><ElButton v-if="registrationEnabled" link @click="router.push('/auth/register')"
      >创建管理账户</ElButton
    >
  </form>
</template>
<style scoped>
.login-form {
  display: grid;
  gap: 14px;
  width: 100%;
  max-width: 390px;
  margin: auto;
}
.login-form h1 {
  font-size: 24px;
  font-weight: 650;
}
.login-form p {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.7;
  margin-bottom: 14px;
}
.login-form label {
  font-size: 13px;
  font-weight: 600;
  margin-top: 6px;
}
.login-form small {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.8;
  margin-top: 8px;
}
.login-form button {
  margin-top: 12px;
}
</style>
