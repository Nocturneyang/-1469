# 客服工作台 MVP 测试记录

日期：2026-07-02

## 命令验证

- `npm test`：通过。覆盖群列表、消息读取、外发幂等、文件门铃、已读和取消外发。
- `tests/outbound-consumer.test.js`：通过。覆盖 pending claim、sent 回写、stale sending 恢复、失败回写、熔断和 paused。
- `npm run build`：通过。Vite 成功生成 `frontend/dist`。
- `node --check scripts/seed-demo-raw-db.js`：通过。
- `node --check scripts/seed-demo-workbench-db.js`：通过。

## 浏览器验证

测试 URL：`http://localhost:3310`

使用脱敏 demo 数据：

- `RAW_MESSAGES_DB_PATH=/private/tmp/workbench-demo-raw.sqlite`
- `WORKBENCH_DB_PATH=/private/tmp/workbench-demo.sqlite`
- `WORKBENCH_OUTBOX_DIR=/private/tmp/workbench-demo-outbox`

验证结果：

- 桌面 1440x900：工作台首屏、群列表、消息线程、回复框和顶部筛选正常。
- 发送回复：创建 `pending` 外发气泡，控制台无错误。
- 外发状态：pending 可取消，failed/paused/canceled 可重试并保留审计链路。
- 移动 390x780：布局纵向堆叠，无横向滚动条。

## 已知警告

`npm run build` 输出两个非阻断警告：

- `@vueuse/core` 中的 `/* #__PURE__ */` 注释位置被 Rolldown 忽略。
- Element Plus 全量打包导致 JS chunk 超过 500 kB。

后续可按需做组件按需导入或拆包优化。
