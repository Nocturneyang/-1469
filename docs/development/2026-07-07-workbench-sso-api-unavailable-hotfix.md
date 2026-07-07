# 工作台 SSO 直达入口 API 不可用提示修复

## 背景

生产环境直接访问 `/workbench/` 时，工作台页面可以渲染，但右上角持续提示“工作台 API 暂不可用，请检查服务状态”。检查生产接口后发现 `/api/workbench/*` 在未带登录态时返回 `401 Unauthorized`，并非工作台 API 进程不可用。

## 根因

工作台是独立 Vue 构建入口，不会执行主监控前端的 SSO 水合逻辑。用户直接打开 `/workbench/` 时，浏览器本地可能没有 `auth_token` 或 `sso_token`，导致工作台初始化阶段直接请求 `/api/workbench/me`、`/api/workbench/health`、`/api/workbench/groups`，这些请求被主服务 `/api` 鉴权中间件拦截为 401。

## 修复

- 在 `workbench/frontend/src/api.js` 中增加工作台专用 SSO bootstrap：
  - 解析 URL 中的 `token`、`satoken`、`access_token` 并写入 `localStorage.sso_token`。
  - 调用 `/token/userinfo` 水合当前用户，并写入 `auth_token`、`auth_user`、`sso_hydrated_at`。
  - 当 `/api/workbench/*` 返回 401 且生产运行配置启用 SSO 时，跳转 `/auth/sso/start?redirect=<当前地址>`。
- 在 `workbench/frontend/src/App.vue` 启动时先完成认证水合，再加载工作台数据。
- 认证跳转过程中不再展示“工作台 API 暂不可用”，避免把登录态问题误报成服务故障。

## 影响范围

- 仅影响工作台前端入口认证初始化和 401 处理。
- 不修改工作台 API、数据库、外发账本、worker 或监控分析逻辑。
- 不读取 `analytics.sqlite`，不调用 AI、告警、画像、知识库模块。

## 验证

- 执行 `npm run build` 验证工作台前端构建。
- 执行 `npm test` 验证工作台 API 和 outbound consumer 测试。
- 生产部署后验证：
  - 无登录态直接访问 `/workbench/` 应进入统一认证流程。
  - 已登录或带 SSO token 返回 `/workbench/` 后，应正常加载工作台数据。
