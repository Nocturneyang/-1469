# 统一门户与权限体系开发记录

## 背景

生产域名下同时承载监控系统和客服工作台。两者不是互不相干的网站：底层共享 `database.sqlite` 中的原始消息、账号和渠道资源。但共享数据底座不等于共享业务权限，因此本次按“入口权限 + 动作权限 + 数据范围”拆分。

## 实现要点

- `workbench.sqlite` 新增统一 RBAC 表：`access_roles`、`access_permissions`、`access_role_permissions`、`operator_roles`。
- `operator_portal_access` 扩展 `can_admin`，入口权限覆盖监控系统、客服工作台和管理后台。
- 后端统一在登录后注入 `req.access`，管理接口改用具体权限项：
  - `admin:users:manage`
  - `admin:access:manage`
  - `monitor:config:write`
  - `monitor:accounts:manage`
  - `monitor:logs:view`
  - `monitor:assets:write`
  - `monitor:raw:view`
- 工作台仍按 `operator_service_group_scopes` 控制服务账号和分组范围。
- 前端新增 `/admin/roles`、`/admin/permissions`，入口页新增管理后台入口。

## 兼容说明

- 旧本地或 SSO `admin` 角色等效超级管理员。
- `workbench_super_admins`、`WORKBENCH_SUPER_ADMINS` 和默认 `1469/杨杰` 仍有效。
- `/` 仍是监控系统入口，`/monitor` 仅做重定向兼容。

## 验证重点

- 无 `can_monitor` 的用户直接访问监控 API 应返回 403。
- 无 `can_workbench` 的用户直接访问 `/api/workbench/*` 应返回 403。
- 只有 `monitor:view` 的用户不应看到配置、账号、日志和资产写操作入口。
- 只有工作台角色但无服务账号/分组 scope 的用户可以进入工作台，但看不到会话数据。
- 生产部署前必须运行 `npm test` 和 `npm run build`。
