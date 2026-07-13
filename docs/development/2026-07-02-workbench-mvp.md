# 2026-07-02 客服工作台 MVP 开发记录

## 完成内容

- 新增独立 `workbench` Node/Vue 项目骨架。
- 新增 `workbench.sqlite` schema 和初始化脚本。
- 新增 `/api/workbench/*` Express API。
- 群列表和消息线程只读现有 `database.sqlite.messages`。
- 外发回复写入 `outbound_messages`，支持 `created_by + client_msg_id` 幂等，并写文件门铃。
- 新增已读、认领/移交、取消、重试等作业接口。
- 初版曾采用双栏 IM 界面；2026-07-10 起已迁移为会话、消息、客户资料三列结构。
- 新增 `npm run seed:demo -- <path>`，用于生成脱敏示例采集库做 UI 验收。
- 新增 `npm run seed:demo-workbench -- <path>`，用于生成示例渠道标签和群映射。
- 新增 `lib/outbound-consumer.js`，作为后续 worker 接入真实发送的可选消费核心。
- 新增 `npm run outbound:demo`，可在 `WORKBENCH_SEND_DRY_RUN=1` 时把 pending 外发任务模拟标记为 sent。
- 前端消息线程新增加载更早消息、外发取消、失败原因展示、paused/failed/canceled 重试入口。
- 认领按钮支持当前坐席已认领时释放会话。

## 边界确认

- 未修改现有 `social-monitor` worker。
- 未修改 `database.sqlite` 表结构。
- 未读取 `analytics.sqlite`。
- 未调用 AI、告警、画像、知识库或知识资产模块。
- 未修改生产 PM2 或 Deploy Hub 配置。
- 未接入真实 WA/TG/Teams 发送函数，等待本地测试账号登录确认后再做 worker 侧适配。

## 后续补充：测试账号发送适配

- 已在 `social-monitor` 侧新增 workbench 外发 runtime，并接入本地测试账号 `wa-ceshi_test`、`tgu-laffic_service`。
- 工作台自身仍只负责写入 `outbound_messages` 和 outbox 门铃，真实发送由持有 session 的本地 worker 完成。
- 生产云端配置保持不变；真实发信验证等待本地测试账号登录确认。

## 后续补充：按登录/可见账号过滤

- 工作台后端新增账号范围过滤，默认按 `database.sqlite.accounts` 中已登录状态过滤，也可用 `WORKBENCH_VISIBLE_ACCOUNTS` 显式限制。
- 当前本地 3310 工作台使用 `WORKBENCH_VISIBLE_ACCOUNTS=wa-ceshi_test,tgu-laffic_service`，避免继续展示 demo/旧账号。
- 前端平台按钮改为按后端账号范围渲染；当前只显示 WA/TG，不显示 Teams。
