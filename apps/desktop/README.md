# 桌面客户端

规划采用 Electron、TypeScript 与 Vue 3 外围界面。聊天区域加载官方平台 Web 页面，第一期 WhatsApp。

`src/main` 管理账号会话、代理和授权；`src/preload` 提供受限桥接；`src/renderer` 提供登录码和账号切换。业务实现尚未开始。
