<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElInput, ElButton, ElAlert, ElMessage } from "element-plus";
import { api } from "#/api/business";
import { useAuthStore } from "#/store";
const route = useRoute(),
  router = useRouter(),
  auth = useAuthStore(),
  enabled = ref(false),
  loaded = ref(false),
  busy = ref(false);
const form = reactive({
    username: "",
    password: "",
    teamName: "",
    referralCode: typeof route.query.ref === "string" ? route.query.ref : "",
  }),
  confirm = ref("");
onMounted(async () => {
  try {
    enabled.value = (await api.get<{ enabled: boolean }>("/auth/registration")).enabled;
  } finally {
    loaded.value = true;
  }
});
async function submit() {
  if (form.password !== confirm.value) {
    ElMessage.warning("两次密码不一致");
    return;
  }
  busy.value = true;
  try {
    await api.post("/auth/register", form);
    await auth.authLogin({ username: form.username, password: form.password });
    ElMessage.success("账户已创建，100 点体验点数已到账");
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form class="register-form" @submit.prevent="submit">
    <h1>创建管理账户</h1>
    <p>新公司注册即送 100 点，翻译免费。每个实际上线账号每天消耗 1 点。</p>
    <ElAlert
      v-if="loaded && !enabled"
      title="注册暂未开放，请联系平台运营。"
      :closable="false"
    /><template v-if="enabled"
      ><label
        >团队名称<ElInput
          id="register-team"
          v-model="form.teamName"
          maxlength="100"
          required /></label
      ><label
        >登录账号<ElInput
          id="register-username"
          v-model="form.username"
          autocomplete="username"
          minlength="4"
          maxlength="50"
          placeholder="4–50 位字母、数字或 ._-"
          required /></label
      ><label
        >密码<ElInput
          id="register-password"
          v-model="form.password"
          type="password"
          show-password
          autocomplete="new-password"
          minlength="8"
          maxlength="16"
          placeholder="8–16 位"
          required /></label
      ><label
        >确认密码<ElInput
          id="register-confirm"
          v-model="confirm"
          type="password"
          show-password
          autocomplete="new-password"
          required /></label
      ><label
        >推广码（可选）<ElInput
          id="register-referral"
          v-model="form.referralCode"
          maxlength="64"
        /><small>通过推广链接进入时已自动填写，注册成功后不可更改归属。</small></label
      ><ElButton type="primary" native-type="submit" :loading="busy"
        >创建账户并登录</ElButton
      ></template
    ><ElButton link @click="router.push('/auth/login')">已有账户，返回登录</ElButton>
  </form>
</template>
<style scoped>
.register-form {
  display: grid;
  gap: 15px;
  width: 100%;
  max-width: 410px;
  margin: auto;
}
.register-form h1 {
  font-size: 25px;
  font-weight: 650;
}
.register-form p,
.register-form small {
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
.register-form label {
  display: grid;
  gap: 8px;
  font-size: 13px;
}
</style>
