# 2026-07-06 生产页面加载、日报汇总与采集器调度止血

## 背景

生产域名 `social-monitor.tyhark.com` 出现页面切换卡顿、数据看板长时间 loading、日报汇总打不开。只读探测显示 `/healthz`、`/`、`/api/*` 均存在 20-50 秒级响应延迟，说明问题不是单个 Vue 页面，而是 UI/API 进程整体处理请求变慢。

## 排查结论

- 生产 Pod 处于 Running 且 ready，无重启。
- 生产日志显示 `GET /analytics/dashboard` 最慢达到 32-48 秒，静态入口 `GET /` 也多次达到 12-19 秒。
- 日志出现 `database is locked`，说明采集库或分析库存在锁竞争。
- `cloud-collector-supervisor` 对尚未产生 heartbeat 的 running 采集器每 30 秒重复 `ensureRuntime()`，导致同一个测试采集器组件反复 apply deployment，并持续写入运行态表。
- 日报接口没有缓存和表缺失降级，表未初始化或查询异常时会直接 500，前端只会停留在 loading/空白感知。

## 本次改动

- `workers/cloud-collector-supervisor.js`
  - 新增 `CLOUD_COLLECTOR_NO_HEARTBEAT_REAPPLY_SECONDS`，默认 600 秒。
  - 对无 heartbeat 的 running 采集器做重新 apply 节流，避免每 30 秒重复部署。

- `routes/analytics.js`
  - 新增 `ANALYTICS_DASHBOARD_CACHE_TTL_MS`，默认 2 分钟。
  - 数据看板 `/api/analytics/dashboard` 对同一 `days` 参数短缓存，减少页面切换重复扫库。
  - 新增 `DAILY_DIGEST_CACHE_TTL_MS`，默认 5 分钟。
  - 日报 `/api/daily-digest` 增加短缓存。
  - 日报表缺失或查询异常时返回稳定空结构，避免页面一直卡在 loading。

## 更新机制确认

- 日报由 `analyzers/daily-digest.js` 每天上海时间 09:00 生成，写入 `analytics.sqlite.daily_digests`。
- 知识资产候选由 `knowledge-asset-analyzer` 按 `KNOWLEDGE_ASSET_SCAN_INTERVAL_MS` 增量扫描，生产当前配置为 120 秒。
- 知识资产各正式板块的页面聚合结果通过日快照缓存，按上海自然日生成，并在每天 00:01 清内存、预热常用快照。

## 后续建议

- 部署后观察慢日志，重点看 `/analytics/dashboard`、`/daily-digest`、`/collector/messages`、`/collector/heartbeat`。
- 清理或停止无效的 `sm-collector-wa-ceshi-test` runtime spec，避免长期处于 no heartbeat。
- 如仍有 10 秒以上全站延迟，应继续拆分采集写入队列，避免 UI 进程直接同步写 SQLite。
