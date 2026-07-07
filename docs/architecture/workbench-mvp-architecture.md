# 客服工作台 MVP 架构说明

## 边界

工作台是独立项目，接口统一在 `/api/workbench/*`。它只读现有采集库 `database.sqlite.messages`，自己的已读、分配、外发和审计数据写入 `workbench.sqlite`。

工作台不得读取 `analytics.sqlite`，不得调用 AI、告警、画像、知识库或知识资产模块。

## 当前实现

- `db/schema.sql`：创建 `operators`、`outbound_messages`、`group_assignments`、`conversation_reads`、`agent_actions`、`send_circuit_breaker`、`channel_labels`、`conversation_label_map`。
- `db/raw-messages.js`：以只读方式打开 `database.sqlite`，聚合已采集群和消息。
- `server/routes/workbench.js`：实现群列表、消息线程、外发账本、文件门铃、已读和分配接口。
- `frontend/`：Vue 3 + Element Plus 两栏 IM 作业界面。

## 外发流程

```text
POST /api/workbench/reply
-> 写 outbound_messages(status=pending)
-> 写 outbox/worker-{platform}-{account}/{outbound_id}.json 门铃
-> 后续 worker 从 workbench.sqlite 查询 pending 任务并真实发送
```

当前版本只创建外发任务，不直接登录或调用 WA/TG/Teams session。

## Worker 消费核心

新增 `lib/outbound-consumer.js`，作为后续接入现有 `social-monitor` worker 的共享账本消费核心。

它负责：

- 恢复超时 `sending` 任务。
- 按 `platform + account` 串行 claim `pending` 任务。
- 调用注入的 `sendMessage(task)`。
- 成功后回写 `sent` 和 `remote_msg_id`。
- 失败后回写 `failed`、`error_code`、`error_message`。
- 5 分钟内失败达到阈值后写入 `send_circuit_breaker(status='cooldown')`，并将后续 `pending` 任务置为 `paused`。

它不负责：

- 创建 WA/TG/Teams session。
- 直接 import `whatsapp-web.js`、GramJS 或 Teams Graph client。
- 自动开启生产外发。

真实发送者仍应是持有渠道 session 的现有 worker。接入时由 worker 注入真实 `sendMessage` 函数，并保持环境变量默认关闭。

## 本地测试账号适配

`social-monitor` 已新增 `lib/workbench-outbound-runtime.js`，作为现有 worker 与 workbench consumer 之间的适配层。运行时必须同时满足：

- `ENABLE_WORKBENCH=1`
- `ENABLE_WORKBENCH_SEND=1`
- `WORKBENCH_SEND_ACCOUNTS` 包含当前账号标识

首批本地测试账号：

- `worker-wa-ceshi_test` 消费 `platform=wa, account=wa-ceshi_test`
- `worker-tgu-laffic_service` 消费 `platform=tg, account=tgu-laffic_service`

WA worker 在 ready 后启动外发，断线或认证失败时停止外发。TG 用户号 worker 在 MTProto 连接成功后启动外发。首期真实发送只支持纯文本；附件由 worker 明确失败并交给 workbench 账本记录。

## 账号范围过滤

工作台 API 支持账号范围过滤，避免前端展示未登录、未接入或 demo 数据账号。

优先级：

1. `WORKBENCH_VISIBLE_ACCOUNTS`
2. `WORKBENCH_SEND_ACCOUNTS`
3. `database.sqlite.accounts` 中状态为 `authenticated`、`ready`、`warmup`、`monitoring` 的账号
4. 若无账号状态表，则退回全量历史消息兼容模式

账号列表、群列表、标签、消息读取、回复、已读、认领、取消和重试都应使用同一账号范围。

本地 dry-run 验证脚本：

```bash
WORKBENCH_SEND_DRY_RUN=1 WORKBENCH_DB_PATH=/path/to/workbench.sqlite npm run outbound:demo -- wa nanya_wa
```
