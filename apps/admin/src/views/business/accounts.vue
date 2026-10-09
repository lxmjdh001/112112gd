<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  ElButton,
  ElInput,
  ElTable,
  ElTableColumn,
  ElTag,
  ElDialog,
  ElSelect,
  ElOption,
  ElMessage,
} from "element-plus";
import {
  api,
  date,
  statusNames,
  type Account,
  type LoginCode,
  type ProxyItem,
} from "#/api/business";
import "./common.css";
const rows = ref<Account[]>([]);
const codes = ref<LoginCode[]>([]);
const proxies = ref<ProxyItem[]>([]);
const show = ref(false);
const query = ref("");
const saving = ref(false);
const form = reactive({ label: "", codeId: "", proxyId: "" });
async function load() {
  rows.value = await api.get("/platform-accounts");
}
async function open() {
  [codes.value, proxies.value] = await Promise.all([
    api.get<LoginCode[]>("/login-codes"),
    api.get<ProxyItem[]>("/proxies"),
  ]);
  show.value = true;
}
async function save() {
  saving.value = true;
  try {
    await api.post("/platform-accounts", form);
    show.value = false;
    form.label = "";
    ElMessage.success("账号位已创建，使用者可在客户端打开并扫码");
    await load();
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
        <h1>账号列表</h1>
        <p class="subtitle">
          为登录码分配独立的 WhatsApp 环境。使用者首次打开时绑定设备，随后在官方页面扫码。
        </p>
      </div>
      <ElButton type="primary" @click="open">＋ 创建账号位</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar">
        <ElTag>WhatsApp</ElTag
        ><ElInput
          v-model="query"
          placeholder="搜索账号名称 / 登录码名称"
          clearable
          style="width: 270px"
        />
        <div class="grow" />
        <ElButton @click="load">刷新状态</ElButton>
      </div>
      <ElTable
        :data="rows.filter((r) => `${r.label}${r.codeLabel}`.includes(query))"
        empty-text="先创建登录码和代理，再添加第一个账号位"
        ><ElTableColumn prop="label" label="账号名称" min-width="140" /><ElTableColumn
          prop="codeLabel"
          label="所属登录码"
          min-width="130"
        /><ElTableColumn label="平台" width="120"
          ><template #default>WhatsApp</template></ElTableColumn
        ><ElTableColumn label="网页状态" min-width="160"
          ><template #default="{ row }"
            ><ElTag
              :type="
                row.status === 'ready'
                  ? 'success'
                  : row.status === 'network_error'
                    ? 'danger'
                    : 'info'
              "
              >{{ statusNames[row.status] || row.status }}</ElTag
            ></template
          ></ElTableColumn
        ><ElTableColumn label="代理出口" min-width="170"
          ><template #default="{ row }"
            >{{ row.proxyHost }}:{{ row.proxyPort }}</template
          ></ElTableColumn
        ><ElTableColumn prop="deviceName" label="绑定设备" min-width="130" /><ElTableColumn
          label="最近状态上报"
          min-width="170"
          ><template #default="{ row }">{{ date(row.observedAt) }}</template></ElTableColumn
        ></ElTable
      >
      <p class="subtitle">
        状态超过 90
        秒未更新会标记为“状态已过期”，不会据此清除登录。当前版尚未采集平台手机号，账号名称由管理员填写。
      </p>
    </div>
    <ElDialog
      v-model="show"
      title="创建 WhatsApp 账号位"
      width="510px"
      :close-on-click-modal="false"
      ><form class="form-grid" @submit.prevent="save">
        <label class="field"
          >账号名称<ElInput
            v-model="form.label"
            placeholder="例如：售前 WhatsApp 01"
            maxlength="100"
            required /></label
        ><label class="field"
          >所属登录码<ElSelect v-model="form.codeId" placeholder="选择登录码"
            ><ElOption
              v-for="c in codes.filter(
                (c) => c.enabled && new Date(c.expiresAt).getTime() > Date.now(),
              )"
              :key="c.id"
              :value="c.id"
              :label="`${c.label}（${c.accountCount}/${c.maxAccounts}）`" /></ElSelect
          ><small v-if="!codes.length">请先到登录码列表创建登录码。</small></label
        ><label class="field"
          >已添加的代理<ElSelect v-model="form.proxyId" placeholder="搜索并选择代理" filterable
            ><ElOption
              v-for="p in proxies"
              :key="p.id"
              :value="p.id"
              :label="`${p.group} · ${p.protocol}://${p.host}:${p.port}`" /></ElSelect
          ><small v-if="!proxies.length">请先到代理管理添加代理。</small></label
        ><ElButton
          type="primary"
          native-type="submit"
          :loading="saving"
          :disabled="!form.label || !form.codeId || !form.proxyId"
          >创建账号位</ElButton
        >
      </form></ElDialog
    >
  </div>
</template>
