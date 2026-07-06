# 云端采集运行时交付记录

## 交付内容

- 新增 Deploy Hub 云端 collector 编排器、supervisor 和 runtime spec 表。
- 新增 remote-only collector 保护，云端 worker 只通过 collector API 写入。
- 新增 TG/Teams 加密会话存储。
- 更新账号 API、前端账号卡片、容器入口和 Deploy Hub API Token 注入。

## 风险

- 生产必须配置 `ACCOUNT_SESSION_ENCRYPTION_KEY` 和 `COLLECTOR_TOKEN`。
- WA 云端化仍依赖 Chromium 和 WhatsApp Web，存在扫码、风控和资源波动风险。
- 同一账号不能同时运行本地 collector 和云端 collector。

## 后续

- 灰度一个测试账号。
- 根据灰度结果调整 WA Pod 资源和 supervisor 的 stale/restart 阈值。
