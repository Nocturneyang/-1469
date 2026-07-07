# 工作台独立部署与分库隔离记录

## 目标

工作台作为 `social-workbench` 独立服务部署，不修改监控项目，不读取监控项目 SQLite，不挂载监控项目 `/data`。

## 分库硬约束

工作台不得把登录信息、原始消息、业务动作和运行态混在同一个 SQLite 文件中。当前启动时会分别初始化：

- `auth.sqlite`：本地用户、SSO 管理员、登录审计。
- `raw.sqlite`：渠道原始消息、账号注册、消息观测。
- `workbench.sqlite`：工作台会话操作、已读、分配、人工分组、外发账本。
- `runtime.sqlite`：采集器心跳、运行事件、运行规格、同步任务。

生产路径默认位于 `/data/db/`，本地未设置 `DATA_DIR` 时位于 `workbench/.local-data/db/`。

## 登录

工作台服务自身提供：

- `/runtime-config.js`
- `/auth/sso/start`
- `/auth/sso/logout`
- `/token/userinfo`
- `/api/auth/login`
- `/api/auth/me`

生产优先使用 SSO；本地账号只作为应急兜底。密码哈希存储在 `auth.sqlite`，`JWT_SECRET`、SSO 配置和后续渠道密钥必须放在 K8s/Deploy Hub Secret。

## 部署

新增独立部署材料：

- `Dockerfile`
- `docker-entrypoint.sh`
- `ecosystem.cloud.config.js`
- `.deployhub/deploy.yaml`
- `.deployhub/k8s/app.yaml`

默认服务名为 `social-workbench`，域名为 `social-workbench.tyhark.com`，PVC 为 `social-workbench-sqlite-pvc`。

## 验证

- `npm test` 通过。
- `npm run build` 通过。
- 临时服务 `/healthz`、`/readyz` 通过。
- 冒烟验证已确认生成四个独立 SQLite 文件：`auth.sqlite`、`raw.sqlite`、`workbench.sqlite`、`runtime.sqlite`。
