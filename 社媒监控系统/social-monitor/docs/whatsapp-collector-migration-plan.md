# WhatsApp Collector Migration Plan

## 目标

将 WhatsApp 从主系统执行面中拆出，形成“主系统轻量化 + WA 采集器隔离化 + 状态调度中心化 + 可替代通道预留”的架构。当前阶段先保留 PM2，本地落地统一心跳、事件和状态模型，为后续 Rainbond/Kubernetes collector 拆分做准备。

## 阶段 1：运行态账本（已落地）

- 新增 `collector_heartbeats`：记录每个 collector 的 `run_id`、阶段、心跳、最后 ready、最后消息、最近错误。
- 新增 `wa_runtime_events`：记录 worker/supervisor 事件，例如启动、排队、ready、初始化超时、高内存重启。
- WA worker 每 15 秒上报心跳。
- 前端账号 API 合并心跳信息，识别 `stale_online`，避免“在线但无 Chrome”的假在线。

## 阶段 2：Orchestrator 接管（本地 PM2 版已落地）

- `wa-supervisor` 已承担 orchestrator 职责，PM2 进程名暂不改，避免破坏现有运维脚本。
- 账号表新增 `orchestrator_state`、`collector_phase`、`collector_run_id`、`collector_heartbeat_age_seconds`。
- 状态机已覆盖 `healthy`、`queued`、`starting`、`cooling_down`、`stale_online`、`stale_heartbeat`、`degraded_high_rss`、`no_chrome`、`pm2_down`、`recovering_pm2`、`recovering_init`。
- 外部 PM2 干预通过 reconciliation 识别，连续异常后自动恢复；外部杀 Chrome 仍走无 Chrome 连续检查与冷却保护。
- 状态变化写入 `wa_runtime_events`，前端/API 优先展示 orchestrator 的运行事实。
- worker 初始化失败后默认进入驻留心跳模式，不再通过 `process.exit(1)` 触发 PM2 立即重启；orchestrator 等冷却结束后统一恢复。

下一步继续把 WA RuntimeAdapter 抽象出来，让同一套 orchestrator 可以管理本地 PM2 和线上 Rainbond/Kubernetes collector。

## 阶段 2.5：RuntimeAdapter 抽象（已落地 PM2 适配器）

- 新增 `lib/wa-runtime-adapters/pm2-runtime-adapter.js`，封装本地 PM2 的列表、启动和重启操作。
- 新增 `lib/wa-runtime-adapters/k8s-runtime-adapter.js`，支持通过集群内 Kubernetes API 管理线上 Kubernetes/Rainbond collector Deployment，必要时回退 `kubectl`。
- `wa-supervisor` 只依赖 RuntimeAdapter 接口，不再在状态机中直接拼 PM2 命令。
- 当前默认 `WA_RUNTIME_ADAPTER=pm2`；线上可切 `WA_RUNTIME_ADAPTER=k8s` 或 `rainbond` 复用同一套状态机。
- 前端运行时卡片已从固定 `PM2` 表述改为通用运行时字段，避免线上 collector 仍显示 PM2 异常。
- 主系统 K8s manifest 已补最小 ServiceAccount/Role/RoleBinding，允许 orchestrator 查看 pods/deployments，并 patch/restart/scale WA collector。

## 阶段 3：Collector 协议

- 主系统新增 `POST /api/collector/heartbeat`、`/events`、`/account-status`、`/messages`，使用 `COLLECTOR_TOKEN` 鉴权。
- 主系统新增 `POST /api/collector/media`，collector 可将媒体 base64 上传回主系统并得到 `media/<file>` 路径。
- WA worker 配置 `COLLECTOR_API_URL` 后会通过 HTTP 上报心跳、事件、账号状态和消息；未配置时保留本地 SQLite 写入模式。
- collector 模式不加载本地 `db/database`，避免隔离容器直接打开主系统 SQLite。
- 新增 `Dockerfile.wa-collector` 和 `npm run wa:collector`，每个 WA 账号可作为独立 collector 组件运行。

后续可继续把主系统本地媒体存储替换成对象存储，避免 App ID 58 的 10GiB PVC 被图片/视频长期占满。

## 阶段 4：Rainbond/Kubernetes 拆分

- `social-monitor` App ID 58 只保留 Web/API/DB/分析/调度。
- 每个 WA 账号独立 collector 组件，建议每个组件 2-3GiB 内存限制。
- Orchestrator 通过 RuntimeAdapter 管理本地 PM2 或线上 Rainbond/K8s。
- 主系统 `Dockerfile` 已移除 Chrome 安装，构建时设置 `SKIP_CHROME_INSTALL=true` 和 `PUPPETEER_SKIP_DOWNLOAD=true`。
- 新增 `.dockerignore`，避免把本地 session、SQLite、media、node_modules 打入主系统或 collector 镜像。
- 新增 `.deployhub/k8s/app.yaml`，固化 App ID 58 的 10Gi PVC、`500m/1Gi` requests、`2/3Gi` limits。
- 新增 `npm run wa:collector:manifest`，可为每个 WA 账号生成独立 collector 的 K8s manifest。
- 主系统已补齐 skyline-ark-sso 兼容：`sso: true`、`/token/userinfo`、运行时 `/runtime-config.js`、前端 401 统一登录跳转。

## 阶段 5：可替代通道

- 保持统一消息协议，预留 `wa-web`、`wa-business-api`、`third-party-bsp`、`manual-upload`。
- 能迁移到官方或第三方 API 的业务逐步减少 Chrome 依赖。
