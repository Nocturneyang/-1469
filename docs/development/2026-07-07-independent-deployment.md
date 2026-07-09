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

## 服务账号登录 worker

2026-07-07 追加：生产环境必须启动 `social-workbench-login-worker`，否则 WA 登录任务只会停留在 `waiting_qr`，不会生成二维码。

- WA：参考监控项目 WA 登录方式，使用 `whatsapp-web.js`、`LocalAuth`、Chromium 和 `qr/authenticated/ready` 事件；二维码写回工作台 `runtime.sqlite` 的 `qr_payload`。
- TG Bot：参考监控项目 TG Bot 登录方式，使用 `node-telegram-bot-api` 调用 `getMe()` 校验 token；token 只通过一次性 outbox 文件交给 worker，处理后删除 outbox 文件。
- TG 用户 Session：参考监控项目 TG 用户号方式，使用 GramJS `TelegramClient + StringSession` 校验 session；需要配置 `WORKBENCH_TG_API_ID` / `WORKBENCH_TG_API_HASH` 或账号专属变量。
- Session 路径独立：WA 使用 `/data/sessions/wa`，TG 使用 `/data/sessions/tg`。
- 状态独立：登录任务写 `runtime.sqlite`，账号档案写 `raw.sqlite`，不写监控项目数据库。

WA 二维码生成失败排查：

- 页面显示 `Protocol error (Target.setDiscoverTargets): Target closed` 时，优先查看 `social-workbench-login-worker` 日志里的 `chromium ready:` 自检输出。
- 如果自检失败，检查生产镜像是否安装 `chromium`，以及 `PUPPETEER_EXECUTABLE_PATH` 是否指向可执行文件。
- 如果自检成功但客户端仍启动失败，检查 `/data/accounts` 或 `/data/sessions` 是否可写、容器是否因内存被重启。
- 需要 Chrome 进程 stderr 时，可临时设置 `WORKBENCH_WA_PUPPETEER_DUMPIO=1`；默认关闭，避免生产日志过噪。
- 默认使用 Puppeteer pipe 连接，避免容器里 DBus stderr 干扰 DevTools endpoint 解析；如需临时切换 websocket，可设置 `WORKBENCH_WA_PUPPETEER_PIPE=0`。

2026-07-08 追加：多账号长期运行应使用账号隔离模式。API/UI 继续作为控制面运行；每个 WA/TG 服务账号启动一个 `account-runtime-worker`，并设置：

```text
WORKBENCH_ACCOUNT_DB_MODE=isolated
WORKBENCH_ACCOUNT_DATA_DIR=/data/accounts
WORKBENCH_WORKER_PLATFORM=wa|tg
WORKBENCH_WORKER_ACCOUNT=<account>
```

账号隔离模式下，登录任务写入 `/data/accounts/{platform}/{account}/runtime.sqlite`，账号档案和 raw 消息写入 `/data/accounts/{platform}/{account}/raw.sqlite`，已读、认领/释放、人工分组、渠道分组映射、外发账本和发送熔断写入 `/data/accounts/{platform}/{account}/workbench.sqlite`，session 写入 `/data/accounts/{platform}/{account}/session/`。总控 `workbench.sqlite` 保留工作台用户、角色、入口权限和服务账号/分组授权范围。

API/UI 在隔离模式下负责跨账号聚合读取：账号列表、会话列表、消息线程、渠道分组和人工分组从各账号库聚合；写入类业务动作只写对应账号库。隔离模式下外发 API 对前端返回 `platform:account:id` 形式的作用域外发 ID，避免多个账号本地自增 ID 冲突。

账号 worker 优先使用账号目录内的 raw/runtime/workbench/session 路径，不因容器全局 `WORKBENCH_RAW_DB_PATH`、`WORKBENCH_RUNTIME_DB_PATH` 或 `WORKBENCH_DB_PATH` 回写全局库。同账号 worker 通过 `account_worker_leases` 续租，防止两个进程同时持有同一渠道 session。

2026-07-08 追加：生产当前没有已登录服务账号，因此可以直接开启 `WORKBENCH_ACCOUNT_DB_MODE=isolated`，不会迁移旧 session。为了避免 API 写入账号 runtime 后单 worker 读不到任务，`social-workbench-login-worker` 已兼容账号隔离模式：非账号专属 worker 会按登录门铃 payload 的 `platform/account` 打开对应账号库和 session 目录。该兼容层适合无账号或少量账号启动阶段；多账号长期运行仍应按账号拆成独立 `account-worker`。

## 部署

新增独立部署材料：

- `Dockerfile`
- `docker-entrypoint.sh`
- `ecosystem.cloud.config.js`
- `.deployhub/deploy.yaml`
- `.deployhub/k8s/app.yaml`

默认服务名为 `social-workbench`，域名为 `social-workbench.tyhark.com`，PVC 为 `social-workbench-sqlite-pvc`。PM2 生产进程包括 API/UI `social-workbench` 和登录执行层 `social-workbench-login-worker`。

## 验证

- `npm test` 通过。
- `npm run build` 通过。
- 临时服务 `/healthz`、`/readyz` 通过。
- 冒烟验证已确认生成四个独立 SQLite 文件：`auth.sqlite`、`raw.sqlite`、`workbench.sqlite`、`runtime.sqlite`。
