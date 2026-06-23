# 云端账号登录与采集运行时技术方案

## 架构

- 主服务负责 API、分析器、账号编排和 collector receiver。
- 每个账号由 `cloud-collector-orchestrator` 创建一个 K8s Deployment。
- Deployment 复用当前镜像，通过 `COLLECTOR_PLATFORM` 分支启动 WA、TG Bot、TG 用户号或 Teams Graph worker。
- collector 通过 `/api/collector/*` 写入消息、心跳、事件和账号状态；本地 outbox 负责短暂故障重放。

## 数据与状态

- `collector_runtime_specs` 保存账号到 K8s Deployment 的映射、期望状态、资源配置、session 目录和最后错误。
- `accounts` 扩展 `runtime_desired_state`、`deployment_name`、`session_status`。
- `cloud-collector-supervisor` 周期读取 runtime specs 和 heartbeats，更新账号健康状态，并在心跳长期过期时滚动重启。

## 会话

- `ACCOUNT_SESSION_ENCRYPTION_KEY` 是固定密钥，缺失时禁止保存 TG/Teams 凭据。
- TG 用户号 session 新写入 `/data/collector-sessions/telegram-user/{account}/session.enc`，旧 `.env` session 只读兼容。
- Teams token 新写入 `/data/collector-sessions/teams/{account}/tokens.json`，旧 `teams-profile-*` 路径只读兼容。
- WA LocalAuth 使用 `/data/collector-sessions/wa/session-{account}`。

## 部署

- `.deployhub/k8s/app.yaml` 赋予 ServiceAccount 创建、删除、更新 Deployment 的权限。
- `CLOUD_COLLECTOR_IMAGE=__IMAGE__` 注入主服务，确保账号 Pod 使用同一镜像。
- `docker-entrypoint.sh` 根据 `COLLECTOR_PLATFORM` 作为 collector 启动。
