<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElButton, ElInput, ElTable, ElTableColumn, ElTag } from "element-plus";
import { api, date } from "#/api/business";
import "./common.css";
interface Log {
  id: number;
  action: string;
  success: boolean;
  ip: string;
  device: string;
  createdAt: string;
}
const rows = ref<Log[]>([]);
const query = ref("");
const names: Record<string, string> = {
  "admin.register": "网站账户注册",
  "account.profile.update": "更新个人资料",
  "account.password.update": "修改网站密码",
  "commerce.settings.update": "更新结算规则",
  "recharge.request": "提交充值申请",
  "recharge.cancel": "取消充值申请",
  "recharge.credit": "确认充值到账",
  "recharge.reject": "拒绝充值申请",
  "recharge.refund": "充值退款冲正",
  "promotion.link.update": "更新推广链接",
  "commission.transfer": "佣金转入余额",
  "withdrawal.request": "申请佣金提现",
  "withdrawal.cancel": "取消提现申请",
  "withdrawal.approve": "通过提现审核",
  "withdrawal.reject": "拒绝提现申请",
  "withdrawal.pay": "确认提现打款",
  "withdrawal.destination.view": "查看提现收款信息",
  "admin.login": "管理员登录",
  "client.login": "客户端登录",
  "client.logout": "客户端退出",
  "code.create": "创建登录码",
  "code.update": "更新登录码",
  "code.reset": "重置登录码",
  "code.move_group": "移动登录码分组",
  "code_group.create": "创建登录码分组",
  "code_group.rename": "重命名登录码分组",
  "code_group.delete": "删除登录码分组",
  "device.unbind": "解绑设备",
  "proxy.import": "批量导入代理",
  "proxy.update": "更新代理设置",
  "proxy_group.create": "创建代理分组",
  "proxy_group.rename": "重命名代理分组",
  "proxy_group.delete": "删除代理分组",
  "account.create": "后台预分配账号（历史）",
  "client.account.create": "客户端添加账号",
};
async function load() {
  rows.value = await api.get("/login-logs");
}
onMounted(load);
</script>
<template>
  <div class="business">
    <div class="page-head">
      <div>
        <h1>登录与操作日志</h1>
        <p class="subtitle">查看本团队最近 200 条登录和关键管理操作。</p>
      </div>
      <ElButton @click="load">刷新</ElButton>
    </div>
    <div class="panel">
      <div class="toolbar">
        <ElInput v-model="query" placeholder="搜索 IP、设备或操作" clearable style="width: 300px" />
      </div>
      <ElTable
        :data="
          rows.filter((r) => `${r.ip}${r.device}${names[r.action] || r.action}`.includes(query))
        "
        empty-text="暂无日志"
        ><ElTableColumn label="操作" width="160"
          ><template #default="{ row }">{{
            names[row.action] || row.action
          }}</template></ElTableColumn
        ><ElTableColumn prop="ip" label="IP 地址" width="150" /><ElTableColumn
          prop="device"
          label="设备 / 浏览器"
          min-width="260"
          show-overflow-tooltip
        /><ElTableColumn label="结果" width="100"
          ><template #default="{ row }"
            ><ElTag :type="row.success ? 'success' : 'danger'">{{
              row.success ? "成功" : "失败"
            }}</ElTag></template
          ></ElTableColumn
        ><ElTableColumn label="时间" width="190"
          ><template #default="{ row }">{{ date(row.createdAt) }}</template></ElTableColumn
        ></ElTable
      >
    </div>
  </div>
</template>
