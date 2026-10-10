import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    name: "Dashboard",
    path: "/dashboard",
    component: () => import("#/views/business/dashboard.vue"),
    meta: {
      title: "工作台",
      icon: "lucide:layout-dashboard",
      order: 0,
      authority: ["admin"],
      affixTab: true,
    },
  },
  {
    name: "LoginCodes",
    path: "/login-codes",
    component: () => import("#/views/business/login-codes.vue"),
    meta: { title: "登录码列表", icon: "lucide:key-round", order: 1, authority: ["admin"] },
  },
  {
    name: "Accounts",
    path: "/platform-accounts",
    component: () => import("#/views/business/accounts.vue"),
    meta: { title: "账号列表", icon: "lucide:monitor-smartphone", order: 2, authority: ["admin"] },
  },
  {
    name: "WhatsAppCloud",
    path: "/whatsapp-api",
    component: () => import("#/views/business/whatsapp-cloud.vue"),
    meta: {
      title: "WhatsApp API",
      icon: "lucide:messages-square",
      order: 2.5,
      authority: ["admin"],
    },
  },
  {
    name: "Proxies",
    path: "/proxies",
    component: () => import("#/views/business/proxies.vue"),
    meta: { title: "代理管理", icon: "lucide:network", order: 3, authority: ["admin"] },
  },
  {
    name: "Promotion",
    path: "/promotion",
    component: () => import("#/views/business/promotion.vue"),
    meta: { title: "推广中心", icon: "lucide:megaphone", order: 4, authority: ["admin"] },
  },
  {
    name: "AccountCenter",
    path: "/account-center",
    component: () => import("#/views/business/account-center.vue"),
    meta: { title: "账户中心", icon: "lucide:circle-user-round", order: 5, authority: ["admin"] },
  },
  {
    name: "Baseline",
    path: "/baseline",
    component: () => import("#/views/business/baseline.vue"),
    meta: { title: "底库管理", icon: "lucide:database", order: 6, authority: ["admin"] },
  },
  {
    name: "Leads",
    path: "/leads",
    component: () => import("#/views/business/planned.vue"),
    meta: { title: "线索列表", icon: "lucide:list-filter", order: 7, authority: ["admin"] },
  },
  {
    name: "Customers",
    path: "/customers",
    component: () => import("#/views/business/planned.vue"),
    meta: { title: "客户运营", icon: "lucide:users", order: 8, authority: ["admin"] },
  },
  {
    name: "LoginLogs",
    path: "/login-logs",
    component: () => import("#/views/business/logs.vue"),
    meta: { title: "登录日志", icon: "lucide:history", order: 9, authority: ["admin"] },
  },
];
export default routes;
