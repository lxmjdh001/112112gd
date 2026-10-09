import { defineOverridesPreferences } from "@vben/preferences";
export const overridesPreferences = defineOverridesPreferences({
  app: {
    name: "工单007",
    defaultHomePath: "/dashboard",
    locale: "zh-CN",
    enableRefreshToken: false,
    enableCheckUpdates: false,
    defaultAvatar: "/logo.svg",
  },
  logo: { source: "/logo.svg", sourceDark: "/logo.svg" },
  theme: { mode: "light", colorPrimary: "hsl(228 85% 60%)" },
  copyright: { enable: false },
});
