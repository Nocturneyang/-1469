# 云端采集运行时架构

本次改造把账号采集进程从本地 PM2 迁移到 Deploy Hub/Rainbond 独立 collector 组件。主应用继续提供 UI、API、分析器和 collector receiver，每个账号一个云端 collector 组件；主 Pod 不再直连 K8s API。

关键链路：

1. 管理员在账号管理页新增账号。
2. 后端写入账号记录和 `collector_runtime_specs`。
3. `cloud-collector-orchestrator` 使用 Deploy Hub `rainbond_deploy_component` 创建或更新账号 collector 组件。
4. collector 通过 `/api/collector/*` 上报心跳、事件、账号状态和消息。
5. `cloud-collector-supervisor` 轮询 runtime specs 与 heartbeats，回写健康状态并处理长期过期。

安全边界：

- collector 组件不直接写主 SQLite。
- TG/Teams 凭据使用固定密钥加密存储在 `/data/collector-sessions/`。
- WA LocalAuth 仅在 PVC 会话目录中保存，不进入 Git。
