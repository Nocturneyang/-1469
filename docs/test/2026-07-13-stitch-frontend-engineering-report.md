# Stitch 前端设计稿工程化验收记录

日期：2026-07-13

## 变更范围

- 将 Social Workbench Stitch 设计稿落到现有 Vue 3 工程。
- 改造主工作台导航、顶部筛选、会话列表、消息线程、回复框和会话处理栏。
- 保留现有 API、权限、服务账号、消息状态、标签、备注与协作动态接线。
- 回复框收敛为文本、附件、发送按钮和当前发送账号提示。

## 自动化结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run build` | 通过 | Vite 生产构建完成，产物写入 `frontend/dist/` |
| `npm test` | 通过 | API、outbound consumer、账号隔离、runtime worker、Chrome 启动逻辑测试通过 |
| 禁止能力文本扫描 | 通过 | `frontend/src/` 未出现 AI、监控分析、知识库、自动化或建议回复入口 |
| Element Plus 全局组件注册检查 | 通过 | `el-popover` 已由 `ElPopover` 注册，标签编辑器仅以浮层方式出现 |

构建过程中 Rolldown 对第三方 `@vueuse/core` 的 `#__PURE__` 注释给出忽略提示，不影响构建成功或运行产物。

## 边界确认

- 未修改工作台 API 路径、SQLite schema、登录流程或 runtime worker。
- 未访问或修改 `/Users/a2026/Desktop/社媒监控/`。
- 未启用真实渠道外发或生产账号。

## 中间栏视觉回归修复

- 修复 `ElPopover` 未注册导致工作台标签编辑器以内联元素撑高线程头部的问题。
- 线程头部按设计稿收敛为 56px 单行结构：群名、渠道、发送账号、标签与编辑入口同层展示。
- 会话处理栏头部同步为 56px，保证中栏与右栏分隔线对齐。
- 新增 `tests/frontend-component-registration.test.js`，防止已使用的全局 Element Plus 浮层组件漏注册。
