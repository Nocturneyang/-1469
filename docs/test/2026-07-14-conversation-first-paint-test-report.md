# 会话消息首屏加载测试报告

日期：2026-07-14

## 覆盖范围

- 独立账号库按群直接读取消息，并排除同账号下其他群的噪声消息。
- 群列表最近消息可作为首次点击的即时预览。
- 完整历史加载期间有明确进度和骨架状态。
- 真实消息返回后替换预览，保留既有实时刷新、历史翻页和媒体展示行为。
- WA/TG 使用同一优化路径，旧共享库兼容路径不变。
- 首次消息请求不会被 1.5 秒实时刷新判为过期，加载状态能够正常结束。
- 消息与会话资料只读路径不执行账号工作库迁移。

## 自动化验证

- `node --check db/raw-messages.js`
- `node --check lib/account-data-access.js`
- `node --check server/routes/workbench.js`
- `node tests/account-runtime-worker.test.js`
- `node tests/frontend-composer-contract.test.js`

## 结果

- `npm test`：通过。覆盖前端组件、工作台 API、外发状态、账号隔离、账号 runtime worker 和 Chrome 启动检查。
- `npm run build`：通过。Vite 生产构建成功；仅保留第三方 `@vueuse/core` 已知 PURE 注释位置警告，不影响产物。
- `npm run predeploy:check`：通过。包含干净安装、完整测试、生产构建、生产依赖审计、数据库路径边界和部署工作树一致性检查。

## 浏览器验证说明

已按前端调试流程尝试连接带现有登录态的浏览器，但浏览器连接组件在初始化阶段报错，未能进入页面。未使用独立 Playwright 或其他浏览器替代方案；页面行为由组件契约测试、工作台 API 测试、Chrome 启动检查和生产构建覆盖。
