# WhatsApp Collector Deployment

## 主系统

`social-monitor` App ID 58 只保留 Web/API/DB/分析/调度能力：

- 镜像：`Dockerfile`
- PVC：`/data`，10Gi，ReadWriteMany
- 资源：requests `500m / 1Gi`，limits `2 / 3Gi`
- 部署模板：`.deployhub/k8s/app.yaml`
- 敏感配置：建议通过 `social-monitor-secrets` 注入，例如 `COLLECTOR_TOKEN`、AI Key、钉钉 Webhook
- Deploy Hub 要求 skyline-ark-sso；当前已开启 `sso: true`，后端支持 `/token/userinfo`，前端会通过 `/runtime-config.js` 读取 SSO 配置并在 401 时跳转统一登录页

主系统镜像不安装 Chrome，也不运行 WA worker。

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

## WA Collector

每个 WA 账号一个独立 collector 组件：

- 镜像：`Dockerfile.wa-collector`
- 启动命令：`npm run wa:collector`
- PVC：建议每账号独立 `/data`，2Gi 起步，ReadWriteOnce
- 资源：requests `500m / 1Gi`，limits `2 / 3Gi`
- 必填环境变量：
  - `ACCOUNT_NAME`
  - `COLLECTOR_API_URL`
  - `COLLECTOR_TOKEN`
  - `DATA_DIR=/data`
- 可选但建议保留：
  - `COLLECTOR_OUTBOX_ENABLED=true`
  - `COLLECTOR_OUTBOX_DIR=/data/collector-outbox`
  - `COLLECTOR_OUTBOX_FLUSH_MS=30000`

当主系统 API 短暂不可用时，collector 会把消息、媒体和运行事件写入 outbox，并在恢复后自动补发；心跳和账号状态不进入 outbox，避免旧状态覆盖新状态。

生成 K8s manifest 示例：

```bash
npm run wa:collector:manifest -- \
  --account-name nanya_wa \
  --image your-registry/social-monitor-wa-collector:tag \
  --api-url https://your-social-monitor.example.com \
  --token replace_with_random_collector_token \
  --output /tmp/wa-collector-nanya.yaml
```

## Orchestrator RuntimeAdapter

本地仍使用 PM2：

```bash
WA_RUNTIME_ADAPTER=pm2
```

线上拆分 collector 后，主系统的 `wa-supervisor` 可切到 Kubernetes/Rainbond 适配器：

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

1. 先给主系统配置 `COLLECTOR_TOKEN` 并部署轻量镜像。
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

3. 为试点 WA 账号 `wa_shebi` 部署独立 collector。系统账号 ID 是 `wa-wa_shebi`，collector 环境变量使用 `ACCOUNT_NAME=wa_shebi`。
4. TG 用户号可使用 `Dockerfile.tg-collector` 独立部署。本轮迁移范围只包含 `tgu_supplier` 和 `laffic_service`；`mason_text`、`TG_kaxian` 暂不迁移。
   需要配置 `TG_ACCOUNT_NAME`、`TG_API_ID/TG_API_HASH`、`TG_USER_SESSION_{ACCOUNT}`、`COLLECTOR_API_URL`、`COLLECTOR_TOKEN`。
5. 前端确认账号心跳、消息、媒体路径都能更新。
6. 观察 24 小时后，再逐个迁移其他 WA 账号。
7. 迁移完成后，本地/主系统 PM2 中不再保留已迁移的 `worker-wa-*` / `worker-tgu-*` 进程。

生成 TG 用户号 manifest 示例：

```bash
npm run tg:collector:manifest -- \
  --account-name tgu_supplier \
  --image your-registry/social-monitor-tg-collector:tag \
  --api-url https://your-social-monitor.example.com \
  --token replace_with_random_collector_token \
  --output /tmp/tg-collector-tgu-supplier.yaml
```
