# 客服工作台 MVP 架构说明

> 2026-07-10 更新：当前定稿同时以 `docs/architecture/2026-07-07-workbench-full-separation.md` 和 `docs/architecture/2026-07-10-security-reliability-upgrade.md` 为准。

## 边界

工作台是独立项目，接口统一在 `/api/workbench/*`。它只读自己的 `raw.sqlite`，认证、作业账本和运行态分别写入自己的 `auth.sqlite`、`workbench.sqlite` 和 `runtime.sqlite`；账号隔离模式下每个服务账号还有独立数据库。

工作台不得读取 `analytics.sqlite`，不得调用 AI、告警、画像、知识库或知识资产模块。

## 当前实现

- `db/schema.sql`：创建 `operators`、`outbound_messages`、`group_assignments`、`conversation_reads`、`agent_actions`、`send_circuit_breaker`、`channel_labels`、`conversation_label_map`。
- `db/raw-messages.js`：以只读方式打开 `database.sqlite`，聚合已采集群和消息。
- `server/routes/workbench.js`：实现群列表、消息线程、外发账本、文件门铃、已读和分配接口。
- `frontend/`：Vue 3 + Element Plus 三列 IM 作业界面，第三列为当前会话客户资料。

## 外发流程

```text
POST /api/workbench/reply
-> 写 outbound_messages(status=pending)
-> 写 outbox/worker-{platform}-{account}/{outbound_id}.json 门铃
-> 后续 worker 从 workbench.sqlite 查询 pending 任务并真实发送
```

API 只创建外发任务，不直接登录或调用 WA/TG session；独立账号 runtime worker 是唯一渠道执行层。

## Worker 消费核心

`lib/outbound-consumer.js` 是工作台独立账号 worker 的账本消费核心。

它负责：

- 恢复超时 `sending` 任务。
- 按 `platform + account` 串行 claim `pending` 任务。
- 支持 TG worker 按门铃指定的 `outbound_id` 优先 claim 单条 pending，实现账本化即时派发。
- 调用注入的 `sendMessage(task)`。
- 成功后回写 `sent` 和 `remote_msg_id`。
- 失败后回写 `failed`、`error_code`、`error_message`。
- 5 分钟内失败达到阈值后写入 `send_circuit_breaker(status='cooldown')`，并将后续 `pending` 任务置为 `paused`。

它不负责：

- 创建 WA/TG session。
- 在 API 进程中直接 import 或持有渠道 client。
- 自动开启生产外发。

真实发送者只允许是持有工作台渠道 session 的账号 worker。全局和账号发送开关均默认关闭。

平台发送语义：

- WA：账本化串行队列。门铃只唤醒 worker，worker 仍按账号 FIFO 消费，保持低频、单账号串行和风控优先。
- TG：账本化即时派发。门铃中的 `outbound_id` 可让 TG worker 优先发送指定消息，避免被同账号旧 pending 队列挡住；但仍不能绕过发送开关、熔断、`next_attempt_at`、lease、审计和失败恢复。

## 本地测试账号适配

真实渠道验证只允许使用工作台自己的测试账号和账号隔离库。不得读取或依赖监控项目的 worker、session 或 SQLite。

## 账号范围过滤

工作台 API 支持账号范围过滤，避免前端展示未登录、未接入或 demo 数据账号。

优先级：

1. `WORKBENCH_VISIBLE_ACCOUNTS`
2. `WORKBENCH_SEND_ACCOUNTS`
3. 工作台 `raw.sqlite.accounts` 中状态为 `authenticated`、`ready`、`warmup`、`monitoring` 的账号
4. 若无账号状态表，则退回全量历史消息兼容模式

账号列表、群列表、标签、消息读取、回复、已读、客户资料、取消和重试都应使用同一账号范围。

本地 dry-run 验证脚本：

```bash
WORKBENCH_SEND_DRY_RUN=1 WORKBENCH_DB_PATH=/path/to/workbench.sqlite npm run outbound:demo -- wa nanya_wa
```
