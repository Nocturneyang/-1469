# 2026-07-06 Cloud Collector Heartbeat URL Hotfix

## 背景

生产账号管理页出现云端 WA runtime 已创建但主系统仍显示无心跳的状态，典型提示为 `No heartbeat yet; ensured cloud collector deployment`。

## 根因

云端 collector 的 `COLLECTOR_API_URL` 需要配置为主服务 origin，例如 `http://social-monitor`。collector client 会自行追加 `/api/collector/heartbeat`、`/api/collector/events` 等路径。

旧配置把 `CLOUD_COLLECTOR_API_URL` 设为 `http://social-monitor/api/collector`，导致实际请求路径被拼成 `/api/collector/api/collector/heartbeat`，云端 collector 无法把心跳写回主服务。

## 修复

- 将 Deploy Hub/K8s 和 PM2 cloud ecosystem 的默认 `CLOUD_COLLECTOR_API_URL` 改为 `http://social-monitor`。
- 在 `lib/collector-client.js` 中兼容旧配置，自动去掉末尾 `/api/collector`。
- 提升 `docker-entrypoint.sh` 的 `CLOUD_ECOSYSTEM_VERSION`，确保生产容器刷新持久化 PM2 cloud ecosystem。

## 验证

- `node --check` 已覆盖本次改动的 CommonJS 文件。
- 单独验证 `normalizeBaseUrl('http://social-monitor/api/collector')` 会归一为 `http://social-monitor`。
- 当前 `npm test` 仍有 2 个既有失败，分别是 `tg-account1` 区域配置缺失和 `A-Support` 内部员工识别断言，与本次 heartbeat URL 修复无关。

## 部署后操作

部署新镜像后，对仍处于无心跳的云端 WA 账号执行一次 runtime restart 或 relogin，使 Deploy Hub 组件拿到新的环境变量并重新上报心跳。
