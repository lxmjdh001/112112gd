<script setup lang="ts">
import { ref } from "vue";
import {
  ElButton,
  ElDialog,
  ElInput,
  ElTable,
  ElTableColumn,
  ElMessage,
  ElMessageBox,
} from "element-plus";
import { api, type LoginCodeGroup } from "#/api/business";

const open = defineModel<boolean>({ required: true });
defineProps<{ groups: LoginCodeGroup[] }>();
const emit = defineEmits<{ changed: []; created: [group: LoginCodeGroup] }>();
const name = ref("");
const busy = ref(false);
const validName = (value: string) => {
  const trimmed = value.trim();
  return (
    (trimmed.length > 0 &&
      [...trimmed].length <= 50 &&
      !["未分组", "全部分组"].includes(trimmed)) ||
    "请输入 1–50 个字符，不能使用“未分组”或“全部分组”"
  );
};
async function create() {
  const validation = validName(name.value);
  if (validation !== true) {
    ElMessage.warning(validation);
    return;
  }
  busy.value = true;
  try {
    const group = await api.post<LoginCodeGroup>("/login-code-groups", { name: name.value.trim() });
    name.value = "";
    emit("created", group);
    emit("changed");
    ElMessage.success("分组已创建");
  } finally {
    busy.value = false;
  }
}
async function rename(group: LoginCodeGroup) {
  const result = await ElMessageBox.prompt("请输入新的分组名称", "重命名分组", {
    inputValue: group.name,
    inputValidator: validName,
    confirmButtonText: "保存",
    cancelButtonText: "取消",
    closeOnClickModal: false,
  }).catch(() => null);
  if (!result) return;
  busy.value = true;
  try {
    await api.request(`/login-code-groups/${group.id}`, {
      method: "PATCH",
      data: { name: result.value.trim() },
    });
    emit("changed");
    ElMessage.success("分组名称已更新");
  } finally {
    busy.value = false;
  }
}
async function remove(group: LoginCodeGroup) {
  const confirmed = await ElMessageBox.confirm(
    `删除“${group.name}”后，组内登录码会归入“未分组”，登录码和客户端登录状态不受影响。`,
    "删除分组",
    { type: "warning", confirmButtonText: "删除分组", cancelButtonText: "取消" },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  busy.value = true;
  try {
    await api.delete(`/login-code-groups/${group.id}`);
    emit("changed");
    ElMessage.success("分组已删除，登录码已归入未分组");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ElDialog
    v-model="open"
    title="管理分组"
    width="560px"
    :close-on-click-modal="false"
    @closed="name = ''"
  >
    <form class="new-group" @submit.prevent="create">
      <ElInput
        v-model="name"
        aria-label="分组名称"
        placeholder="分组名称，例如：投放一组"
        maxlength="50"
        :disabled="busy"
      />
      <ElButton native-type="submit" type="primary" :loading="busy">新建分组</ElButton>
    </form>
    <ElTable :data="groups" empty-text="暂无分组，创建后可分类管理登录码" max-height="320">
      <ElTableColumn prop="name" label="分组名称" min-width="160" show-overflow-tooltip />
      <ElTableColumn prop="codeCount" label="登录码数" width="95" />
      <ElTableColumn label="操作" width="145">
        <template #default="{ row }">
          <ElButton link type="primary" :disabled="busy" @click="rename(row)">重命名</ElButton>
          <ElButton link type="danger" :disabled="busy" @click="remove(row)">删除</ElButton>
        </template>
      </ElTableColumn>
    </ElTable>
    <template #footer><ElButton @click="open = false">完成</ElButton></template>
  </ElDialog>
</template>

<style scoped>
.new-group {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}
</style>
