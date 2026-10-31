import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    name: "PlatformManagement",
    path: "/platform",
    redirect: "/platform/users",
    component: () => import("#/views/business/platform-layout.vue"),
    meta: { title: "平台管理", icon: "lucide:shield-check", order: -1, authority: ["operator"] },
    children: [
      {
        name: "PlatformUsers",
        path: "/platform/users",
        component: () => import("#/views/business/platform-users.vue"),
        meta: { title: "用户管理", icon: "lucide:users", authority: ["operator"] },
      },
      ...(
        [
          ["records", "充值记录", "receipt-text"],
          ["recharges", "充值审核", "badge-check"],
          ["withdrawals", "提现审核", "wallet"],
          ["settings", "平台设置", "settings-2"],
        ] as const
      ).map(([section, title, icon]) => ({
        name: "Platform-" + section,
        path: "/platform/" + section,
        component: () => import("#/views/business/platform-operations.vue"),
        props: { section },
        meta: { title, icon: "lucide:" + icon, authority: ["operator"] },
      })),
    ],
  },

  {
    name: "WorkOrders",
    path: "/work-orders",
    component: () => import("#/views/business/work-orders.vue"),
    meta: {
      title: "工单管理",
      icon: "lucide:chart-no-axes-combined",
      order: 2.7,
      authority: ["admin"],
    },
  },
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
    name: "TranslationServices",
    path: "/translation-services",
    component: () => import("#/views/business/translation-services.vue"),
    meta: { title: "翻译接口", icon: "lucide:languages", order: 5.5, authority: ["admin"] },
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
    component: () => import("#/views/business/leads.vue"),
    meta: { title: "新增接待", icon: "lucide:list-filter", order: 7, authority: ["admin"] },
  },
  {
    name: "Customers",
    path: "/customers",
    component: () => import("#/views/business/customers.vue"),
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
