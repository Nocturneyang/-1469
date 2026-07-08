# 账号 runtime worker 拆分说明

日期：2026-07-08

## 目标

把服务账号登录执行层和长期账号运行态拆开：

- `social-workbench-login-worker` 只处理 WA/TG 登录任务、二维码/token/session 校验和 session 落盘。
- `social-workbench-account-supervisor` 负责发现已认证且允许采集的账号。
- `account-runtime-worker` 每个账号一个子进程，长期持有该账号的渠道 session。

## 进程关系

```text
PM2
├── social-workbench                  # API/UI
├── social-workbench-login-worker     # 一次性登录和 session 接管
└── social-workbench-account-supervisor
    ├── account-runtime-worker wa:a
    ├── account-runtime-worker wa:b
    └── account-runtime-worker tg:c
```

## 数据边界

每个账号 worker 只打开自己的账号目录：

```text
/data/accounts/{wa|tg}/{account}/raw.sqlite
/data/accounts/{wa|tg}/{account}/runtime.sqlite
/data/accounts/{wa|tg}/{account}/workbench.sqlite
/data/accounts/{wa|tg}/{account}/session/
```

入站消息通过 `upsertRawMessage` 写入账号自己的 `raw.sqlite.messages` 和 `message_observations`。外发账本继续使用账号自己的 `workbench.sqlite.outbound_messages`，文件 outbox 仍只是门铃。

## 启停规则

supervisor 默认只拉起满足以下条件的账号：

- `accounts.status` 或账号注册状态为 `authenticated`、`ready`、`monitoring`、`warmup`、`connected`。
- `channel_account_registry.collect_enabled != 0`。
- `channel_account_registry.workbench_visible != 0`。

可用 `WORKBENCH_ACCOUNT_WORKERS=wa:nanya_wa,tg:ops_bot` 显式指定账号。显式指定会跳过状态筛选，便于排障。

## 外发安全

生产配置默认开启真实外发，登录账号后坐席可以直接在线回复客户：

```text
WORKBENCH_SEND_ENABLED=1
```

新登录的服务账号默认 `send_enabled=1`，账号 worker 会消费 `outbound_messages(status=pending)`，按账号串行调用真实渠道发送。入站采集和群列表同步不依赖这个开关。需要单账号只收不发时，可关闭该账号的 `send_enabled`；需要全局紧急只收不发时，可以把 `WORKBENCH_SEND_ENABLED=0` 后重新部署。账号自身 `send_enabled`、坐席权限和发送熔断仍然是独立保护。

## 第一版范围

已实现：

- WA session 接管、入站消息事件写入、群列表低频同步。
- TG Bot token 接管、polling 入站消息写入。
- TG 用户号 session 接管骨架、NewMessage 入站写入和 dialog 同步。
- 账号 worker 心跳、租约和 runtime 事件。
- supervisor 自动发现、子进程拉起、退出延迟重启。

暂不做：

- Redis、队列系统或新数据库。
- API 线程直接持有 WA/TG client。
- 多账号共享同一个 runtime/raw/workbench 数据库。
- 绕过账号 `send_enabled`、坐席权限或发送熔断。
