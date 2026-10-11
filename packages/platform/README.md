# 平台适配包

此包使用 TypeScript 提供 Electron 平台接入契约。`core` 定义能力和状态，`registry.ts` 注册已开放的平台并校验页面来源、登录账号标识。

| 平台     | 登录入口         | 账号标识              | 已接能力                         |
| -------- | ---------------- | --------------------- | -------------------------------- |
| WhatsApp | 官方 Web         | 本人手机号            | 原生聊天、收发自动翻译、客户工具 |
| Telegram | 官方 Web K       | 本人 Telegram 数字 ID | 原生登录及聊天、选中文字翻译     |
| LINE     | 官方 Chrome 扩展 | 本人 LINE MID         | 原生登录及聊天、选中文字翻译     |

会话分区和代理由客户端主进程统一管理；适配器不能访问其他账号会话。平台能力必须经过实际验证后开放。

Telegram 的 Web K 通过 URL 的 `account` 参数选择账号；D1 每个号位只开放第一个账号，其他账号必须从 D1 左侧单独添加，防止绕过代理额度。读取 `account1.userId`，不从聊天对象或旧 `current_account` 字段推断本人身份。Web A 不属于当前适配范围。

LINE 首次使用从 Chrome Web Store 下载官方组件，校验固定版本、SHA-256 和扩展身份后加载到账号自己的 Electron session。缓存程序文件可共享，Cookie、IndexedDB、扩展存储保持按号位隔离。仅调整官方包的启动清单并提供窗口 API 兼容层，不改官方 JS/WASM，不关闭 sandbox、contextIsolation 或 webSecurity。新官方版本与固定校验不符时，提示更新 D1，不执行未验证组件。

没有可靠本人标识时显示“正在识别账号”，不把聊天对象当作计费账号。LINE、Telegram 的客户资料同步、快捷发送及收发自动翻译尚未适配；当前翻译入口为选中文字后右键。

接入来源、维护与验收说明见 [LINE 与 Telegram 接入](../../docs/LINE与Telegram接入.md)。
