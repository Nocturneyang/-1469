# WA Web 版本缓存与会话同步恢复测试报告

日期：2026-07-14

## 测试范围

- WA Web 缓存有效期判断
- 过期缓存刷新路径
- 强制获取当前版本
- 显式版本固定与回退优先级
- WA 账号间缓存目录隔离
- 会话同步指数退避和最大等待时间
- CommonJS 语法、全量后端回归和前端生产构建

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `node --check`（Chrome、retry、account worker、login worker、supervisor） | 通过 |
| `node tests/chrome-launch.test.js` | 通过 |
| `node tests/account-runtime-worker.test.js` | 通过 |
| `npm test` | 通过 |
| `npm run build` | 通过 |
| `sh -n docker-entrypoint.sh` | 通过 |

`npm run build` 仅出现 `@vueuse/core` 上游 pure annotation 位置警告，构建产物正常生成，和本次后端修复无关。

## 已验证行为

- 2 小时缓存继续复用。
- 80 小时缓存不再指定旧版本，明确触发 `strict=false` 的在线版本回退。
- `WORKBENCH_WA_WEB_VERSION` 即使与强制刷新同时设置也优先，保证可以回退。
- `WORKBENCH_WA_WEB_CACHE_FORCE_LATEST=1` 忽略新鲜缓存。
- `/accounts/wa/first/session` 与 `/accounts/wa/second/session` 使用不同 `.wwebjs_cache`。
- 默认同步失败等待序列为 30、60、120 秒，最终封顶 600 秒。

## 生产验收待办

- 确认测试账号启动日志显示账号独立缓存目录和实际 WA Web 版本。
- 确认出现 `WA 群列表已同步`。
- 观察至少两个原心跳重试窗口，确认不再每 10 秒输出 `getChats` 错误。
- 确认 Pod Ready、无重启；不发送测试消息、不删除账号 session。
