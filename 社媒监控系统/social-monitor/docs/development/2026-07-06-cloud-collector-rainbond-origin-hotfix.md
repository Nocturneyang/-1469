# 2026-07-06 Cloud Collector Rainbond Origin Hotfix

## 背景

`wa-ceshi_test` 在生产账号管理页持续显示 `No heartbeat yet; ensured cloud collector deployment`。Deploy Hub 显示 `sm-collector-wa-ceshi-test` 已创建且 collector Pod 处于 running。

## 根因

Deploy Hub 当前把每个账号 collector 部署成独立 Rainbond app。collector 容器内使用 `COLLECTOR_API_URL=http://social-monitor` 时，无法解析主系统组件短域名，日志表现为：

```text
[CollectorClient] POST /api/collector/heartbeat failed: getaddrinfo ENOTFOUND social-monitor
```

因此 collector 已经启动并生成二维码，但 heartbeat、event、account-status 不能回写主系统。

## 修复

- 将 Deploy Hub 生产模板中的 `CLOUD_COLLECTOR_API_URL` 改为 `https://social-monitor.tyhark.com`。
- 将 cloud ecosystem 和 Deploy Hub runtime adapter 的默认回调 origin 改为 `CLOUD_COLLECTOR_API_URL -> MEDIA_BASE_URL -> https://social-monitor.tyhark.com`。
- 保留 `collector-client` 自动拼接 `/api/collector/*` 的行为，环境变量只配置 origin，不包含 `/api/collector` 后缀。
- 修正生产 PM2 配置中的 Collector Token 校验兜底：显式 `COLLECTOR_TOKEN_SHA256` 仍优先；如果只配置了明文 `COLLECTOR_TOKEN`，主服务改为按明文校验，避免历史兜底 hash 覆盖真实生产 token。
- 提升 `docker-entrypoint.sh` 的 `CLOUD_ECOSYSTEM_VERSION`，确保生产容器刷新 `/data/ecosystem.config.js`。
- 为云端 collector 配置 `COLLECTOR_API_TIMEOUT_MS=20000`，并让 `collector-client` 支持该环境变量，避免主服务 SQLite 短暂忙碌时 8 秒客户端超时造成误判和 outbox 重试。

## 影响范围

仅影响云端 collector 向主系统回写 heartbeat、事件、账号状态和消息的目标地址，以及主服务 Collector 接收端在生产 PM2 基线中的 token 校验选择。本地 collector 仍可通过显式 `COLLECTOR_API_URL` 覆盖。
