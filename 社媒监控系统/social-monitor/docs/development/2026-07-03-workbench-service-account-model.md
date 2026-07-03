# Workbench 服务账号模型改造记录

日期：2026-07-03

## 背景

工作台需要支持多个 WA 个人号和多个 TG Bot。采集账号默认用于监控和分析，不应直接进入客服工作台；工作台只展示服务账号自己的分组、会话和消息。

## 实现摘要

- 新增 `channel_account_registry`，由监控系统帐号管理设置账号用途。
- 新增 `message_observations`，在原始入库层记录多账号对同一 canonical 消息的观测。
- Workbench 新增 `service_groups` 和 `conversation_service_group_map`，将 WA 标签和 TG 分组统一为“分组”。
- WA/TG worker 根据账号用途决定是否启用工作台同步和出站消费。
- TG Bot worker 增加 workbench 文本出站发送 runtime。

## 2026-07-03 权限入口增量

- 新增 workbench 权限模块，SSO/JWT 用户会映射为 operator，生产优先使用 `req.user`，本地独立工作台仍兼容 `x-operator-id`。
- `WORKBENCH_SUPER_ADMINS` 默认包含 `1469`，`workbench_super_admins` 表也会保留 `1469`，用于识别工作台超级管理员。
- 主系统 SSO admin 策略同步识别 `WORKBENCH_SUPER_ADMINS`，因此 `1469` 可以进入账号用途配置和工作台权限配置。
- 新增主系统后台入口 `工作台权限管理`，支持按坐席、服务账号、分组配置 `can_view`、`can_reply`、`can_assign`、`can_manage`。
- Workbench API 对账号列表、分组列表、消息读取、回复、已读、认领、释放、出站取消和重试进行权限收口。
- Workbench UI 根据会话返回的 `permissions` 禁用不可发送、不可认领、不可重试和不可取消的操作。
- Docker 镜像补充复制并安装根目录 `workbench/`，避免主系统权限路由在生产容器中找不到工作台模块。

## 2026-07-03 生产入口权限增量

- 新增 `operator_portal_access` 表，按 SSO operator 配置可访问页面：
  - `can_monitor`：是否允许进入监控系统。
  - `can_workbench`：是否允许进入客服工作台。
  - `default_entry`：默认入口，支持 `auto`、`chooser`、`monitor`、`workbench`。
- `1469` 默认 seeded 为 `can_monitor=1`、`can_workbench=1`、`default_entry=chooser`，登录后进入入口选择页。
- 主系统新增 `/entry` 入口选择页：
  - 同时拥有监控系统和工作台权限时显示两个入口。
  - 仅工作台权限时，SSO 登录后直接跳转 `/workbench/`。
  - 仅监控系统权限时，SSO 登录后进入 `/`。
  - 无任何入口权限时显示未授权提示。
- `工作台权限管理` 页面新增“允许访问页面”配置区，和服务账号/分组权限一起保存，全局生效。
- 监控系统和工作台都提供权限配置入口：
  - 监控系统：`/admin/workbench-permissions`。
  - 工作台：左侧服务账号栏的“权限配置”入口，仅 workbench super admin 可见。
- 生产主服务挂载工作台前端到 `/workbench`，并挂载工作台 API 到 `/api/workbench/*`，不再需要单独暴露 `3310` 给终端用户。
- 主服务 API 权限分层：
  - `/api/workbench/*` 和 `/api/admin/workbench-permissions/*` 只要求 SSO/JWT 登录，再按工作台权限校验。
  - 其他 `/api/*` 监控系统接口必须通过 `can_monitor` 校验。
- Docker 构建阶段使用 `WORKBENCH_BASE_PATH=/workbench/ npm run build` 构建工作台前端，保证生产静态资源路径是 `/workbench/assets/*`。

## 2026-07-03 SSO 退出增量

- 主系统侧边栏点击“退出”时，会标记 `sso_logged_out=1`，清理本地 JWT、SSO token、用户信息和工作台入口权限缓存。
- SSO 模式下退出后进入 `/sso-pending?logged_out=1`，该页面不会自动调用 `/token/userinfo`，避免浏览器仍有 SSO cookie 时立刻静默回登。
- 用户需要点击“打开统一认证”才会清除本地退出标记并跳转 SSO 授权入口。
- 运行时配置新增可选 `SSO_LOGOUT_URL` 与 `SSO_LOGOUT_REDIRECT_PARAM`。如果生产 SSO 提供统一退出地址，系统会优先跳转该地址以清理 SSO 侧会话；未配置时仍会停留在本系统授权等待页。
- Deploy Hub 生产清单已配置 `SSO_LOGOUT_URL=https://skyline-ark-sso.tyhark.com/logout`，登录和退出回跳参数均使用 `redirect`。

## 验证

- `node --check` 已覆盖数据库、账号路由、WA/TG worker、workbench API 与同步模块。
- `workbench` 的 `npm test` 已通过。
- `workbench npm test` 已覆盖超管路径、普通坐席未授权、只读授权和回复授权。
- `social-monitor npm run build` 与 `workbench npm run build` 已通过。
- `social-monitor npm test` 仍有两条历史失败：`tg-account1 found` 与 `A-Support must be external`，与本次工作台权限变更无关。
