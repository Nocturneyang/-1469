# 2026-07-02 工作台外发 Worker 适配开发记录

## 背景

客服工作台已能把回复写入独立 `workbench.sqlite` 的 `outbound_messages`。本次接入现有本地渠道 worker，让持有 session 的 worker 负责真实发送。

## 本次接入账号

- WhatsApp：本地 PM2 进程 `worker-wa-ceshi_test`，工作台账号标识 `wa-ceshi_test`。
- Telegram 用户号：本地 PM2 进程 `worker-tgu-laffic_service`，工作台账号标识 `tgu-laffic_service`。

## 实现内容

- 新增 `lib/workbench-outbound-runtime.js`，提供环境开关、账号 allowlist、轮询、outbox 文件门铃和生命周期控制。
- `workers/worker-wa.js` 在 ready 后启动工作台外发；断线或认证失败时停止运行时，避免离线消费 pending 任务。
- `workers/worker-tg-user.js` 在 MTProto 连接成功并完成一次 dialogs 探测后启动工作台外发。
- `ecosystem.config.js` 仅为两个本地测试账号添加工作台外发环境变量。
- 首期发送只支持纯文本和可选引用；附件明确返回 `UNSUPPORTED_ATTACHMENT`，由工作台账本记录失败。

## 边界

- 未修改 `ecosystem.cloud.config.js`。
- 未修改 `database.sqlite` 表结构。
- 未读取或写入 `analytics.sqlite`。
- 未调用 AI、告警、画像、知识库或知识资产模块。
- 未启动或重启真实 PM2 worker；真实发信验证等待用户确认账号已登录。
