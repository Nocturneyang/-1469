# TG 文件夹标题与发送状态修复记录

日期：2026-07-14

## 问题

- Telegram 用户号文件夹同步后，工作台标签名称显示为 `[object Object]`。
- 坐席具备回复权限时，发送框没有明确区分全局发送开关、账号发送开关和账号熔断状态；管理员修改账号发送开关后，当前会话最多需要等待下一轮刷新才更新。

## 根因与修复

- 当前 Telegram TL 层把 `DialogFilter.title` 返回为 `TextWithEntities`，旧实现直接执行 `String(filter.title)`。现在优先读取结构化标题中的 `text`，并在渠道同步存储层增加统一名称归一化兜底。
- 发送框继续同时要求坐席回复权限、生产全局发送开关、账号发送开关和熔断状态全部允许，但会展示精确的禁用原因。
- 管理员修改服务账号发送设置或解除熔断后，账号列表、已加载会话和当前会话立即使用新状态。

## 数据与安全边界

- 不修改 Telegram 原生文件夹，只读同步名称与会话映射。
- 不降低真实发送风控，不绕过全局开关、账号开关或失败熔断。
- 重新执行渠道同步后，现有 `channel_labels` / `service_groups` 会按原文件夹 ID 更新真实名称，无需删除账号或重新登录。

## 验证

- `node --check lib/channel-sync-store.js`
- `node --check workers/account-runtime-worker.js`
- `node tests/account-runtime-worker.test.js`
- `node tests/frontend-composer-contract.test.js`
- `npm test`
- `npm run build`

未使用生产 TG 账号发送测试消息。
