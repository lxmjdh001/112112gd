# 开发与发布工具

预留环境检查、构建验证、客户端打包、发布清单生成和备份恢复工具。每次正式构建记录 Git 提交、依赖版本和产物校验值。


## 翻译接口管理验收

在开发镜像中完成 `pnpm --filter @gongdan/admin build` 后运行 `node scripts/check-translation-monitor.mjs`。脚本需要可访问的本地 PostgreSQL（默认端口 55437，可通过 `TEST_DATABASE_URL` 覆盖），使用独立 schema 和 5783 预览端口，退出时清理测试数据和进程。翻译提供者使用模拟响应，不调用真实接口；截图保存在 `.runtime/translation-monitor.png`。
