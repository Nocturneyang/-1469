# 工作台独立部署与分库隔离记录

## 目标

工作台作为 `social-workbench` 独立服务部署，不修改监控项目，不读取监控项目 SQLite，不挂载监控项目 `/data`。

## 分库硬约束

工作台不得把登录信息、原始消息、业务动作和运行态混在同一个 SQLite 文件中。当前启动时会分别初始化：

- `auth.sqlite`：工作台登录兼容层、管理员引导名单和登录审计。
- `raw.sqlite`：渠道原始消息、账号注册、消息观测。
- `workbench.sqlite`：工作台会话操作、已读、分配、人工分组、外发账本。
- `runtime.sqlite`：工作台 runtime worker 心跳、运行事件、服务账号登录任务、同步任务。

生产路径默认位于 `/data/db/`，本地未设置 `DATA_DIR` 时位于 `workbench/.local-data/db/`。

## 登录

工作台服务自身提供：

- `/runtime-config.js`
- `/auth/sso/start`
- `/auth/sso/logout`
- `/token/userinfo`
- `/api/auth/me`

公网入口统一经过 skyline-ark-sso 网关，工作台应用内的坐席身份、角色、入口权限和服务账号范围写入 `workbench.sqlite`。`1469` 工号默认是工作台超级管理员。服务账号登录入口位于 `/service-account-login`，登录任务写入 `runtime.sqlite`，账号档案写入 `raw.sqlite`。`JWT_SECRET`、SSO 配置和后续渠道密钥必须放在 K8s/Deploy Hub Secret 或工作台 runtime worker 的独立安全存储中。

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
