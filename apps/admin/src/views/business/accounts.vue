<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElButton, ElInput, ElTable, ElTableColumn, ElTag } from "element-plus";
import { api, date, statusNames, type Account } from "#/api/business";
import "./common.css";
const rows = ref<Account[]>([]);
const query = ref("");
async function load() {
  rows.value = await api.get("/platform-accounts");
}
onMounted(load);
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>账号列表</h1>
        <p class="subtitle">原生平台账号在客户端添加并登录；业务号码在 WhatsApp API 模块接入，统一展示于此。</p>
      </div>
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
        empty-text="暂无账号，请在客户端点击“添加账号”并登录 WhatsApp"
        ><ElTableColumn prop="label" label="账号名称" min-width="140" /><ElTableColumn
          prop="codeLabel"
          label="所属登录码"
          min-width="130"
        /><ElTableColumn label="平台" width="120"
          ><template #default="{ row }">{{
            row.connectionType === "cloud" ? "WhatsApp API" : "WhatsApp"
          }}</template></ElTableColumn
        ><ElTableColumn label="账号状态" min-width="160"
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
          ><template #default="{ row }">{{
            row.connectionType === "cloud" ? "官方 Cloud API" : `${row.proxyHost}:${row.proxyPort}`
          }}</template></ElTableColumn
        ><ElTableColumn prop="deviceName" label="绑定设备" min-width="130" /><ElTableColumn
          label="最近状态上报"
          min-width="170"
          ><template #default="{ row }">{{ date(row.observedAt) }}</template></ElTableColumn
        ></ElTable
      >
      <p class="subtitle">
        状态超过 90
        秒未更新会标记为“状态已过期”，不会据此清除登录。账号名称为客户端填写的备注；等待扫码与聊天页面就绪会分别显示。
      </p>
    </div>
  </div>
</template>
