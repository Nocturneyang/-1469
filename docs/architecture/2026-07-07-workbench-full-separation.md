# 工作台彻底独立架构定稿

日期：2026-07-07

## 目标

工作台作为 `social-workbench` 独立上线，不再作为监控项目的页面、权限子模块或 worker 适配层。工作台必须具备自己的登录、存储、权限配置、服务账号接入、前端和部署边界。

## 独立边界

- 独立登录：工作台用户身份由工作台自己的鉴权层处理；公网部署可保留 Deploy Hub SSO 网关，但不沿用监控项目登录态。
- 独立存储：工作台只使用 `/data/db/auth.sqlite`、`workbench.sqlite`、`raw.sqlite`、`runtime.sqlite`。
- 独立权限：`/admin` 只管理工作台坐席、角色、入口权限、服务账号和分组范围。
- 独立前端：工作台不展示监控入口，不复用监控项目路由或页面。
- 独立服务账号登录：`/service-account-login` 发起 WA/TG 登录任务，状态写入 `runtime.sqlite`，账号档案写入 `raw.sqlite`。
- 独立 worker：工作台 runtime worker 消费 `outbox/login-worker-*` 和 `outbox/worker-*`，持有工作台服务账号 session。

## SQLite 分层

```text
auth.sqlite
  工作台用户、登录兼容层、登录审计

workbench.sqlite
  工作台角色、权限、入口权限、服务范围、已读、分配、外发、人工分组

raw.sqlite
  工作台服务账号档案、原始消息、message_observations、channel_account_registry

runtime.sqlite
  服务账号登录任务、runtime events、worker heartbeat、channel sync tasks
```

禁止将上述任一类数据写入监控项目 SQLite，也禁止让多个系统共用同一个 SQLite 文件保存登录或权限数据。

## 服务账号登录流

```text
管理员打开 /service-account-login
-> POST /api/workbench/service-account-logins
-> runtime.sqlite 写 service_account_login_requests
-> raw.sqlite 写服务账号档案
-> outbox/login-worker-{platform}-{account}/request.json
-> 工作台 runtime worker 执行 WA 扫码或 TG token/session 登录
-> worker 回写 runtime.sqlite 状态和 raw.sqlite 账号状态
-> /service-accounts 展示已接入状态
```

工作台 API 只创建登录任务，不在请求线程里长期持有 WA/TG client。真正持有 session 的进程必须是工作台 runtime worker。

## 当前入口

- `/`：工作台主界面
- `/account`：工作台账户设置
- `/service-accounts`：服务账号接入状态
- `/service-account-login`：服务账号登录入口
- `/admin`：工作台权限配置

## 部署约束

- 服务名：`social-workbench`
- 域名：`social-workbench.tyhark.com`
- Deploy Hub 配置：`workbench/.deployhub/`
- 生产数据目录：`/data/db/`
- 平台外层 SSO：`sso: true`

Deploy Hub 的 SSO 是公网网关认证要求，不代表工作台可以复用监控项目登录或权限。工作台应用内仍保持自己的用户、角色、入口权限和服务账号范围。
