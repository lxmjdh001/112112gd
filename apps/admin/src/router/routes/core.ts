import type { RouteRecordRaw } from "vue-router";
const coreRoutes: RouteRecordRaw[] = [
  {
    name: "Root",
    path: "/",
    redirect: "/dashboard",
    component: () => import("#/layouts/basic.vue"),
    meta: { hideInBreadcrumb: true, title: "Root" },
    children: [],
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
