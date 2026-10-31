import { defineOverridesPreferences } from "@vben/preferences";
export const overridesPreferences = defineOverridesPreferences({
  app: {
    name: "D1 Scrm",
    defaultHomePath: "/dashboard",
    locale: "zh-CN",
    enableRefreshToken: false,
    enableCheckUpdates: false,
    defaultAvatar: "/logo.svg",
  },
  logo: { source: "/logo.svg", sourceDark: "/logo.svg" },
  theme: {
    mode: "light",
    colorPrimary: "#3659d9",
    colorSuccess: "#147c57",
    colorWarning: "#975a16",
    colorDestructive: "#c3343f",
  },
  copyright: { enable: false },
});
