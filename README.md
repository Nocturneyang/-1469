# 客服工作台项目说明

客服工作台是独立部署、独立登录、独立存储、独立权限配置和独立前端的日常 IM 作业系统，用于客服或业务坐席接入 WA/TG 服务账号、查看会话、按授权范围回复消息、认领/分配会话，并记录工作台侧的操作数据。

线上服务：

- 工作台域名：https://social-workbench.tyhark.com
- 服务名：`social-workbench`
- 命名空间：`g1469`

## 项目边界

工作台和监控系统必须彻底拆分：

- 本地唯一工作台项目目录：`/Users/a2026/Desktop/工作台/`。
- 后续所有工作台相关代码、配置、文档、测试、脚本、SQLite、session、outbox、运行缓存和部署材料，都只保存在 `/Users/a2026/Desktop/工作台/` 内。
- `/Users/a2026/Desktop/社媒监控/` 不再保存工作台项目文件，不得在其中重新创建 `workbench/` 目录或工作台数据文件。
- 工作台负责：工作台登录身份、权限、WA/TG 服务账号登录入口、会话列表、消息线程、回复框、已读、认领、分配、外发账本、人工分组。
- 监控系统负责：它自己的采集、分析、告警、日报、知识资产、供应商画像、运营情报。
- 工作台不得读取监控分析库 `analytics.sqlite`。
- 工作台不得调用监控系统的 AI、告警、画像、知识库或分析模块。
- 工作台不得依赖监控项目的登录、权限、前端路由、worker 进程或 SQLite 文件。
- 工作台自己的登录、权限、服务账号、会话和运行态数据必须写入工作台自己的 SQLite 文件。

## 数据隔离

工作台生产环境默认使用 `/data/db/` 下的独立数据库：

```text
auth.sqlite       # 工作台用户登录、SSO 兼容身份和登录审计
workbench.sqlite  # 工作台角色、权限、入口权限、服务范围、已读、分配、外发、人工分组
raw.sqlite        # 工作台自己的服务账号、原始消息和渠道同步数据
runtime.sqlite    # 工作台运行态、服务账号登录任务和 worker 状态
```

重要规则：

- 不要把工作台账号、权限或会话作业数据写入监控项目的 SQLite。
- 不要把多个系统的登录信息共用同一个 SQLite 文件。
- 生产公网仍通过 Deploy Hub 的 skyline-ark-sso 网关认证，但工作台应用内的用户、角色、入口权限和服务账号/分组范围使用工作台自己的 `auth.sqlite` / `workbench.sqlite`。
- 服务账号登录任务使用 `runtime.sqlite` 记录状态，WA/TG session/token 不写入监控项目。

## 主要入口

前端页面：

- `/`：工作台主界面。
- `/account`：当前工作台账户设置。
- `/service-accounts`：WA/TG 服务账号接入状态页。
- `/service-account-login`：工作台自己的 WA/TG 服务账号登录入口。
- `/admin`：工作台自己的权限配置入口。

后端接口：

- `GET /api/workbench/me`：当前登录用户和权限上下文。
- `GET /api/workbench/groups`：会话列表。
- `GET /api/workbench/groups/:groupId/messages`：消息线程。
- `POST /api/workbench/reply`：创建外发回复任务。
- `GET /api/workbench/admin/access`：权限配置总览。
- `POST /api/workbench/admin/users`：新增工作台坐席身份。
- `PUT /api/workbench/admin/users/:id/scopes`：配置服务账号/分组范围。
- `GET /api/workbench/service-account-logins`：服务账号登录任务列表。
- `POST /api/workbench/service-account-logins`：发起 WA/TG 服务账号登录任务。

## 登录与权限

工作台登录和权限是工作台自己的体系。生产公网入口会先经过 Deploy Hub 的 skyline-ark-sso 网关；进入应用后，`1469` 工号默认是工作台超级管理员，可以进入 `/admin` 配置工作台用户、入口权限、角色和服务账号范围。

权限配置入口 `/admin` 可以管理：

- 工作台坐席身份。
- 角色和权限项。
- 入口权限：工作台、权限配置。
- 服务账号/分组范围：查看、回复、分配、管理。

服务账号登录入口 `/service-account-login` 用于在工作台内发起 WA/TG 登录任务：

- WA：创建扫码登录任务，由工作台 `social-workbench-login-worker` 启动独立 `whatsapp-web.js` LocalAuth session，回写二维码和登录状态。
- TG Bot：提交 Bot Token，工作台只在一次性登录任务中交给 `social-workbench-login-worker` 校验，校验成功后写入工作台自己的 TG session 存储。
- TG 用户号：提交或导入 session，`social-workbench-login-worker` 使用工作台自己的 API ID/API Hash 校验，接管后写入工作台自己的运行态/session 存储。

服务账号接入页 `/service-accounts` 用于查看 WA/TG 服务账号状态、用途、发送开关、分组同步和风险等级。服务账号登录任务、状态和账号档案只写入工作台自己的 `runtime.sqlite` / `raw.sqlite`。

## 本地运行

进入工作台目录：

```bash
cd /Users/a2026/Desktop/工作台
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
/Users/a2026/Desktop/工作台/.local-data/db/
```

常用命令：

```bash
npm run build
npm test
npm run init-db
npm run login-worker
npm run seed:demo
npm run seed:demo-workbench
```

本地调试 WA 二维码登录时，需要同时启动 API/UI 和登录 worker，并确保本机可用 Chromium：

```bash
npm run dev
npm run login-worker
```

登录 worker 使用工作台自己的目录：

```text
WORKBENCH_WA_AUTH_DATA_PATH=/Users/a2026/Desktop/工作台/.local-data/sessions/wa
WORKBENCH_TG_SESSION_DIR=/Users/a2026/Desktop/工作台/.local-data/sessions/tg
WORKBENCH_OUTBOX_DIR=/Users/a2026/Desktop/工作台/outbox
```

## 部署

Deploy Hub 配置位于：

```text
/Users/a2026/Desktop/工作台/.deployhub/deploy.yaml
/Users/a2026/Desktop/工作台/.deployhub/k8s/app.yaml
```

当前部署配置：

```yaml
name: social-workbench
domain: social-workbench.tyhark.com
sso: true
```

Deploy Hub 当前要求公网服务必须开启 skyline-ark-sso 外层认证，因此 `sso: true` 是平台部署合规要求。工作台应用内的身份、角色、入口权限、服务账号登录任务和服务范围写入工作台自己的 SQLite，不与监控项目共用 SQLite。

生产容器通过 `ecosystem.cloud.config.js` 同时启动：

- `social-workbench`：API/UI。
- `social-workbench-login-worker`：工作台独立 WA/TG 服务账号登录执行层。

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
├── routes/                   # 工作台鉴权路由
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
- 服务账号登录从工作台页面发起，由工作台运行态 worker 执行；不得依赖监控项目 worker 或监控项目 SQLite。
