# AGENTS.md

本文件用于指导 Codex 或其他代码协作 Agent 在 `workbench/` 项目中工作。工作台是独立于现有监控系统的新项目，但会与现有 `social-monitor` 的采集 worker 共享渠道执行能力。

## 项目边界

- 工作台目录：`/Users/a2026/Desktop/社媒监控/workbench/`
- 现有监控系统目录：`/Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor/`
- 工作台是客服/业务坐席使用的日常 IM 作业系统。
- 监控系统是采集、分析、告警、知识资产和运营看板系统。
- 两套系统必须保持产品心智、路由、数据库和权限边界清晰。

核心规则：

```text
Workbench may read raw channel messages and write operational events;
Workbench must not read analytical outputs or invoke AI/knowledge modules.
```

中文规则：

```text
工作台可以读取原始消息，可以写入作业事件；
工作台不得读取分析结果，不得调用 AI、告警、画像、知识库模块。
```

## 必读文档

开始任何工作台开发前，先阅读：

- `DEVELOPMENT_GUIDE.md`

如果需要修改现有监控系统，再阅读：

- `/Users/a2026/Desktop/社媒监控/AGENTS.md` 或用户提供的根目录规范
- `/Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor/.specify/memory/constitution.md`

## 推荐目录

后续实现时，优先采用以下结构：

```text
workbench/
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

工作台推荐使用独立库：

```text
workbench.sqlite
```

现有监控系统库：

```text
database.sqlite   # 原始采集库
analytics.sqlite  # 分析输出库
```

规则：

- 工作台可只读 `database.sqlite.messages`。
- 工作台不得写 `database.sqlite`。
- 工作台不得修改 `messages` 表结构。
- 工作台不得读取 `analytics.sqlite` 的告警、画像、知识库、日报等分析表。
- 工作台自己的外发、已读、分配、审计数据写入 `workbench.sqlite`。
- 监控 analyzer 后续可以只读 `workbench.sqlite`，但工作台不反向消费 analyzer 结果。

`workbench.sqlite` 核心表应包括：

- `operators`
- `outbound_messages`
- `group_assignments`
- `conversation_reads`
- `agent_actions`
- `send_circuit_breaker`
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
- 工作台 API 直接创建 WA/TG client。
- 工作台浏览器直接操作 WA/TG session。
- 多个进程同时持有同一 WA/TG 账号 session。
- 同一 WA 账号并发 `sendMessage`。

`outbound_messages` 必须支持 `client_msg_id` 幂等：

```text
UNIQUE(created_by, client_msg_id)
```

重复提交时返回已有外发记录，不得重复发送。

## Worker 边界

WA/TG session worker 是唯一真实发送者。

群列表和标签/分组能力按阶段处理：

```text
阶段 1：
- 工作台只读 database.sqlite.messages。
- 从已采集消息中聚合群列表。
- 不修改原监控系统 worker。

阶段 2：
- 如需完整群列表、WA 原生标签、TG 用户号文件夹，再修改 worker。
- 修改范围仅限可选只读同步器。
- 同步结果写入 workbench.sqlite。
```

如果需要修改现有 `social-monitor` worker，必须满足：

- 用环境变量开关控制。
- 默认不开启工作台外发能力。
- 默认不开启完整群列表/标签/分组同步。
- 不影响现有采集逻辑。
- 不影响生产环境。
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
ENABLE_WORKBENCH=1
ENABLE_WORKBENCH_SEND=1
ENABLE_WORKBENCH_LABEL_SYNC=1
ENABLE_WORKBENCH_CHAT_SYNC=1
WORKBENCH_DB_PATH=/path/to/workbench.sqlite
WORKBENCH_OUTBOX_DIR=/path/to/outbox
```

不开启这些开关时，现有 worker 行为必须与改动前一致。

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

开发工作台时，不得默认影响生产监控系统。

禁止在未明确得到用户要求时执行：

- 修改 `ecosystem.cloud.config.js`
- 修改 `docker-entrypoint.sh`
- 开启生产 `ENABLE_WORKBENCH_SEND`
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
- 工作台不重新登录 WA/TG。
- 工作台不写采集库。
- worker 是唯一渠道执行层。

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
2. Workbench API 只读 `messages` 展示群和消息。
3. `channel_labels` 和 `conversation_label_map` 表与模拟数据展示。
4. 两栏 Workbench UI，支持平台、未读、我的群、渠道标签/分组筛选。
5. `outbound_messages` 写入和文件门铃。
6. 本地单测试账号 outbound 消费器。
7. 本地 worker 只读同步 WA 标签和 TG 用户号文件夹。
8. 已读、认领、移交、操作日志。
9. 失败重试、熔断、状态可视化。
10. 监控 analyzer 静默读取工作台数据。

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
工作台只做收、发、分派、已读；
监控系统只做采集、分析、告警、沉淀；
worker 只做渠道 session 和真实发送；
三者协作，但不能互相污染边界。
```
