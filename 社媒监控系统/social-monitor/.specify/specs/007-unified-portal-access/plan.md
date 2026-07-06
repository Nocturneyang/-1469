# 技术方案

## 权限模型

- 身份源：生产优先使用现有 SSO，本地 `users` 表仅保留非生产或应急登录。
- 入口权限：`operator_portal_access` 扩展为 `can_monitor`、`can_workbench`、`can_admin` 和 `default_entry`。
- 角色权限：新增 `access_roles`、`access_permissions`、`access_role_permissions`、`operator_roles`。
- 数据范围：沿用 `operator_service_group_scopes` 控制工作台服务账号和分组范围。

## 后端

- `workbench/lib/access-control.js` 维护内置角色、权限项、迁移和绑定方法。
- `workbench/lib/permissions.js` 统一解析旧 admin、工作台超级管理员、operator 角色、权限项和入口权限。
- `server.js` 在 `/api` 登录校验后注入 `req.access`，并按模块挂载：
  - `/api/workbench/*`：要求工作台入口权限。
  - `/api/admin/access-control/*`：要求角色权限管理权限。
  - 监控普通 API：要求监控入口权限。
  - 监控管理 API：要求具体 `monitor:*` 或 `admin:*` 权限。

## 前端

- 路由守卫支持 `meta.requiresPermission`。
- `/entry` 支持监控系统、客服工作台和管理后台三个入口。
- 系统管理菜单按权限项显示。
- 新增 `/admin/roles` 和 `/admin/permissions`。
- 保留 `/admin/workbench-permissions` 作为工作台数据范围配置页。

## 兼容策略

- 旧 `role === 'admin'` 等效 `super_admin`。
- 工作台 `workbench_super_admins` 和环境变量超级管理员继续有效。
- 旧 `/` 监控入口保持不变，新增 `/monitor` 重定向到 `/`。
