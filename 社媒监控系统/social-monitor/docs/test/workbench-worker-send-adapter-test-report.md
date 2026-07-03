# 工作台外发 Worker 适配测试报告

日期：2026-07-02

## 验证命令

- `node --check lib/workbench-outbound-runtime.js`：通过。
- `node --check workers/worker-wa.js`：通过。
- `node --check workers/worker-tg-user.js`：通过。
- `node --check ecosystem.config.js`：通过。
- `node ../tools/test_workbench_outbound_runtime.js`：通过。
- `workbench npm test`：通过。首次在沙箱内因 `127.0.0.1` listen 权限失败，提升为本地测试权限后通过。

## PM2 重启验证

用户确认两个本地测试账号已登录后，执行：

- `npx pm2 restart ecosystem.config.js --only worker-wa-ceshi_test,worker-tgu-laffic_service --update-env`

结果：

- `worker-tgu-laffic_service`：PM2 状态 online，日志显示 `Connected as: 客服-Momo` 和 `[WorkbenchOutbound:tgu:laffic_service] enabled`。
- `worker-wa-ceshi_test`：PM2 状态 online，日志显示 `Logged in as: Mason and ready` 和 `[WorkbenchOutbound:wa:ceshi_test] enabled`。

## 工作台账号范围验证

发现问题：本地 `http://127.0.0.1:3310` 工作台仍连接 `/private/tmp/workbench-demo-raw.sqlite`，前端显示 `nanya_wa`、`jason_tg`、`lily_teams` 等 demo/旧账号。

处理结果：

- 工作台后端新增账号范围过滤，默认可按 `database.sqlite.accounts` 登录状态过滤，也支持 `WORKBENCH_VISIBLE_ACCOUNTS` 显式指定。
- 当前 3310 工作台已由 PM2 以真实采集库启动：
  - `RAW_MESSAGES_DB_PATH=/Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor/db/database.sqlite`
  - `WORKBENCH_VISIBLE_ACCOUNTS=wa-ceshi_test,tgu-laffic_service`
- `/api/workbench/health` 返回 `account_scope.mode=explicit`，账号范围为 `wa-ceshi_test` 和 `tgu-laffic_service`。
- 浏览器验证：顶部平台只显示 `WA`、`TG`，不再显示 `Teams`；会话列表不再包含 `nanya_wa`、`jason_tg`、`lily_teams`。
- 当前真实采集库中 `tgu-laffic_service` 有会话数据，`wa-ceshi_test` 暂无入库会话，所以列表目前显示 TG 会话；WA 有消息入库后会自动显示。

## social-monitor 回归

命令：`npm test`

结果：未通过，249 passed、2 failed、251 total。

失败项：

- `config/account-regions.json`：`direct key lookup works (no double prefix)`，期望 `tg-account1 found`。
- `lib/staff-detector.js`：`external: A-Support (support keyword removed)`，期望 `A-Support must be external`。

这两个失败点与本次新增的 workbench 外发 runtime、WA/TG worker 接入和 PM2 测试账号开关无直接关联。本次未修改账号区域配置或员工识别规则。

## 未执行项

- 未做真实渠道发信验证。

原因：等待从工作台选择测试会话并发送一条可核验的测试回复。
