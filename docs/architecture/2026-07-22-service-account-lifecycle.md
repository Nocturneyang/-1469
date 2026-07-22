# 服务账号生命周期控制

日期：2026-07-22

## 退出登录

账号退出不删除账号级数据库。API 将账号状态写为 `logout_requested`；账号 supervisor 发现该状态后通过现有子进程 IPC 通知对应 runtime worker。worker 在自己的渠道进程内完成注销，清理该账号 session，回写 `logged_out`，释放 lease 并退出。

如果账号当前没有有效 runtime lease（例如处于容量等待），API 可直接清理该账号 session 并回写 `logged_out`。

```text
Workbench API
  -> raw.sqlite status=logout_requested
  -> supervisor IPC account-logout
  -> account runtime client.logout/disconnect
  -> clear account session only
  -> raw.sqlite status=logged_out
  -> release runtime lease and exit
```

退出流程保留：

- `raw.sqlite` 历史消息与账号档案
- `workbench.sqlite` 外发账本、分配、已读、标签和审计
- `runtime.sqlite` 历史运行事件
- 已同步媒体及会话配置

## 彻底删除

彻底删除沿用账号级目录边界，只允许在账号已离线且无有效 runtime lease 时执行。删除目标是 `/data/accounts/{platform}/{account}/` 及该账号对应 outbox，不触碰其他账号或监控项目数据。

API 在删除前再次验证账号 runtime 不活跃；若仍在线返回 `409`，要求先退出登录。前端执行两次确认，并明确该动作会删除全部历史消息和配置。
