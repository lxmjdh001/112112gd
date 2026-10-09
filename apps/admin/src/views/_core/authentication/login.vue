<script setup lang="ts">
import { reactive } from "vue";
import { ElButton, ElInput } from "element-plus";
import { useAuthStore } from "#/store";
const auth = useAuthStore();
const form = reactive({ username: "", password: "" });
</script>
<template>
  <form class="login-form" @submit.prevent="auth.authLogin(form)">
    <h1>登录管理中心</h1>
    <p>管理员登录后，可为员工生成客户端登录码。</p>
    <label for="username">管理员账号</label
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
    ><small>员工请打开客户端，使用管理员分配的长期登录码。</small>
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
  font-size: 26px;
  font-weight: 650;
}
.login-form p {
  color: #7b859b;
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
  color: #929bad;
  font-size: 12px;
  line-height: 1.8;
  margin-top: 8px;
}
.login-form button {
  margin-top: 12px;
}
</style>
