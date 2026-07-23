# AGENTS.md

本文件用于指导 Codex 或其他代码协作 Agent 在独立工作台项目中工作。工作台是独立登录、独立存储、独立权限配置、独立前端和独立部署的项目，不与现有 `social-monitor` 共享登录、权限、SQLite、前端路由或 worker 进程。

## 协作硬边界

- 唯一本地项目根目录：`/Users/a2026/Desktop/工作台/`
- 后续所有工作台相关代码、配置、文档、测试、脚本、运行数据、SQLite、session、outbox、临时报告和部署材料，都必须保存在 `/Users/a2026/Desktop/工作台/` 内。
- `/Users/a2026/Desktop/社媒监控/` 是监控项目目录，不再保存工作台项目文件。
- 不得在 `/Users/a2026/Desktop/社媒监控/` 下重新创建 `workbench/`、工作台 SQLite、工作台 session、工作台 outbox、工作台构建产物或工作台测试输出。
- 不得为了方便调试把工作台数据写入监控项目目录；如需临时实验，放在 `/Users/a2026/Desktop/工作台/tools/`、`/Users/a2026/Desktop/工作台/docs/` 或工作台 `.local-data/` 下。
- 如果用户提出工作台需求，默认只在 `/Users/a2026/Desktop/工作台/` 内处理；只有用户明确要求修改监控项目时，才可以触碰 `/Users/a2026/Desktop/社媒监控/`。

## 项目边界

- 工作台目录：`/Users/a2026/Desktop/工作台/`
- 工作台是客服/业务坐席使用的日常 IM 作业系统。
- 工作台必须使用自己的用户登录、服务账号登录、权限配置、数据库和运行态 worker。
- 监控系统是另一个独立项目；除非用户明确要求，不要修改或依赖监控项目。

核心规则：

```text
Workbench owns its auth, raw channel data, runtime state, permissions, UI and deployment;
Workbench must not share monitor SQLite files, monitor auth, monitor frontend routes, or monitor workers.
```

中文规则：

```text
工作台拥有自己的登录、原始消息、运行态、权限、前端和部署；
工作台不得共用监控项目 SQLite、监控登录、监控前端路由或监控 worker。
```

## 必读文档

开始任何工作台开发前，先阅读：

- `DEVELOPMENT_GUIDE.md`

涉及 WhatsApp（WA）账号、`whatsapp-web.js`、Chromium、session、消息同步、媒体下载、标签同步、外发状态、worker 或相关部署的任何变更前，还必须完整阅读：

- `docs/development/wa-account-operation-guide.md`

该规范是 WA 变更的强制发布门槛：必须从账号生命周期、消息身份、媒体落盘、鉴权访问、可观测性、端到端验证与回滚评估改动；不得只修 UI 表象或直接修改 `node_modules`。

如果用户明确要求修改监控项目，必须先重新确认范围；默认工作台需求只在 `/Users/a2026/Desktop/工作台/` 内实现。

从 2026-07-08 起，`workbench/` 指 `/Users/a2026/Desktop/工作台/`，不是 `/Users/a2026/Desktop/社媒监控/workbench/`。

## 推荐目录

后续实现时，优先采用以下结构：

```text
/Users/a2026/Desktop/工作台/
├── AGENTS.md
├── DEVELOPMENT_GUIDE.md
├── frontend/                 # Vue 3 + Vite + Element Plus UI
├── server/                   # Node.js / Express API
├── db/                       # workbench.sqlite 与访问层
├── scripts/                  # 初始化、迁移、维护脚本
├── docs/                     # 产品、架构、测试、交付文档
├── tests/                    # 自动化测试
└── outbox/                   # 本地文件门铃目录，默认不提交
```

## 技术栈倾向

如用户没有另行指定，工作台优先沿用现有项目生态：

- Node.js
- Express
- Vue 3
- Vite
- Element Plus
- SQLite
- PM2

不要随意引入大型新框架、消息队列、状态机平台或数据库，除非用户明确同意。

## UI 约束

工作台 UI 是纯 IM 作业面，采用两栏布局：

- 左栏：群列表
- 中栏：消息线程和回复框

允许出现：

- 平台过滤：WA、TG
- 我的群、未读、全部
- 渠道原生标签/分组过滤：WA 标签、TG 文件夹
- 搜索
- 群名、渠道标签、最近消息、时间、未读数、归属坐席
- 入站气泡、外发气泡、引用、图片、文件
- 标记已读
- 移交/认领
- 打开原生群
- 发送状态：pending、sending、sent、delivered、failed、dead、paused、canceled

禁止出现：

- 告警侧栏
- AI 建议回复
- AI 群摘要
- 知识库联想
- 供应商画像
- 可靠性评分
- 内容模板下拉
- 按告警等级排序
- 任何监控分析结论

回复框第一版只做：

- 多行文本
- 附件入口
- 发送按钮
- 当前发送账号提示

## 数据库边界

工作台必须使用独立库：

```text
auth.sqlite
workbench.sqlite
raw.sqlite
runtime.sqlite
```

本地默认落盘位置：

```text
/Users/a2026/Desktop/工作台/.local-data/db/auth.sqlite
/Users/a2026/Desktop/工作台/.local-data/db/workbench.sqlite
/Users/a2026/Desktop/工作台/.local-data/db/raw.sqlite
/Users/a2026/Desktop/工作台/.local-data/db/runtime.sqlite
```

生产默认落盘位置：

```text
/data/db/auth.sqlite
/data/db/workbench.sqlite
/data/db/raw.sqlite
/data/db/runtime.sqlite
```

规则：

- 工作台不得读取或写入监控项目的 `database.sqlite`、`analytics.sqlite` 或其他 SQLite 文件。
- 工作台不得读取或写入 `/Users/a2026/Desktop/社媒监控/` 下任何 SQLite、session、outbox 或缓存文件。
- 工作台原始消息、服务账号档案和渠道同步数据写入自己的 `raw.sqlite`。
- 工作台运行态、服务账号登录任务和 worker 状态写入自己的 `runtime.sqlite`。
- 工作台用户登录和兼容审计写入自己的 `auth.sqlite`。
- 工作台自己的外发、已读、分配、审计数据写入 `workbench.sqlite`。

`workbench.sqlite` 核心表应包括：

- `operators`
- `outbound_messages`
- `group_assignments`
- `conversation_reads`
- `agent_actions`
- `send_circuit_breaker`
- `operator_portal_access`
- `operator_service_group_scopes`
- `channel_labels`
- `conversation_label_map`

渠道标签/分组规则：

- WA 标签和 TG 文件夹是渠道原生元数据，不是监控分析标签。
- 标签/分组必须按 `platform + account` 隔离。
- 同一个群在不同账号下可以有不同标签/分组。
- 工作台第一版只读、展示和筛选标签/分组。
- 不在工作台内编辑 WA 标签或 TG 文件夹。
- 不把渠道标签与告警等级、供应商评分、知识资产标签混用。

## 外发设计规则

外发消息必须遵循：

```text
DB = 账本
文件 = 门铃
定时扫描 = 保险
```

正确流程：

```text
Workbench API 写 outbound_messages(status=pending)
-> 写 outbox 文件门铃
-> 对应 worker 被唤醒
-> worker 回 workbench.sqlite 查询任务
-> worker 串行调用 sendMessage
-> worker 回写 sent/failed/paused/dead
```

禁止：

- 把文件队列作为唯一事实源。
- 工作台 API 在请求线程里直接创建或持有 WA/TG client。
- 工作台浏览器直接操作 WA/TG session。
- 多个进程同时持有同一 WA/TG 账号 session。
- 同一 WA 账号并发 `sendMessage`。

`outbound_messages` 必须支持 `client_msg_id` 幂等：

```text
UNIQUE(created_by, client_msg_id)
```

重复提交时返回已有外发记录，不得重复发送。

## Worker 边界

工作台自己的 WA/TG runtime worker 是唯一真实登录者和发送者。

群列表和标签/分组能力按阶段处理：

```text
阶段 1：
- 工作台通过自己的服务账号登录入口创建 WA/TG 登录任务。
- 工作台 runtime worker 登录并写入 raw.sqlite / runtime.sqlite。
- 工作台从自己的 raw.sqlite 聚合群列表和消息。

阶段 2：
- 工作台 runtime worker 同步完整群列表、WA 原生标签、TG 用户号文件夹。
- 同步结果写入 workbench.sqlite。
```

工作台 runtime worker 必须满足：

- 使用工作台自己的 `auth.sqlite`、`workbench.sqlite`、`raw.sqlite`、`runtime.sqlite`。
- 不读取或写入监控项目 SQLite。
- 不依赖监控项目 PM2 进程或 worker。
- 同账号串行发送。
- 只读取自己的任务：

```text
WHERE platform = ? AND account = ? AND status = 'pending'
```

标签/分组同步也必须满足：

- 渠道标签/分组同步必须由对应账号 worker 执行。
- 工作台 API 和前端不得直接读取 WA/TG session。

建议环境变量：

```text
WORKBENCH_RUNTIME_WORKER=1
WORKBENCH_SEND_ENABLED=1
WORKBENCH_LABEL_SYNC_ENABLED=1
WORKBENCH_CHAT_SYNC_ENABLED=1
WORKBENCH_DB_PATH=/path/to/workbench.sqlite
WORKBENCH_RAW_DB_PATH=/path/to/raw.sqlite
WORKBENCH_RUNTIME_DB_PATH=/path/to/runtime.sqlite
WORKBENCH_OUTBOX_DIR=/path/to/outbox
```

不开启这些开关时，工作台 UI/API 仍可运行，但不会执行真实渠道登录或发送。

## 风控规则

WhatsApp 外发风险较高，第一版必须保守：

- 只做人工回复。
- 不做自动批量回复。
- 不做营销触达。
- 不做高频群发。
- 不做批量私聊。
- 单账号串行。
- 单账号限速。
- 失败熔断。
- 保留审计。

建议状态：

```text
pending -> sending -> sent -> delivered
                  -> failed -> retry/new outbound
                  -> dead
pending -> canceled
pending/sending -> paused
```

建议熔断：

```text
单账号 5 分钟内 failed >= 3
-> send_circuit_breaker 进入 cooldown
-> UI 显示账号暂停
-> 暂停继续发送
```

Telegram 用户号遇到 `FloodWait`、`PeerFlood` 等信号时，应停止或隔离任务。

## 渠道标签与分组同步

工作台可以识别账号已有的 WA 标签和 TG 用户号文件夹，但必须通过 worker 同步到 `workbench.sqlite`。

允许：

- `worker-wa-{account}` 同步 WhatsApp labels。
- `worker-tg-user-{account}` 同步 Telegram Dialog Folders。
- 工作台 UI 读取 `channel_labels` 和 `conversation_label_map` 做筛选和展示。

禁止：

- 工作台 API 直接调用 `whatsapp-web.js` client。
- 工作台 API 直接调用 Telegram MTProto client。
- 坐席浏览器直接访问 WA/TG session。
- `worker-tg.js` Bot 读取 Telegram 用户号文件夹。
- 在第一版中修改渠道原生标签或文件夹。

同步要求：

- worker ready 后可同步一次。
- 后续低频同步，建议 10-30 分钟一次。
- 同步失败不得影响消息采集和外发。
- 同步结果要保留 `raw_json`，便于后续兼容渠道结构变化。
- TG 文件夹如果是规则型条件，需要物化为当前可见群映射。

## API 边界

工作台接口统一使用：

```text
/api/workbench/*
```

不要把工作台接口混入现有：

- `/api/analytics/*`
- `/api/data/*`
- 告警、画像、知识库相关路由

建议接口：

```text
GET  /api/workbench/accounts
GET  /api/workbench/channel-labels
GET  /api/workbench/groups
GET  /api/workbench/groups/:groupId/messages
POST /api/workbench/reply
POST /api/workbench/messages/read
POST /api/workbench/groups/:groupId/assign
POST /api/workbench/groups/:groupId/release
POST /api/workbench/outbound/:id/cancel
POST /api/workbench/outbound/:id/retry
GET  /api/workbench/outbound/:id
```

禁止工作台 API import 或查询：

- `lib/ai-client.js`
- `alert_records`
- `issue_records`
- `daily_digests`
- `supplier_profiles`
- `reliability_snapshots`
- `knowledge_assets`
- `qa_kb`
- `device_kb`
- `content_templates`

## 生产安全

开发工作台时，不得影响生产监控系统。

禁止在未明确得到用户要求时执行：

- 修改 `ecosystem.cloud.config.js`
- 修改 `docker-entrypoint.sh`
- 开启生产真实外发
- 使用生产 WA/TG 账号测试外发
- 修改生产数据库结构
- 提交 `.env`、token、session、SQLite 数据文件、WAL/SHM 文件

生产灰度必须满足：

- 单账号
- 低风险账号
- 限速开启
- 熔断开启
- 审计开启
- 可快速关闭

## 文档要求

新增功能或较大变更时，应先更新或补充文档：

- `docs/product/`：产品和交互
- `docs/architecture/`：架构和数据流
- `docs/development/`：开发说明
- `docs/test/`：测试方案和报告
- `docs/report/`：交付记录

工作台开发必须持续保持以下边界可读：

- 工作台不展示监控分析结果。
- 工作台不调用 AI。
- 工作台只能通过自己的服务账号登录入口发起 WA/TG 登录任务。
- 工作台只写自己的 `auth.sqlite`、`workbench.sqlite`、`raw.sqlite`、`runtime.sqlite`。
- 工作台 runtime worker 是唯一渠道执行层。

## 测试要求

后端变更：

- 运行相关单元测试。
- 对 CommonJS 文件可先使用 `node --check <file>`。
- 验证 `client_msg_id` 幂等。
- 验证发送状态流转。
- 验证 worker 重启后 pending/sending 可恢复。

前端变更：

- 运行构建。
- 验证桌面宽度下两栏布局。
- 验证窄屏布局不重叠。
- 验证长文本、长群名、长账号名不会溢出。
- 验证发送按钮、Enter/Shift+Enter、失败重试状态。

涉及 worker：

- 只用测试账号。
- 验证不开环境变量时行为不变。
- 验证同账号串行发送。
- 验证文件门铃丢失后定时扫描仍能发送。
- 验证失败熔断。

## Git 与数据安全

- 不提交 `.env`。
- 不提交 WA/TG session。
- 不提交真实消息正文导出的审计报告。
- 不提交 SQLite 数据库文件，除非用户明确要求。
- 不提交 WAL/SHM 文件。
- 不回滚用户已有改动。
- 不做无关重构。
- 改动范围聚焦当前需求。

## 开发优先级

MVP 顺序：

1. `workbench.sqlite` schema 和初始化脚本。
2. Workbench API 读取自己的 `raw.sqlite` 展示群和消息。
3. `channel_labels` 和 `conversation_label_map` 表与模拟数据展示。
4. 两栏 Workbench UI，支持平台、未读、我的群、渠道标签/分组筛选。
5. `outbound_messages` 写入和文件门铃。
6. 工作台服务账号登录入口和登录任务 outbox。
7. 本地单测试账号 outbound 消费器。
8. 本地 runtime worker 只读同步 WA 标签和 TG 用户号文件夹。
9. 已读、认领、移交、操作日志。
10. 失败重试、熔断、状态可视化。

暂缓：

- AI 建议回复
- 知识库引用
- 告警联动
- 供应商画像展示
- 在工作台内编辑 WA 标签或 TG 文件夹
- 复杂工单流
- 本地 HTTP/IPC 直连 worker
- 多级审批

## 最终原则

```text
工作台只做独立登录、服务账号接入、收、发、分派、已读；
监控系统是另一个独立项目；
工作台 runtime worker 只做工作台渠道 session 和真实发送；
两套系统不能共用登录、权限、前端、SQLite 或 worker。
```
