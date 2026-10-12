import type { RouteRecordRaw } from "vue-router";
const coreRoutes: RouteRecordRaw[] = [
  {
    name: "PublicWorkOrder",
    path: "/s/:token",
    component: () => import("#/views/public/work-order.vue"),
    meta: { title: "D1 工单统计", hideInMenu: true, hideInTab: true, ignoreAccess: true },
  },
  {
    name: "Root",
    path: "/",
    redirect: "/home",
    component: () => import("#/layouts/basic.vue"),
    meta: { hideInBreadcrumb: true, title: "Root" },
    children: [],
  },
  {
    name: "PublicHome",
    path: "/home",
    component: () => import("#/views/public/home.vue"),
    meta: {
      title: "D1 工单 · D1scrm｜多账号客服与免费翻译",
      hideInMenu: true,
      hideInTab: true,
      ignoreAccess: true,
    },
  },
  {
    name: "Authentication",
    path: "/auth",
    redirect: "/auth/login",
    component: () => import("#/layouts/auth.vue"),
    meta: { hideInTab: true, title: "登录" },
    children: [
      {
        name: "Login",
        path: "login",
        component: () => import("#/views/_core/authentication/login.vue"),
        meta: { title: "登录" },
      },
      {
        name: "Register",
        path: "register",
        component: () => import("#/views/_core/authentication/register.vue"),
        meta: { title: "注册" },
      },
    ],
  },
];
const fallbackNotFoundRoute: RouteRecordRaw = {
  name: "FallbackNotFound",
  path: "/:path(.*)*",
  component: () => import("#/views/_core/fallback/not-found.vue"),
  meta: { hideInMenu: true, hideInTab: true, hideInBreadcrumb: true, title: "404" },
};
export { coreRoutes, fallbackNotFoundRoute };
