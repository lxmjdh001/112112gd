# Go 业务服务

规划使用 Go、Gin 和 PostgreSQL，按领域划分 `internal/modules`，启动装配放在 `cmd/api`，数据库升级放在 `migrations`。

网站业务权限、长期登录码、设备名额和租户隔离在此实现。此目录当前仅为结构预留。
