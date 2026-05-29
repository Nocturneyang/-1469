# WhatsApp Collector Deployment

## 主系统

`social-monitor` App ID 58 只保留 Web/API/DB/分析/调度能力：

- 镜像：`Dockerfile`
- PVC：`/data`，10Gi，ReadWriteMany
- 资源：requests `500m / 1Gi`，limits `2 / 3Gi`
- 部署模板：`.deployhub/k8s/app.yaml`
- 敏感配置：建议通过 `social-monitor-secrets` 注入，例如 `COLLECTOR_TOKEN`、AI Key、钉钉 Webhook
- Deploy Hub 要求 skyline-ark-sso；当前已开启 `sso: true`，后端支持 `/token/userinfo`，前端会通过 `/runtime-config.js` 读取 SSO 配置并在 401 时跳转统一登录页

主系统组件不运行 WA worker；镜像中包含 Chromium，是为了让同一镜像也能作为 WA collector 组件启动。

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

## 单镜像单组件多进程

当前 Deploy Hub/Rainbond 使用单镜像模式。根目录 `Dockerfile` 会把主系统、分析器、WA/TG worker、collector 协议、Chromium 运行时都打进同一个镜像。

当前线上策略是不依赖 Rainbond 管理端启动每个账号组件：

- Rainbond 只启动 `social-monitor` 一个组件。
- 容器内由 PM2 启动 `ui-server`、分析器、`wa-supervisor`、WA worker、TG user worker。
- 前端新增或重登账号时，后端继续修改 `/data/ecosystem.config.js` 并调用 PM2 启动进程。

根目录 `docker-entrypoint.sh` 会把随镜像发布的 `ecosystem.cloud.config.js` 同步到 `/data/ecosystem.config.js`。每次需要重置线上 PM2 基线时提升 `CLOUD_ECOSYSTEM_VERSION` 默认值；入口脚本会先备份旧配置再覆盖。

镜像入口仍保留 `ACCOUNT_NAME` / `TG_ACCOUNT_NAME` 的单进程分流能力，作为未来硬隔离 collector 的备用方案，但当前 Deploy Hub 配置不再创建独立 collector Deployment。

## WA Worker

当前线上 WA 账号在 `social-monitor` 组件内以 PM2 worker 方式运行：

- 镜像：与主系统相同的单镜像
- 启动方式：`ecosystem.cloud.config.js` 或前端动态写入 `/data/ecosystem.config.js`
- PVC：共用主系统 `/data`，用于 SQLite、媒体、WA session、PM2 配置
- 当前主组件资源：requests `1CPU / 3Gi`，limits `4CPU / 8Gi`
- WA worker 必填环境变量：
  - `ACCOUNT_NAME`
  - `DATA_DIR=/data`，由入口脚本统一设置
  - `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`

PM2 和 `wa-supervisor` 仍然会记录心跳、初始化阶段、Chrome RSS、无 Chrome、重启保护等状态。区别只是运行位置从 Rainbond 独立组件改回同一个 Pod 内部。

### 长期资源口径

如果坚持不通过管理端启动账号组件，长期 5 个以上 WA 账号就需要把 `social-monitor` 这个唯一组件整体扩容：

- 当前 1 个 WA + 2 个 TG：requests `1CPU / 3Gi`，limits `4CPU / 8Gi`。
- 3 个 WA + 2 个 TG：建议 requests `2CPU / 8Gi`，limits `6CPU / 16Gi`。
- 5 个 WA + 2 个 TG：建议 requests `3CPU / 12Gi`，limits `8CPU / 24Gi`。
- 节点可用内存建议不低于 `32Gi`，给系统、镜像缓存、SQLite、媒体处理和 Chrome 峰值留余量。

这种模式的好处是前端可以直接新增、扫码、重登，不再卡 Rainbond 组件启动；代价是多个 Chrome 共享同一个 Pod 内存上限，某个账号异常膨胀时仍可能影响主系统。因此必须保留 `wa-supervisor` 的串行初始化、RSS 巡检和重启保护。

## Orchestrator RuntimeAdapter

本地仍使用 PM2：

```bash
WA_RUNTIME_ADAPTER=pm2
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

1. 部署单镜像单组件版本，确认 `social-monitor` Pod 资源不低于当前账号规模。
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

3. 试点 WA 账号 `wa_shebi` 由 `ecosystem.cloud.config.js` 直接启动，系统账号 ID 是 `wa-wa_shebi`。
4. TG 用户号本轮只启动 `tgu_supplier` 和 `laffic_service`；`mason_text`、`TG_kaxian` 暂不迁移。
5. 前端确认账号心跳、消息、媒体路径都能更新。
6. 观察 24 小时后，再逐个通过前端新增或重登其他 WA 账号。
