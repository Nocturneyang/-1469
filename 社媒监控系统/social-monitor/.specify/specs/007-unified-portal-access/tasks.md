# 任务清单

- [x] 新增统一权限定义、角色权限表和 operator 角色绑定表。
- [x] 扩展入口权限为监控、工作台、管理后台三类入口。
- [x] 后端挂载 `req.access`，支持具体权限项校验。
- [x] 工作台 API 增加入口权限校验，保留服务账号/分组数据范围校验。
- [x] 用户管理接口切换到 `admin:users:manage` 兼容旧 admin。
- [x] 新增角色管理和权限项管理 API。
- [x] 前端路由守卫支持 `requiresPermission`。
- [x] 新增 `/admin/roles`、`/admin/permissions` 页面。
- [x] 更新入口页和系统管理菜单。
- [ ] 生产部署前运行 `npm test`、`npm run build` 并确认 SSO 管理员仍可进入管理后台。
