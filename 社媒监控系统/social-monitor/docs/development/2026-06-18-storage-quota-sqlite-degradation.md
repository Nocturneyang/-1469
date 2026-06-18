# 生产存储配额与 SQLite 降级处理记录

## 背景

2026-06-18 生产前端在知识资产板块提示 `database disk image is malformed`，同时数据加载明显变慢。

Deploy Hub 日志显示：

- Collector 媒体上传持续报 `Unknown system error -122`
- 多个 analyzer 报 `disk I/O error`
- `knowledge-asset` analyzer 也出现 tick failed

Linux `-122` 通常对应磁盘配额耗尽。SQLite 在持久卷空间不足时可能出现 WAL 写入失败、I/O error，进一步导致读连接看到 `database disk image is malformed`。

## 代码侧处理

- `lib/storage-health.js`：统一存储水位、磁盘配额和 SQLite 存储类错误判断。
- `routes/collector.js`：媒体写入前检查持久化存储水位；低水位时返回 `507 Insufficient Storage`，避免继续写大文件。
- `DISABLE_MEDIA_UPLOAD=1`：生产部署默认关闭媒体落盘，`/api/collector/media` 返回跳过成功；`/api/collector/messages` 会清掉 `has_media/media_path`，防止旧采集器继续写附件引用。
- `routes/analytics.js`：知识资产相关读接口遇到 SQLite I/O/损坏类错误时返回降级空态和 warning，不再把底层错误文案直接暴露到前端。
- `scripts/analytics-schema.sql`：补充知识资产候选池和正式资产库常用筛选/排序索引。
- `scripts/sqlite-health-check.js`：新增只读健康检查脚本。
- `scripts/clear-media-references.js`：新增媒体引用清理脚本，默认 dry-run，带 `--execute` 才会写库。

## 生产应急步骤

1. 先释放持久卷空间，优先清理可再生成或可归档的大文件：

   ```bash
   npm run media:report
   MEDIA_RETENTION_DAYS=30 npm run media:prune -- --include-referenced
   ```

2. 检查库文件和 WAL 状态：

   ```bash
   npm run db:health
   npm run db:health -- --integrity
   ```

3. 若业务确认不保留媒体附件，部署 `DISABLE_MEDIA_UPLOAD=1` 后可清空媒体文件并收尾引用：

   ```bash
   find /data/media -type f -delete
   find /data/media -type d -empty -mindepth 1 -delete
   npm run media:clear-refs
   npm run media:clear-refs -- --execute
   ```

4. 如果 `analytics.sqlite` 损坏且无法恢复，可在备份后重建分析库，再让 analyzers 重新沉淀分析结果：

   ```bash
   npm run db:backup
   node scripts/init-analytics-db.js
   ```

5. 若 `database.sqlite` 损坏，需要优先从最近备份恢复；该库是原始采集库，不应由分析脚本写入或重建覆盖。

## 后续建议

- 生产设置 `MEDIA_RETENTION_DAYS` 并定期执行 `npm run media:prune`。
- 关注 `/readyz` 的 storage 检查，低于水位时先限流/清理媒体，再恢复 analyzer。
- 如持久卷容量长期不足，应扩容 `/data`，否则 SQLite WAL 与媒体文件会继续竞争空间。
