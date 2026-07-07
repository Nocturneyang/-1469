# 客服工作台项目说明

客服工作台是独立于监控系统部署的日常 IM 作业系统，用于客服或业务坐席查看 WA/TG 会话、按授权范围回复消息、认领/分配会话，并记录工作台侧的操作数据。

线上服务：

- 工作台域名：https://social-workbench.tyhark.com
- 服务名：`social-workbench`
- 命名空间：`g1469`

## 项目边界

工作台和监控系统已经拆分：

- 工作台负责：SSO 登录后的权限、会话列表、消息线程、回复框、已读、认领、分配、外发账本、人工分组。
- 监控系统负责：采集、分析、告警、日报、知识资产、供应商画像、运营情报。
- 工作台不得读取监控分析库 `analytics.sqlite`。
- 工作台不得调用监控系统的 AI、告警、画像、知识库或分析模块。
- 工作台可以读取原始消息库，但自己的登录、权限和作业数据必须写入工作台自己的 SQLite 文件。

## 数据隔离

工作台生产环境默认使用 `/data/db/` 下的独立数据库：

```text
auth.sqlite       # SSO 超级管理员引导名单、兼容审计表；生产不使用本地密码登录
workbench.sqlite  # 工作台角色、权限、入口权限、服务范围、已读、分配、外发、人工分组
raw.sqlite        # 工作台侧原始消息只读/同步数据
runtime.sqlite    # 工作台运行态数据
```

重要规则：

- 不要把工作台账号、权限或会话作业数据写入监控项目的 SQLite。
- 不要把多个系统的登录信息共用同一个 SQLite 文件。
- 生产登录统一使用 skyline-ark-sso，不使用工作台本地密码登录页。
- SSO 坐席、角色、入口权限和服务账号/分组范围使用 `workbench.sqlite`。

## 主要入口

前端页面：

- `/`：工作台主界面。
- `/admin`：工作台自己的权限配置入口。

后端接口：

- `GET /api/workbench/me`：当前登录用户和权限上下文。
- `GET /api/workbench/groups`：会话列表。
- `GET /api/workbench/groups/:groupId/messages`：消息线程。
- `POST /api/workbench/reply`：创建外发回复任务。
- `GET /api/workbench/admin/access`：权限配置总览。
- `POST /api/workbench/admin/users`：新增 SSO 坐席身份。
- `PUT /api/workbench/admin/users/:id/scopes`：配置服务账号/分组范围。

## 登录与权限

生产环境统一使用 skyline-ark-sso 登录，不提供工作台自己的密码登录页。`1469` 工号默认是工作台超级管理员，可以进入 `/admin` 配置入口权限、角色和服务账号范围。

权限配置入口 `/admin` 可以管理：

- SSO 坐席身份。
- 角色和权限项。
- 入口权限：工作台、监控系统入口、权限配置。
- 服务账号/分组范围：查看、回复、分配、管理。

## 本地运行

进入工作台目录：

```bash
cd /Users/a2026/Desktop/社媒监控/workbench
```

安装依赖后启动：

```bash
npm run dev
```

默认地址：

```text
http://localhost:3310
```

本地默认数据库目录：

```text
workbench/.local-data/db/
```

常用命令：

```bash
npm run build
npm test
npm run init-db
npm run seed:demo
npm run seed:demo-workbench
```

## 部署

Deploy Hub 配置位于：

```text
workbench/.deployhub/deploy.yaml
workbench/.deployhub/k8s/app.yaml
```

当前部署配置：

```yaml
name: social-workbench
domain: social-workbench.tyhark.com
sso: true
```

Deploy Hub 当前要求公网服务必须开启 skyline-ark-sso 外层认证，因此 `sso: true` 是平台部署合规要求。工作台应用不再提供本地密码登录页；SSO 身份、角色、入口权限和服务范围写入 `workbench.sqlite`，不与监控项目共用 SQLite。

部署前建议执行：

```bash
npm run build
npm test
```

## 目录说明

```text
workbench/
├── frontend/                 # Vue 3 + Element Plus 前端
├── server/                   # Express API 和静态前端服务
├── routes/                   # SSO 兼容鉴权路由
├── middleware/               # 工作台鉴权中间件
├── lib/                      # 权限、外发、渠道同步等业务逻辑
├── db/                       # SQLite 路径、schema 和访问层
├── scripts/                  # 初始化、演示数据和工具脚本
├── tests/                    # API 和外发消费测试
├── docs/                     # 设计、开发、测试和交付文档
└── .deployhub/               # 独立部署配置
```

## 开发注意事项

- 优先阅读 `AGENTS.md` 和 `DEVELOPMENT_GUIDE.md`。
- 修改后端行为后运行 `npm test`。
- 修改前端后运行 `npm run build`。
- 不提交 `.env`、SQLite 数据文件、WAL/SHM、本地 session、Token 或本地缓存。
- 不把工作台重新并入监控项目。
- 不让工作台直接持有 WA/TG session；真实发送仍应由渠道 worker 执行。
