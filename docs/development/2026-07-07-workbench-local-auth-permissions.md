# 工作台 SSO 登录与权限配置入口

日期：2026-07-07

## 背景

工作台已从监控项目拆分为独立部署项目。生产环境统一使用 skyline-ark-sso 登录，工作台不再提供自己的密码登录页。SSO 坐席身份、角色、入口权限和服务账号范围必须使用工作台自己的 SQLite 文件，不得写入或依赖监控项目的 SQLite。

## 实现边界

- SSO 坐席身份和权限配置存储在 `workbench.sqlite`。
- `auth.sqlite` 仅保留 SSO 超级管理员引导名单和兼容审计表；生产不使用本地密码登录。
- 管理 API 挂在 `/api/workbench/admin/*`，由工作台自己的 `can_admin` 权限保护。
- 前端不再提供工作台密码登录页，未登录或 401 统一回到 SSO。
- 前端 `/admin` 提供权限配置入口，可添加 SSO 坐席、配置角色、入口权限和服务账号/分组范围。
- Deploy Hub 当前要求公网服务必须开启 skyline-ark-sso 外层认证，因此部署配置保持 `sso: true`；应用 API 由 SSO token 鉴权保护。

## 首次管理员

`1469` 工号默认是工作台超级管理员，服务启动时会写入 `workbench_super_admins`、`operators`、`operator_portal_access` 和 `operator_roles`，可直接进入 `/admin` 管理工作台权限。
