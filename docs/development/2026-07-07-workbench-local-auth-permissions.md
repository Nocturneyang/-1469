# 工作台登录与权限配置入口

日期：2026-07-07

## 背景

工作台已从监控项目拆分为独立部署项目。公网部署保留 skyline-ark-sso 网关认证，但工作台应用内的坐席身份、角色权限、服务账号登录任务和服务账号范围必须使用工作台自己的 SQLite 文件，不得写入或依赖监控项目的 SQLite。

## 实现边界

- 工作台坐席身份和权限配置存储在 `workbench.sqlite`。
- `auth.sqlite` 保存工作台登录兼容层、超级管理员引导名单和登录审计。
- 管理 API 挂在 `/api/workbench/admin/*`，由工作台角色包含的 `admin:*` 权限保护。
- 前端 `/account` 提供当前工作台账户设置入口。
- 前端 `/service-accounts` 提供服务账号接入状态页。
- 前端 `/service-account-login` 提供 WA/TG 服务账号登录入口；登录任务写入 `runtime.sqlite` 并交给工作台 runtime worker。
- 前端 `/admin` 提供权限配置入口，可添加工作台坐席、配置角色和服务账号/分组范围。
- 页面入口由角色权限自动派生，不再单独配置；同时具备多个入口时默认进入工作台。
- 当前坐席详情卡提供“保存当前账户”，事务化保存该账户的资料、角色和服务账号/分组范围。
- “角色权限项”是全局配置，使用独立按钮保存，不随当前账户一起提交。
- 切换坐席时若当前账户存在未保存修改，前端必须先提示确认。
- Deploy Hub 当前要求公网服务必须开启 skyline-ark-sso 外层认证，因此部署配置保持 `sso: true`；应用 API 由 SSO token 鉴权保护。

## 首次管理员

`1469` 工号默认是工作台超级管理员，服务启动时会写入 `workbench_super_admins`、`operators` 和 `operator_roles`，可直接进入 `/admin` 管理工作台权限。`operator_portal_access` 仅保留为历史兼容表，不再作为页面入口授权来源。
