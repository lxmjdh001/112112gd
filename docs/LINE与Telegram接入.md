# LINE 与 Telegram 接入

## 使用方式

1. 管理员在「登录码」创建或编辑时勾选 LINE、Telegram；已有登录码不会被自动扩大授权。
2. 客户端刷新账号列表，在平台右侧点击「＋」，选择当前电脑网络或独立代理 IP。
3. Telegram 使用官方 Web K 的二维码或手机号登录；LINE 使用官方扩展的二维码或邮箱密码登录，认证仍由平台完成。
4. 每个号位保留独立登录资料，关闭后可重新打开。确认移除号位才清除该号位本机数据。

按固定出口 IP、平台限制账号数量；同一个 IP 可以分别绑定一个 LINE 和一个 Telegram（上限为 1 时）。每个 Telegram 号位只允许一个账号，需要添加其他账号时使用 D1 左侧入口。

计费沿用公司点数规则：识别到实际登录的本人账号后才上报就绪，同公司、同平台、同账号在北京时间同一天只扣一次，扫码页不扣费。断网或状态识别失败不会清除平台登录资料。账号仍受平台自身撤销会话、手机退出等行为影响。

## 技术来源

- [Telegram Web K](https://github.com/morethanwords/tweb)：参考官方网页版的账号存储和页面状态，客户端访问官方托管的 `https://web.telegram.org/k/`，不打包或修改其项目代码。
- [LINE 官方 Chrome 扩展](https://chromewebstore.google.com/detail/line/ophjlpahpchlmihnnnihgmmeilfjmjjc)：加载官方组件，不使用非官方个人账号协议 SDK。
- [line-linux](https://github.com/kylechoidev/line-linux)：调研了桌面封装官方扩展的方案；D1 的安装校验、Electron 兼容层和账号适配器独立实现。
- [LINE Chrome 帮助](https://help.line.me/?contentId=50001182)：平台官方登录说明。

当前 LINE 组件为 3.7.2，扩展 ID 为 `ophjlpahpchlmihnnnihgmmeilfjmjjc`，SHA-256 为 `3722ab02edb0aba49c229399ee8df5b4b5a38c60b76efadadfbae395015eb859`。程序缓存位于 Electron userData 下的 `components/line`；用户会话在原有 `persist:gd7-<tenant>-<account>` 分区。首次下载需要能访问 Google 扩展更新服务，已缓存且验证通过后无需重新下载。

升级组件时需重新核对官方来源、扩展公钥与 ID、固定版本和摘要，检查 `auth.loginState` / `auth.profile.mid` 读取及 Chrome API 兼容性，并重新运行真实登录页验收。固定摘要不匹配时必须拒绝加载。

## 当前范围与验收

接通登录、原生聊天界面、代理隔离、持久化、关闭/移除生命周期、按日计费和选中文字右键翻译。LINE/TG 的收发自动翻译、客户资料/标签同步、快捷图片和话术发送尚未接入，不应向用户承诺这些能力。音视频通话、系统通知及平台弹出窗口未开放。

- 服务端 `go test ./...`：包含真实 PostgreSQL 下的平台授权、单 IP 单平台额度、账号格式和每天去重扣点。
- 桌面类型检查、单元测试、构建及 `scripts/check-account-sidebar.mjs`。
- `scripts/check-native-platforms.mjs`：用隔离测试账号验证 Telegram 本人识别、号位隔离、关闭/重开、重启持久化、清除数据，阻止网页内二次添加账号；加载真实官方 LINE 组件验证二维码/密码登录页、页面无 Node 权限、扫码页不扣费。
- 另外在隔离的 Electron 客户端内检查了 Telegram 官方站点真实未登录页面，可显示二维码、手机号入口，页面没有 Node 权限，未登录不扣费。

没有使用真实手机登录或向联系人发送消息；首次真实扫码、登录后消息收发和真实账号重启恢复仍需实机验收。测试中的持久化检查使用隔离会话数据，不等同于平台真实登录成功。

运行端到端检查前先构建桌面端。可指定 `LINE_COMPONENT_ARCHIVE=/path/to/verified.crx` 使用已下载的同版本官方包，否则客户端从官方服务下载；两种方式都执行同一摘要校验。
