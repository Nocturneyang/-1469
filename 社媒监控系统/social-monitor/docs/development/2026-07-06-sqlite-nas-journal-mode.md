# SQLite NAS Journal Mode 调整记录

## 背景

生产环境 analyzer 日志持续出现 `disk I/O error`，但 `/readyz` 中的 `sqlite`、`analytics`、`dataDir`、`storage` 检查均为 `ok`。该现象说明基础文件和数据库探活可以通过，风险更可能出现在多进程 SQLite 运行模式、NAS 挂载或并发写入层。

生产容器 `DATA_DIR=/data` 使用共享 NAS/RWX 存储。SQLite WAL 模式依赖共享内存协调多进程访问，不适合网络文件系统；而当前多个 analyzer、初始化脚本和部分 API writable 连接都会强制执行 `PRAGMA journal_mode = WAL`。

## 调整

- 新增 `lib/sqlite-runtime.js`，统一 SQLite 运行时配置。
- 当 `DATA_DIR=/data` 或 `SQLITE_NAS_MODE=1` 时，默认使用 `DELETE` journal mode。
- 支持 `SQLITE_JOURNAL_MODE` 显式覆盖，支持值：`DELETE`、`TRUNCATE`、`PERSIST`、`MEMORY`、`WAL`、`OFF`。
- 统一设置 `SQLITE_BUSY_TIMEOUT_MS`，默认 `15000ms`。
- 只读连接不再改 journal mode，仅设置 `busy_timeout` 和 `query_only=ON`。
- analyzer、analytics writable API、TG 回溯队列、初始化脚本和归档脚本都改为使用统一 helper。
- 新增 `scripts/configure-sqlite-storage.js`，并在 `docker-entrypoint.sh` 中于 PM2 启动前执行，先由单进程完成 `database.sqlite`、`analytics.sqlite` 的 journal mode 调整，减少 analyzer 并发启动时抢锁。
- 生产 `DATA_DIR=/data` 下，普通运行时连接默认不再尝试修改 journal mode，避免多个 PM2 进程在启动时抢同一 SQLite 文件锁。

## 验证

- `node --check` 覆盖修改过的后端入口、脚本和全部 analyzer。
- `node ../tools/test_sqlite_runtime.js` 通过，验证 `/data` 默认 `DELETE`、显式覆盖、无效值回退和实际 PRAGMA 生效。
- `npm test` 执行结果：249 passed / 2 failed。失败点为既有本地配置校验：
  - `config/account-regions.json`: `tg-account1 found`
  - `lib/staff-detector.js`: `A-Support must be external`

## 后续观察

部署后重点观察 analyzer 日志中是否还出现 `disk I/O error`。如果仍出现，需要进一步排查 NAS 本身稳定性、SQLite 文件是否已有损坏、以及是否存在未纳入主应用代码的外部进程写入同一数据库。
