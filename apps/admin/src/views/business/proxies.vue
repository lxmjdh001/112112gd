<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  ElButton,
  ElInput,
  ElTable,
  ElTableColumn,
  ElDialog,
  ElSelect,
  ElOption,
  ElMessage,
  ElAlert,
} from "element-plus";
import { api, type ProxyItem } from "#/api/business";
import "./common.css";
const rows = ref<ProxyItem[]>([]);
const query = ref("");
const show = ref(false);
const saving = ref(false);
const form = reactive({ protocol: "socks5", group: "默认分组", lines: "" });
const errors = ref("");
async function load() {
  rows.value = await api.get("/proxies");
}
async function save() {
  saving.value = true;
  errors.value = "";
  try {
    const result = await api.post<{ imported: number; duplicates: number }>(
      "/proxies/import",
      form,
    );
    ElMessage.success(`已导入 ${result.imported} 个代理，跳过 ${result.duplicates} 个重复行`);
    show.value = false;
    form.lines = "";
    await load();
  } catch (e) {
    const err = e as { errors?: { line: number; message: string }[] };
    errors.value =
      err.errors?.map((x) => `第 ${x.line} 行：${x.message}`).join("；") ||
      "导入未完成，请检查格式后重试。";
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
        <h1>代理管理</h1>
        <p class="subtitle">每个账号独立配置网络出口，连接检测由实际运行账号的客户端完成。</p>
      </div>
      <ElButton type="primary" @click="show = true">＋ 添加 / 批量导入</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar">
        <ElInput v-model="query" placeholder="搜索主机或分组" clearable style="width: 270px" />
        <div class="grow" />
        <ElButton @click="load">刷新</ElButton>
      </div>
      <ElTable
        :data="rows.filter((r) => `${r.host}${r.group}`.includes(query))"
        empty-text="添加代理后，可在账号列表中关联"
        ><ElTableColumn prop="protocol" label="协议" width="110" /><ElTableColumn
          prop="host"
          label="主机"
          min-width="180"
        /><ElTableColumn prop="port" label="端口" width="100" /><ElTableColumn
          prop="username"
          label="用户名"
          min-width="140"
        /><ElTableColumn label="密码" width="120"
          ><template #default>••••••••</template></ElTableColumn
        ><ElTableColumn prop="group" label="分组" min-width="130" /><ElTableColumn
          label="网络检测"
          min-width="150"
          ><template #default><span class="muted">打开客户端时检测</span></template></ElTableColumn
        ></ElTable
      >
    </div>
    <ElDialog v-model="show" title="批量添加代理" width="620px" :close-on-click-modal="false"
      ><form class="form-grid" @submit.prevent="save">
        <div class="toolbar">
          <label class="field"
            >默认协议<ElSelect v-model="form.protocol" style="width: 140px"
              ><ElOption label="SOCKS5" value="socks5" /><ElOption
                label="HTTP"
                value="http" /><ElOption label="HTTPS" value="https" /></ElSelect></label
          ><label class="field grow">分组<ElInput v-model="form.group" maxlength="100" /></label>
        </div>
        <label class="field"
          >代理地址 · 每行一个<ElInput
            v-model="form.lines"
            type="textarea"
            :rows="8"
            placeholder="127.0.0.1:1080&#10;host:port:username:password&#10;socks5://username:password@host:port"
          /><small
            >回车换行，保存时自动识别；URL 自带协议优先。每次最多 100
            行，格式有误时整批不保存，重复行自动跳过。密码含 @ 等特殊字符时，完整 URL
            中需进行编码。</small
          ></label
        ><ElAlert v-if="errors" :title="errors" type="error" :closable="false" /><ElButton
          type="primary"
          native-type="submit"
          :disabled="!form.lines.trim()"
          :loading="saving"
          >识别并保存代理</ElButton
        >
      </form></ElDialog
    >
  </div>
</template>
