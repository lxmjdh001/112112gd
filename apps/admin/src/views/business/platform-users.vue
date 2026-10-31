<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  ElButton,
  ElInput,
  ElSelect,
  ElOption,
  ElTable,
  ElTableColumn,
  ElPagination,
  ElTag,
  ElDialog,
  ElMessage,
  ElMessageBox,
  ElDescriptions,
  ElDescriptionsItem,
  ElAlert,
} from "element-plus";
import { api, date } from "#/api/business";
import "./common.css";
interface User {
  id: string;
  username: string;
  displayName: string;
  contact: string;
  teamName: string;
  tenantId: string;
  isOperator: boolean;
  disabled: boolean;
  balance: string;
  codeCount: number;
  accountCount: number;
  lastLoginAt: string | null;
}
const rows = ref<User[]>([]),
  total = ref(0),
  page = ref(1),
  size = ref(20),
  search = ref(""),
  role = ref(""),
  status = ref(""),
  busy = ref(false),
  error = ref(false),
  selected = ref<User>(),
  resetUser = ref<User>(),
  password = ref(""),
  confirm = ref(""),
  saving = ref(false);
let generation = 0;
async function load() {
  const g = ++generation;
  busy.value = true;
  error.value = false;
  try {
    const q = new URLSearchParams({
      search: search.value.trim(),
      role: role.value,
      status: status.value,
      page: String(page.value),
      pageSize: String(size.value),
    });
    const r = await api.get<{ items: User[]; total: number }>("/operations/users?" + q);
    if (g === generation) {
      rows.value = r.items;
      total.value = r.total;
    }
  } catch {
    if (g === generation) error.value = true;
  } finally {
    if (g === generation) busy.value = false;
  }
}
function filter() {
  page.value = 1;
  void load();
}
async function toggle(user: User) {
  try {
    await ElMessageBox.confirm(
      user.disabled
        ? "恢复后该用户可使用原密码登录后台。"
        : "停用后该用户无法登录后台，当前网页会话立即退出；团队数据与客户端登录码不受影响。",
      `${user.disabled ? "启用" : "停用"}用户 ${user.username}`,
      {
        type: "warning",
        confirmButtonText: user.disabled ? "确认启用" : "确认停用",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }
  saving.value = true;
  try {
    await api.request(`/operations/users/${user.id}/status`, {
      method: "PATCH",
      data: { enabled: user.disabled },
    });
    ElMessage.success(user.disabled ? "用户已启用" : "用户已停用");
    await load();
  } finally {
    saving.value = false;
  }
}
function openReset(user: User) {
  resetUser.value = user;
  password.value = "";
  confirm.value = "";
}
async function reset() {
  if (!resetUser.value) return;
  if (password.value !== confirm.value) {
    ElMessage.error("两次输入的密码不一致");
    return;
  }
  if ([...password.value].length < 8 || [...password.value].length > 16) {
    ElMessage.error("密码须为 8–16 位");
    return;
  }
  saving.value = true;
  try {
    await api.post(`/operations/users/${resetUser.value.id}/password`, {
      password: password.value,
    });
    resetUser.value = undefined;
    password.value = "";
    confirm.value = "";
    ElMessage.success("密码已重置，该用户需重新登录");
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>用户管理</h1>
        <p class="subtitle">查看公司账户与使用情况，管理客户的后台登录权限。</p>
      </div>
      <ElButton :loading="busy" @click="load">刷新用户</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar">
        <ElInput
          v-model="search"
          aria-label="搜索用户"
          placeholder="账号、团队、姓名或联系方式"
          clearable
          maxlength="100"
          style="width: 280px"
          @keyup.enter="filter"
          @clear="filter"
        />
        <ElSelect
          v-model="role"
          aria-label="用户身份"
          :empty-values="[null, undefined]"
          style="width: 150px"
          @change="filter"
          ><ElOption label="全部身份" value="" /><ElOption
            label="平台管理员"
            value="operator" /><ElOption label="客户账号" value="customer"
        /></ElSelect>
        <ElSelect
          v-model="status"
          aria-label="用户状态"
          :empty-values="[null, undefined]"
          style="width: 140px"
          @change="filter"
          ><ElOption label="全部状态" value="" /><ElOption
            label="已启用"
            value="enabled" /><ElOption label="已停用" value="disabled" /></ElSelect
        ><ElButton type="primary" @click="filter">搜索</ElButton>
      </div>
      <ElAlert
        v-if="error"
        title="用户列表加载失败，请点击刷新用户重试"
        type="error"
        :closable="false"
      />
      <ElTable v-loading="busy" :data="rows" row-key="id" empty-text="没有符合条件的用户">
        <ElTableColumn label="账号" prop="username" min-width="150" /><ElTableColumn
          label="公司 / 团队"
          prop="teamName"
          min-width="180"
        />
        <ElTableColumn label="身份" width="120"
          ><template #default="{ row }"
            ><ElTag :type="row.isOperator ? 'primary' : 'info'">{{
              row.isOperator ? "平台管理员" : "客户账号"
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="后台登录" width="110"
          ><template #default="{ row }"
            ><ElTag :type="row.disabled ? 'danger' : 'success'">{{
              row.disabled ? "已停用" : "已启用"
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="团队点数" min-width="110"
          ><template #default="{ row }">{{ row.balance }} 点</template></ElTableColumn
        >
        <ElTableColumn label="登录码" prop="codeCount" width="90" /><ElTableColumn
          label="平台账号"
          prop="accountCount"
          width="100"
        />
        <ElTableColumn label="操作" width="235" fixed="right"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="selected = row">详情</ElButton
            ><template v-if="!row.isOperator"
              ><ElButton link type="primary" @click="openReset(row)">重置密码</ElButton
              ><ElButton
                link
                :type="row.disabled ? 'primary' : 'danger'"
                :disabled="saving"
                @click="toggle(row)"
                >{{ row.disabled ? "启用" : "停用" }}</ElButton
              ></template
            ><span v-else class="subtitle" style="margin-left: 8px">管理员受保护</span></template
          ></ElTableColumn
        >
      </ElTable>
      <div class="toolbar" style="justify-content: flex-end; margin-top: 20px">
        <ElPagination
          v-model:current-page="page"
          v-model:page-size="size"
          :page-sizes="[20, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="filter"
        />
      </div>
      <p class="subtitle">点数、登录码和平台账号按团队统计。同团队的多个用户共享这些数据。</p>
    </div>
    <ElDialog :model-value="!!selected" title="用户详情" width="600px" @close="selected = undefined"
      ><ElDescriptions v-if="selected" :column="1" border
        ><ElDescriptionsItem label="账号">{{ selected.username }}</ElDescriptionsItem
        ><ElDescriptionsItem label="姓名">{{ selected.displayName || "未填写" }}</ElDescriptionsItem
        ><ElDescriptionsItem label="公司 / 团队">{{ selected.teamName }}</ElDescriptionsItem
        ><ElDescriptionsItem label="联系方式">{{ selected.contact || "未填写" }}</ElDescriptionsItem
        ><ElDescriptionsItem label="最近登录">{{
          selected.lastLoginAt ? date(selected.lastLoginAt) : "暂无记录"
        }}</ElDescriptionsItem
        ><ElDescriptionsItem label="团队点数"
          >{{ selected.balance }} 点</ElDescriptionsItem
        ></ElDescriptions
      ></ElDialog
    >
    <ElDialog
      :model-value="!!resetUser"
      title="重置用户密码"
      width="480px"
      :close-on-click-modal="false"
      @close="
        resetUser = undefined;
        password = '';
        confirm = '';
      "
    >
      <form class="form-grid" @submit.prevent="reset">
        <p class="subtitle">
          为 {{ resetUser?.username }} 设置新密码。原网页会话将退出，客户端登录码不受影响。
        </p>
        <label class="field"
          >新密码<ElInput
            v-model="password"
            aria-label="重置新密码"
            type="password"
            show-password
            autocomplete="new-password"
            minlength="8"
            maxlength="16"
            required /></label
        ><label class="field"
          >确认新密码<ElInput
            v-model="confirm"
            aria-label="重置确认密码"
            type="password"
            show-password
            autocomplete="new-password"
            minlength="8"
            maxlength="16"
            required
        /></label>
        <div class="toolbar">
          <ElButton @click="resetUser = undefined">取消</ElButton
          ><ElButton type="primary" native-type="submit" :loading="saving">确认重置密码</ElButton>
        </div>
      </form>
    </ElDialog>
  </div>
</template>
