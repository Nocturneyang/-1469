# 工作台实时与可靠性升级架构

日期：2026-07-15

## 事件流

`runtime.sqlite.channel_events` 是工作台内部的轻量事件日志，不是消息事实源：

```text
runtime worker / API 写业务数据库
-> 同事务之后记录 channel_event
-> GET /api/workbench/events SSE 按坐席账号范围过滤
-> 前端按事件类型刷新群列表或当前会话
```

事件只包含 `platform`、`account`、`group_id`、`event_type`、时间和轻量元数据。完整消息继续从权限受控 API 读取。客户端通过 SSE `id` 和 `Last-Event-ID` 恢复短时断线；事件保留 24 小时。

现有会话 SSE 暂时保留，作为迁移兼容路径。全局 SSE 稳定后，1.5 秒当前会话轮询和 4 秒群列表轮询降为 30 秒保险。

## 外发账本扩展

`outbound_messages` 增加：

- `provider_ack`
- `read_at`
- `owner_worker_id`
- `lease_expires_at`
- `next_attempt_at`

`outbound_attempts` 记录每一次真实渠道调用，避免自动重试覆盖审计历史。

领取任务必须使用事务内 CAS：

```text
pending + next_attempt_at 到期
-> sending + owner_worker_id + lease_expires_at
-> 建立 outbound_attempts(attempting)
```

发送期间定时续租。租约过期时：

- 已有 `remote_msg_id`：恢复为 `sent`，等待渠道回执。
- 没有 `remote_msg_id`：改为 `paused`，错误码为 `DELIVERY_OUTCOME_UNKNOWN`，不得自动重发。

lease 可以防止多个 Worker 同时领取，但不能消除“渠道已经成功、数据库尚未回写时进程退出”的不可判定窗口，因此该窗口必须人工核对后再显式重试。

## 重试

- 可重试网络错误写回 `pending` 和 `next_attempt_at`，采用带抖动的指数退避。
- 参数、会话、附件和目标不存在等错误直接进入 `dead`。
- Telegram `FloodWait`、`PeerFlood` 继续进入账号级暂停。
- 熔断只统计可归因于渠道、网络和风控的失败，不统计本地参数校验错误。
- 人工重试继续新建外发记录并用 `retry_of` 保留链路。

## 附件

外发附件保存到工作台自己的账号目录：

```text
/data/accounts/{platform}/{account}/attachments/outbound/{yyyy-mm}/{sha256}.{ext}
```

本地对应 `.local-data/accounts/...`。SQLite 只保存相对路径、哈希、MIME、大小和显示名称；worker 发送前必须校验路径仍位于账号目录内。重试复用同一附件文件，不复制 Base64。

## 安全与运行态

- 超级管理员只从工作台数据库和显式环境配置读取，不再内置业务身份。
- 代理身份头必须同时满足启用开关和可信代理 CIDR。
- 本地免登录必须显式开启，生产环境永远拒绝。
- API、登录 Worker、账号 Worker 和 Supervisor 安装统一进程保护。
- 运行异常写入工作台自己的 `runtime_events`；可选 webhook 只发送工作台运行故障，不复用监控项目告警模块。
- SQLite 统一使用 WAL、busy timeout、`synchronous=NORMAL` 和适度自动 checkpoint；在线任务不执行无条件每日 `VACUUM`。

## 可观测性

- `/healthz` 和 `/readyz` 保留现有语义。
- `/metrics` 输出无敏感正文的 Prometheus 文本指标，包括 SSE 连接数、外发队列、失败/暂停数量和 Worker 运行态。
- 日志采用单行 JSON，至少包含 level、process、event、platform、account 和 message。
