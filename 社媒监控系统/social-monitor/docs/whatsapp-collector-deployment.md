# WhatsApp Collector Deployment

## 主系统

`social-monitor` App ID 58 只保留 Web/API/DB/分析/collector 接收能力：

- 镜像：`Dockerfile`
- PVC：`/data`，10Gi，ReadWriteMany
- 资源：requests `1CPU / 3Gi`，limits `4CPU / 8Gi`
- 部署模板：`.deployhub/k8s/app.yaml`
- 敏感配置：建议通过 `social-monitor-secrets` 注入，例如 `COLLECTOR_TOKEN`、AI Key、钉钉 Webhook
- Deploy Hub 要求 skyline-ark-sso；当前已开启 `sso: true`，后端支持 `/token/userinfo`，前端会通过 `/runtime-config.js` 读取 SSO 配置并在 401 时跳转统一登录页

主系统组件默认不运行 WA worker，也不运行 `wa-supervisor`。镜像中仍包含 Chromium，是为了让同一镜像在本地或独立 collector 角色下复用。

生产环境必须设置：

```bash
LOCAL_WA_RUNTIME_ENABLED=false
COLLECTOR_TOKEN=生产端接收令牌
```

`LOCAL_WA_RUNTIME_ENABLED=false` 会让生产端新增 WA 时只登记账号，不修改生产 PM2，也不在生产 Pod 内启动 Chrome。

### 健康检查

- `/healthz`：进程存活检查，不依赖数据库
- `/readyz`：就绪检查，验证采集库 SQLite、`/data` 可读写和 PVC 剩余容量
- `/api/health`：同 `/readyz`，方便平台或人工查看摘要

K8s Deployment 已配置 `startupProbe`、`readinessProbe`、`livenessProbe`，避免服务未就绪时提前接流量。
默认水位保护为 `STORAGE_MIN_FREE_MB=512` 和 `STORAGE_MIN_FREE_PERCENT=5`，低于任一阈值时 `/readyz` 返回 503，防止继续写入导致 SQLite 或媒体文件损坏。

### 媒体治理

先查看媒体占用和可清理项：

```bash
npm run media:report
```

默认只把超过 `MEDIA_ORPHAN_GRACE_DAYS=7` 的孤儿文件列为可清理项，不会删除仍被 `messages.media_path` 引用的文件。确认报表后再执行：

```bash
npm run media:prune
```

如果未来需要清理仍被消息引用的老媒体，需要显式增加 `-- --include-referenced --retention-days 90`；脚本会删除文件并把对应消息的 `has_media/media_path` 清空。

### SQLite 备份

手动生成一致性备份：

```bash
npm run db:backup
```

查看已有备份：

```bash
npm run db:backup:list
```

清理超过保留期的旧备份默认也是 dry-run：

```bash
npm run db:backup:prune
npm run db:backup:prune -- --execute
```

默认备份目录为 `DATA_DIR/backups`，保留期由 `BACKUP_RETENTION_DAYS=14` 控制。备份使用 SQLite backup API，比直接复制 WAL 模式数据库更稳。

### SSO 环境变量

- `SSO_ENABLED=true`
- `SSO_LOGIN_URL=https://skyline-ark-sso.tyhark.com/login`
- `SSO_USERINFO_URL` 可选；网关注入 `x-user-*` 用户头时可不配置
- `SSO_ADMIN_USERS` 可选；逗号分隔，匹配 SSO 的 id/username/email，用于授予后台管理权限

## 生产轻量主系统

当前 Deploy Hub/Rainbond 使用单镜像模式。根目录 `Dockerfile` 会把主系统、分析器、WA/TG worker、collector 协议、Chromium 运行时都打进同一个镜像。

当前线上策略是生产只跑轻量主系统：

- Rainbond 只启动 `social-monitor` 一个组件。
- 容器内 PM2 启动 `ui-server`、分析器和必要的轻量 TG user worker。
- 生产 PM2 基线不包含 WA worker，不包含 `wa-supervisor`。
- 前端新增 WA 时只在生产数据库登记，真正的 WA Chrome 进程放到本地 collector 机器启动。

根目录 `docker-entrypoint.sh` 会把随镜像发布的 `ecosystem.cloud.config.js` 同步到 `/data/ecosystem.config.js`。每次需要重置线上 PM2 基线时提升 `CLOUD_ECOSYSTEM_VERSION` 默认值；入口脚本会先备份旧配置再覆盖。

镜像入口仍保留 `ACCOUNT_NAME` / `TG_ACCOUNT_NAME` 的单进程分流能力，作为未来硬隔离 collector 的备用方案，但当前 Deploy Hub 配置不再创建独立 collector Deployment。

## 本地 WA Collector

当前 WA 账号在本地机器以 PM2 worker 方式运行，并上报生产 collector API：

- 启动方式：`ecosystem.local-collectors.config.js`
- 默认账号：`nanya_wa`、`wa_oumei2`、`wa_shebi`
- 本地数据：WA session、collector outbox 和本地运行状态文件留在本机 `DATA_DIR`
- 生产数据：消息、媒体、心跳和运行事件通过 `/api/collector/*` 写入生产 SQLite
- WA worker 必填环境变量：
  - `ACCOUNT_NAME`
  - `COLLECTOR_API_URL=https://social-monitor.tyhark.com`
  - `COLLECTOR_TOKEN`，必须与生产端一致

启动本地 collector：

```bash
cd 社媒监控系统/social-monitor
export COLLECTOR_API_URL=https://social-monitor.tyhark.com
export COLLECTOR_TOKEN=生产端接收令牌
npm run wa:collectors:local
npx pm2 save
```

本地 `wa-supervisor` 会记录初始化阶段、Chrome RSS、无 Chrome、重启保护等状态；WA worker 会把心跳同步到生产，因此生产前端仍能看到账号状态和二维码。

### 资源口径

生产不再按 WA Chrome 峰值规划内存。WA Chrome 资源按本地机器规划：

- 3 个 WA 稳态约 `2GB` Chrome RSS。
- 5 个 WA 稳态约 `3GB - 6GB`。
- 单账号异常峰值可能到 `2GB - 3GB`，本地 16GB 机器可承接波动。

不要让同一个 WA 账号在本地和生产同时运行；同一个账号只保留一个有效 Chrome session。

## Orchestrator RuntimeAdapter

本地 collector 使用 PM2：

```bash
WA_RUNTIME_ADAPTER=pm2
WA_PM2_ECOSYSTEM_FILE=ecosystem.local-collectors.config.js
```

如果未来重新采用硬隔离 collector，主系统的 `wa-supervisor` 可切到 Kubernetes/Rainbond 适配器：

```bash
WA_RUNTIME_ADAPTER=k8s
WA_K8S_CLIENT=auto
WA_K8S_NAMESPACE=g1469
WA_K8S_LABEL_SELECTOR=app.kubernetes.io/part-of=social-monitor-wa
WA_K8S_ACCOUNT_LABEL=wa-account
WA_K8S_DEPLOYMENT_PREFIX=wa-collector-
```

`WA_K8S_CLIENT=auto` 会优先使用 Pod 内 ServiceAccount 调 Kubernetes API，失败时再回退到 `kubectl`。主系统部署模板已包含最小 RBAC：只读 pods/deployments，并允许 patch/restart/scale collector Deployment。

collector Deployment 需要带上账号标签，例如：

```yaml
metadata:
  labels:
    app.kubernetes.io/part-of: social-monitor-wa
    wa-account: nanya_wa
```

如果账号名无法直接映射到 Deployment 名，可以配置：

```bash
WA_K8S_DEPLOYMENT_MAP={"nanya_wa":"wa-collector-nanya-wa"}
```

## 迁移顺序

1. 部署生产轻量主系统，确认 `LOCAL_WA_RUNTIME_ENABLED=false` 和 `COLLECTOR_TOKEN` 已配置。
2. 先检查试点账号和 TG 用户号的迁移条件：

```bash
npm run collector:migration:status
```

如需临时传入更大的账号列表，仍可用排除名单防止误迁移：

```bash
npm run collector:migration:status -- \
  --tgu tgu_supplier,laffic_service,mason_text,TG_kaxian \
  --exclude mason_text,TG_kaxian
```

3. 在生产确认没有 `worker-wa-*` 和 `wa-supervisor` 进程。
4. 在本地启动 `ecosystem.local-collectors.config.js`，扫码登录 `nanya_wa`、`wa_oumei2`、`wa_shebi`。
5. 前端确认账号心跳、二维码、消息、媒体路径都能更新。
6. 观察 24 小时后，后续新增 WA 默认写入本地 collector 配置并在本地启动。
