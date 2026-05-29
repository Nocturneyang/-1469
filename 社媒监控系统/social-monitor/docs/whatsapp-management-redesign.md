# WhatsApp 多账号长期在线管理体系重设计

## 背景

当前 WhatsApp 采集采用 `每账号一个 PM2 worker + 一个独立 Puppeteer Chrome` 的模式。这个模式在 1-3 个账号时简单直接，但当 5 个以上账号长期在线时，Chrome 子进程会成为主要内存来源。PM2 看到的 Node 进程内存只有几十 MB，无法真实反映每个账号背后的 Chrome renderer、network、storage 等子进程 RSS。

已观察到的问题：

- 多个账号同时常驻时，Chrome 子进程总 RSS 可超过 10GB。
- 单账号可能膨胀到 3-5GB。
- `max_memory_restart` 主要约束 Node 主进程，不能可靠约束 Chrome 子进程。
- 初始化时出现 `Runtime.callFunctionOn timed out`、`Execution context was destroyed`，并引发重启风暴。
- 账号状态仍显示在线或 QR，但消息已经不再写入本地 SQLite，前端因此没有更新。
- worker 中 user-agent 固定为 Chrome 122，但 Puppeteer 实际启动的 Chrome for Testing 可能已经是 146 系列，存在版本指纹错位。

## 设计目标

1. 支持 5 个以上 WhatsApp 账号长期在线。
2. 每个账号资源可观测、可限额、可重启，不依赖人工看 PM2 表面内存。
3. Chrome 启动版本、user-agent、webVersionCache 有统一管理。
4. 账号启动不再全量并发，按容量调度、分批上线。
5. 单账号异常不拖垮整机，也不影响其他平台采集和前端服务。
6. 前端能展示真实在线状态、最后消息时间、Chrome 内存、重启原因。

## 总体架构

建议拆成四层：

```text
Web/API
  |
  | 账号增删、登录、状态、资源视图
  v
WA Supervisor
  |
  | 调度、容量控制、健康检查、重启策略、版本检查
  v
WA Worker Pool
  |
  | 每账号一个 worker，每 worker 一个隔离 Chrome profile
  v
Chrome Runtime
  |
  | Puppeteer Chrome for Testing，统一启动参数和版本
  v
SQLite / Analytics / Frontend
```

## 进程模型

保留 `每账号一个 worker`，但不再让 PM2 直接成为账号管理的唯一控制面。

推荐进程：

- `wa-supervisor`：常驻管理进程，负责账号启动队列、资源监控、健康检查和 PM2 操作。
- `worker-wa-{account}`：实际采集进程，每账号独立 session、独立 Chrome。
- `ui-server`：只负责 API 和前端，不参与 Chrome 生命周期。

不建议把多个账号塞进同一个 Node 进程。WhatsApp Web 和 Puppeteer 的 session、页面、浏览器上下文长期运行后容易互相影响；隔离进程更利于故障恢复。

## 容量分组

引入 `config/wa-accounts.json`，把账号从 `ecosystem.config.js` 中抽象出来：

```json
{
  "capacity": {
    "maxOnlineAccounts": 5,
    "maxStartingAccounts": 1,
    "maxChromeRssMbPerAccount": 1800,
    "maxChromeRssMbTotal": 9000
  },
  "accounts": [
    {
      "id": "nanya_wa",
      "enabled": true,
      "priority": 100,
      "region": "南亚",
      "business_sector": "routing",
      "startWindow": "always"
    }
  ]
}
```

含义：

- `maxOnlineAccounts`：本机最多同时在线账号数。
- `maxStartingAccounts`：同时初始化 Chrome 的账号数，建议固定为 1。
- `maxChromeRssMbPerAccount`：单账号 Chrome 子进程 RSS 上限。
- `maxChromeRssMbTotal`：整机 WA Chrome RSS 总上限。
- `priority`：资源不足时保留高优先级账号。
- `enabled`：账号是否由 supervisor 接管。

## 启动调度

`wa-supervisor` 应按以下状态机管理账号：

```text
disabled -> queued -> starting -> qr_waiting -> authenticated -> healthy
                                             \-> degraded -> restarting
                                             \-> failed -> backoff
```

调度规则：

- 启动前检查总 Chrome RSS 是否低于阈值。
- 同一时间只允许一个账号处于 `starting`。
- 每个账号启动后，等待 `ready` 或 `qr` 再释放启动槽。
- 启动失败进入指数退避，避免反复抢锁。
- 重启账号时先杀该账号 Chrome 子进程，再启动 worker。
- 低优先级账号可被暂停，保证核心账号在线。
- 单账号初始化硬超时后进入短冷却，避免坏 session 反复抢占全局启动锁。

## Chrome 启动参数基线

所有 WA worker 应使用统一的 Chrome 启动配置，建议移动到 `lib/wa-chrome-runtime.js`。

建议基线参数：

```js
[
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  '--renderer-process-limit=4',
  '--process-per-site',
  '--disable-site-isolation-trials',
  '--mute-audio',
  '--no-first-run'
]
```

注意：

- `--renderer-process-limit` 可以降低子进程数量，但过低可能影响 WhatsApp Web 稳定性，建议从 4 开始。
- 不建议使用 `--single-process`，长期运行稳定性较差。
- 不建议多个账号共享同一个 `userDataDir`。

## Chrome 版本管理

当前 `package.json` 中 `postinstall` 会执行：

```bash
npx puppeteer browsers install chrome
```

长期方案应改成显式版本管理：

1. 启动前执行 `npx puppeteer browsers install chrome`，确保 Puppeteer 推荐 Chrome 已安装。
2. worker 启动时记录实际 `browser.version()`，写入账号运行状态。
3. user-agent 不再硬编码 Chrome 122，应根据实际 Chrome major 动态生成。
4. 新增 `npm run chrome:install` 和 `npm run chrome:version`。
5. 升级 `puppeteer` 后，先在单个低优先级账号灰度，再全量滚动重启。

建议状态字段：

```sql
ALTER TABLE accounts ADD COLUMN chrome_version TEXT;
ALTER TABLE accounts ADD COLUMN chrome_rss_mb INTEGER;
ALTER TABLE accounts ADD COLUMN last_message_at INTEGER;
ALTER TABLE accounts ADD COLUMN last_restart_reason TEXT;
ALTER TABLE accounts ADD COLUMN health_status TEXT;
```

## WhatsApp Web 版本缓存

当前 worker 会扫描 `.wwebjs_cache` 并使用本地 HTML 缓存。建议调整为：

- 缓存记录版本号、创建时间、来源。
- 缓存超过 24-48 小时后标记为 stale。
- 当多个账号同时启动时，只有 supervisor 负责刷新缓存。
- 若远程 WhatsApp Web 变更导致注入失败，允许一键清理缓存并重新抓取。

建议新增命令：

```bash
npm run wa:web-version:refresh
npm run wa:web-version:clear
```

## 健康检查

每个账号至少监控：

- PM2 worker 状态。
- Chrome 子进程数量。
- Chrome 子进程总 RSS。
- 最近 `ready` 时间。
- 最近消息写入时间。
- 最近二维码更新时间。
- 最近初始化失败原因。
- 最近 `disconnected` / `auth_failure` 原因。

判定建议：

- `healthy`：authenticated 且最近有心跳。
- `idle`：authenticated 但长时间无群消息，仍能执行轻量探测。
- `degraded`：Chrome RSS 超阈值、消息长时间无更新、或 Puppeteer 调用超时。
- `qr_required`：等待扫码。
- `failed`：多次初始化失败或 session 损坏。

## 自动恢复策略

按风险从低到高：

1. `soft probe`：调用轻量 API 检查 client 是否可用。
2. `soft restart`：PM2 restart worker。
3. `chrome reap`：杀该账号 Chrome 子进程，保留 LocalAuth session。
4. `session repair`：清理锁文件和临时缓存。
5. `auth reset`：清 LocalAuth，要求重新扫码，仅人工触发。

自动策略必须避免直接清 session。清 session 会导致账号需要重新扫码，应该作为人工确认操作。

## PM2 配置策略

`ecosystem.config.js` 不再手工堆账号。建议只保留 supervisor、server、分析进程。WA worker 由 supervisor 使用统一模板启动。

worker 模板：

```js
{
  script: './workers/worker-wa.js',
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  watch: false,
  kill_timeout: 15000,
  restart_delay: 30000,
  max_restarts: 5,
  min_uptime: '2m',
  env: {
    NODE_ENV: 'production',
    ACCOUNT_NAME: account.id
  }
}
```

重点：

- 降低重启风暴：`restart_delay` 不要太短。
- 加 `max_restarts` 和 `min_uptime`。
- 不再依赖 `max_memory_restart` 判断 Chrome 内存。

## 前端/API 改造

账号页面应显示：

- 账号状态：healthy / degraded / qr_required / failed。
- 最后消息时间。
- Chrome RSS。
- Chrome 进程数。
- Chrome 版本。
- WhatsApp Web 缓存版本。
- 最近重启原因。
- 操作按钮：启动、停止、重启、清理 Chrome、重新登录。

建议新增 API：

```text
GET  /api/wa/accounts
POST /api/wa/accounts/:id/start
POST /api/wa/accounts/:id/stop
POST /api/wa/accounts/:id/restart
POST /api/wa/accounts/:id/reap-chrome
POST /api/wa/accounts/:id/reset-auth
GET  /api/wa/runtime
POST /api/wa/web-version/refresh
```

## 分阶段落地

### 阶段 1：止血

- 为 Chrome 增加统一轻量化启动参数。
- 动态 user-agent，移除固定 Chrome 122。
- 新建账号模板补齐 `exec_mode`、`kill_timeout`、`restart_delay`、`max_restarts`、`min_uptime`。
- 增加 Chrome RSS 统计脚本/API。

### 阶段 2：Supervisor

- 新增 `wa-supervisor`。
- 账号配置迁移到 `config/wa-accounts.json`。
- supervisor 控制启动队列和资源阈值。
- 前端展示真实 WA 运行状态。

当前已落地的保守版 supervisor：

- 配置文件：`config/wa-accounts.json`
- PM2 进程：`wa-supervisor`
- 手动运行：`npm run wa:supervisor`
- RSS 查看：`npm run wa:runtime`
- 巡检间隔：默认 60 秒
- 单账号 RSS 阈值：默认 3200MB
- 连续超阈值次数：默认 3 次
- 重启冷却：默认 900 秒
- 初始化锁清理：默认 720 秒且持锁账号无 Chrome 子进程时清理
- no-Chrome 判定会识别有效初始化锁，排队中的账号不触发误重启
- 初始化硬超时账号由 worker 写入 5 分钟冷却标记，重启后先让出启动队列

该版本暂不主动停用低优先级账号，也不做跨机器调度；它先负责观测、落库、清理 stale lock、以及连续高 RSS 后重启单个 worker。这样可以在现有生产进程上渐进上线。

### 阶段 2.5：PM2 进程形态收敛

已将历史 WhatsApp worker 从 PM2 `cluster` 模式重建为 `fork` 模式：

- `worker-wa-nanya_wa`
- `worker-wa-yatai-wa`
- `worker-wa-wa_oumei2`
- `worker-wa-wa_shebi`
- `worker-wa-yuyin_wa_02`

重建方式只操作 PM2 进程，不删除 `whatsapp-session-{account}` 目录，因此保留 LocalAuth session。重建后执行 `npx pm2 save`，保证下次机器重启仍按 `fork` 形态恢复。

### 阶段 3：版本治理

- 固化 Chrome 安装、版本记录、user-agent 生成。
- 增加 WhatsApp Web 缓存刷新/清理命令。
- 建立单账号灰度升级流程。

当前已落地的版本治理工具：

- 查看 Puppeteer Chrome：`npm run chrome:version`
- 安装/更新 Puppeteer Chrome：`npm run chrome:install`
- 查看 WhatsApp WebVersion 缓存：`npm run wa:web-version:status`
- 清理旧 WebVersion 缓存，仅保留最新 N 个版本：`npm run wa:web-version:prune -- 5`
- 运行态 API：`GET /api/accounts/wa-supervisor`

worker 启动时会使用 Puppeteer 实际 Chrome 版本生成 user-agent，并将 `chrome_version` 写入 `accounts` 表。supervisor 每轮巡检也会补写该版本，避免版本信息只存在于日志中。

### 阶段 4：多机器扩展

- 按区域或业务线拆分 WA 节点。
- 每台机器只跑有限账号，例如 3-5 个。
- 主服务统一读取所有节点同步到的消息库或中心库。

## 推荐长期容量

单机长期稳定建议：

- 8GB 内存：最多 2-3 个 WA。
- 16GB 内存：最多 4-5 个 WA。
- 32GB 内存：最多 8-10 个 WA，但必须启用 supervisor 和 RSS 阈值。

即使 32GB 机器，也不建议无上限堆账号。WhatsApp Web 页面会随运行时间、群数量、媒体消息和 WhatsApp 前端版本变化而膨胀。

## 关键结论

长期 5+ WA 在线时，核心不是继续调高 PM2 内存，而是把 WhatsApp 账号当成一组有资源预算的浏览器工作负载来管理：

- PM2 负责进程守护。
- supervisor 负责账号调度和资源治理。
- worker 只负责采集。
- Chrome 版本和启动参数统一治理。
- 前端展示真实健康状态，而不是只看账号表里的 `authenticated`。
