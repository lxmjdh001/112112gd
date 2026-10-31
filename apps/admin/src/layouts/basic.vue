<script setup lang="ts">
import { BasicLayout, UserDropdown } from "@vben/layouts";
import { useUserStore } from "@vben/stores";
import { useAuthStore } from "#/store";
const user = useUserStore();
const auth = useAuthStore();
</script>
<template>
  <BasicLayout class="d1-admin-layout" @clear-preferences-and-logout="auth.logout(false)"
    ><template #user-dropdown
      ><UserDropdown
        avatar="/logo.svg"
        :menus="[]"
        :text="user.userInfo?.realName"
        description="团队管理中心"
        tag-text="管理员"
        @logout="auth.logout(false)"
        @clear-preferences-and-logout="auth.logout(false)" /></template
  ></BasicLayout>
</template>
