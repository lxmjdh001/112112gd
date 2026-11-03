# go7 工单账号 JSON API

默认使用 GET，请求参数为 `api=go7`，不需要网站管理员登录。将下方 `YOUR_SHARE_TOKEN` 替换为工单分享链接 `/s/` 后的令牌；示例不包含真实访问令牌。

```text
https://d1scrm.com/api/v1/public/work-orders/YOUR_SHARE_TOKEN?api=go7
```

浏览器打开原分享链接 `https://d1scrm.com/#/s/令牌?api=go7` 会跳转至上述 API。采集程序应直接请求 API：HTTP 不会发送 `#` 后的内容，普通 HTTP 客户端也不会执行网页跳转代码。

```bash
curl --fail-with-body 'https://d1scrm.com/api/v1/public/work-orders/YOUR_SHARE_TOKEN?api=go7'
```

有分享密码时增加请求头 `X-Work-Order-Password: 分享密码`。密码不放在 URL 中。

响应结构示例（示意数据）：

```json
{
  "code": 0,
  "data": {
    "name": "工单名称",
    "updatedAt": "2026-11-03T12:00:00Z",
    "total": 1,
    "accounts": [{
      "id": "账号唯一ID",
      "label": "账号备注",
      "nickname": "昵称",
      "account": "8613800000001",
      "platform": "whatsapp",
      "connectionType": "web",
      "status": "online",
      "removed": false,
      "lastSync": null,
      "firstSync": null,
      "collectorReady": false,
      "lastInbound": null,
      "total": 0,
      "today": 0,
      "yesterday": 0,
      "fresh": 0,
      "duplicate": 0,
      "todayFresh": 0,
      "todayDuplicate": 0
    }]
  }
}
```

go7 读取 `data.accounts`，以 `id` 作为稳定标识，`account` 为已确认的平台账号（未确认时可能为空）。`data.total` 是账号数，账号内的 `total` 是累计进线人数。空工单返回 `accounts: []`。已移除账号保留历史，采集当前账号时过滤 `removed: true`；在线状态为 `online`、`offline` 或 `error`。

只返回该工单已选择的账号及公开统计，不返回登录码、平台登录凭据或客户明细。统计口径沿用工单页面。建议每 30 秒采集一次；同一来源 IP 对同一路径模式的请求限制为每分钟 12 次（多个工单共享该额度），失败请求也计数；收到 429 时等待下一分钟再请求。响应禁止缓存。密码错误返回 HTTP 403；令牌无效、停用、过期、重置或工单删除后返回 HTTP 404；限流返回 HTTP 429。

服务端和网站更新发布后生效，本地实现不代表生产已上线。`GET /api/v1/public/work-orders/令牌/accounts` 同样可用。

`nickname` 沿用统计页面展示名称：原生账号使用账号备注，API 账号优先使用已验证名称。`platform` 为平台标识，API 账号可通过 `connectionType: "cloud"` 识别；不要将 `collectorReady` 当作在线状态。
