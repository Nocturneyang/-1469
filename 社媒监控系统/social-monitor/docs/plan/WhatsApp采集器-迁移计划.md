# WhatsApp Collector Migration Plan

## 目标

将 WhatsApp 从生产主进程里拆出来，形成“生产轻量主系统 + 本地 PM2 collector + collector API 上报 + 可替代通道预留”的架构。当前资源结论是生产 3Gi 不适合继续承载多个 WA Chrome，本地 16GB 机器承载多 WA 更稳。

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

下一步继续保留 WA RuntimeAdapter 抽象，让同一套 orchestrator 既能管理当前 PM2 模式，也能在未来需要硬隔离时切回 Rainbond/Kubernetes collector。

## 阶段 2.5：RuntimeAdapter 抽象（已落地 PM2 适配器）

- 新增 `lib/wa-runtime-adapters/pm2-runtime-adapter.js`，封装本地 PM2 的列表、启动和重启操作。
- 新增 `lib/wa-runtime-adapters/k8s-runtime-adapter.js`，支持通过集群内 Kubernetes API 管理线上 Kubernetes/Rainbond collector Deployment，必要时回退 `kubectl`。
- `wa-supervisor` 只依赖 RuntimeAdapter 接口，不再在状态机中直接拼 PM2 命令。
- 当前线上默认 `WA_RUNTIME_ADAPTER=pm2`，不依赖 Rainbond 管理端启动账号组件。
- 前端运行时卡片已从固定 `PM2` 表述改为通用运行时字段，未来切到 K8s/Rainbond 时仍可复用。
- 主系统 K8s manifest 保留最小 ServiceAccount/Role/RoleBinding，作为未来硬隔离 collector 的备用能力；当前 PM2 模式不依赖这些权限。

## 阶段 3：Collector 协议

- 主系统新增 `POST /api/collector/heartbeat`、`/events`、`/account-status`、`/messages`，使用 `COLLECTOR_TOKEN` 鉴权。
- 主系统新增 `POST /api/collector/media`，collector 可将媒体 base64 上传回主系统并得到 `media/<file>` 路径。
- WA worker 配置 `COLLECTOR_API_URL` 后会通过 HTTP 上报心跳、事件、账号状态和消息；未配置时保留本地 SQLite 写入模式。
- collector 模式不加载本地 `db/database`，避免隔离容器直接打开主系统 SQLite。
- `npm run wa:collector` 可让同一镜像在 collector 角色下运行；Deploy Hub/Rainbond 只构建一个主镜像，不再为 collector 另建镜像。

后续可继续把主系统本地媒体存储替换成对象存储，避免 App ID 58 的 10GiB PVC 被图片/视频长期占满。

## 阶段 4：生产轻量化 + 本地 Collector

- `social-monitor` App ID 58 使用单镜像单组件模式：Rainbond 只启动主组件，容器内 PM2 启动 Web/API、分析器和必要的轻量 TG user worker。
- 生产设置 `LOCAL_WA_RUNTIME_ENABLED=false`，`ecosystem.cloud.config.js` 不包含 `worker-wa-*`，也不包含 `wa-supervisor`。
- 前端新增 WA 时只在生产数据库登记为 `remote_pending`，不会在生产 PM2 里启动 Chrome。
- 本地使用 `ecosystem.local-collectors.config.js` 启动 `nanya_wa`、`wa_oumei2`、`wa_shebi`，并通过 `COLLECTOR_API_URL` / `COLLECTOR_TOKEN` 上报生产。
- 本地 Orchestrator 通过 PM2 RuntimeAdapter 管理账号进程，`WA_PM2_ECOSYSTEM_FILE=ecosystem.local-collectors.config.js`。
- 根 `Dockerfile` 包含 Chromium，确保同一镜像里的 WA worker 可以启动 Chrome。
- 新增 `.dockerignore`，避免把本地 session、SQLite、media、node_modules 打入主系统或 collector 镜像。
- `.deployhub/k8s/app.yaml` 固化 App ID 58 的 10Gi PVC、当前主组件资源规格和 `LOCAL_WA_RUNTIME_ENABLED=false`。
- 保留 `npm run wa:collector:manifest` 作为未来硬隔离方案工具，但当前 Deploy Hub 不再使用独立 collector manifest。
- 主系统已补齐 skyline-ark-sso 兼容：`sso: true`、`/token/userinfo`、运行时 `/runtime-config.js`、前端 401 统一登录跳转。

## 阶段 5：可替代通道

- 保持统一消息协议，预留 `wa-web`、`wa-business-api`、`third-party-bsp`、`manual-upload`。
- 能迁移到官方或第三方 API 的业务逐步减少 Chrome 依赖。
