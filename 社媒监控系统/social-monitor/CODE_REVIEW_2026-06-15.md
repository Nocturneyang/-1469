# 社媒监控系统 代码审查报告

> 审查日期：2026-06-15
> 审查范围：`社媒监控系统/social-monitor/` 核心代码（采集层 / 分析层 / Server / 动态账号管理 / 双库分离）
> 审查重点：**架构与可靠性**、**性能与扩展性**
> 审查方式：静态阅读 + git 追踪检查，未运行系统、未改动任何代码

---

## 一、总体评价

这是一个**远超 CLAUDE.md 描述规模**的成熟系统。实际代码已包含 Teams（Graph + 网页）采集、知识资产抽取管线、collector 远程采集架构（双写 + 本地 outbox 重放）、k8s 运行时适配器、SSO 鉴权、Vue 前端等，核心代码约 1.2 万行。

整体工程质量**偏高**，尤其在 WhatsApp 采集的稳定性治理上下了很大功夫（全局串行初始化锁、初始化冷却/隔离、Chrome 残留清理、QR 超时自停、心跳上报）。两库分离、增量游标、AI 熔断降级、Telegram 防封控这几项关键架构约束都**真实落地**，不是文档摆设。

主要风险集中在**少数几处安全默认值**和**单点扩展瓶颈**上，下面按严重程度分级列出。

| 级别 | 数量 | 说明 |
|---|---|---|
| 🔴 严重 | 3 | 安全默认值 / 凭据残留，建议优先处理 |
| 🟠 中等 | 6 | 可靠性与扩展性瓶颈，会在规模增长时暴露 |
| 🟡 轻微 | 6 | 健壮性与可维护性改进项 |
| ✅ 亮点 | 7 | 值得保留和推广的设计 |

---

## 二、🔴 严重问题

### S1. JWT 密钥与默认管理员密码使用硬编码兜底值

`middleware/auth.js:3`
```js
const JWT_SECRET = process.env.JWT_SECRET || 'social-monitor-fallback-secret';
```
`db/database.js:168` 首次初始化时创建 `admin / admin123` 与 `view / view`。

**风险：** 若生产环境未显式设置 `JWT_SECRET`，任何人都能用公开可见的兜底密钥自行签发合法 JWT，直接绕过鉴权拿到 admin 权限（admin 路由可动态增删账号、改 ecosystem、读日志）。默认弱口令 `admin123` 若未首次修改同样是完整接管入口。

**建议：**
- 启动时若 `process.env.JWT_SECRET` 缺失则**直接拒绝启动**（fail-fast），不要提供兜底字符串。
- 默认管理员密码改为首次启动随机生成并打印一次，或强制首次登录改密；至少在 README 中以醒目方式要求部署时立即改密。

---

### S2. WhatsApp 登录态（`.wwebjs_cache/`）被纳入 git 追踪

git 追踪了 `.wwebjs_cache/*.html`（25 个 WA Web 版本快照）。`.gitignore` 忽略了 `whatsapp-session-*/` 和 `.env`，但**没有忽略 `.wwebjs_auth/` 和 `.wwebjs_cache/`**。

**风险：**
- `.wwebjs_cache/` 本身是 WA Web 的 HTML 版本缓存，泄露敏感度低，但**不应入库**——它会随 WA 版本不断变化，污染 diff 且体积膨胀。
- 更需警惕的是 `.wwebjs_auth/session-nanya_wa/` 这类目录：当前虽未被 git 追踪，但 `.gitignore` 没有兜底规则，**一旦有人 `git add .` 极易把 WhatsApp 登录凭据（IndexedDB / LocalStorage 密钥）提交进仓库**，等同于账号被接管。

**建议：** 在 `.gitignore` 增加：
```
.wwebjs_auth/
.wwebjs_cache/
collector-outbox/
*.sqlite-wal
*.sqlite-shm
```
并执行 `git rm -r --cached .wwebjs_cache` 将其移出追踪。

### S3. config 目录入库，需确认不含真实密钥

`config/webhooks.json`、`internal-staff.json`、`account-regions.json`、`wa-accounts.json` 均被 git 追踪。审查时当前工作区的 `webhooks.json` 是**模板**（无真实 `access_token`），git 历史中也未检出真实地址，**目前是安全的**。

**风险点在于约定脆弱：** 该文件设计上就是用来填真实钉钉 Webhook + secret 的（`dingtalk.js` 直接读取 `hooks[key].url / secret`）。一旦运维在本地填入真实 hook 并 commit，secret 即泄露，且加签机器人凭 url+secret 可被任意第三方调用发消息。

**建议：** 把 `config/webhooks.json` 改为 `config/webhooks.example.json` 入库，真实文件加入 `.gitignore`；或所有 secret 一律走环境变量（代码已支持 ENV 兜底链路），JSON 内只存非敏感路由键。

---

## 三、🟠 中等问题（可靠性与扩展性）

### M1. WhatsApp 采集是单机串行瓶颈，无法水平扩展

`worker-wa.js` 使用 `/tmp/wa_chrome_init.lock` 作为**全局串行初始化锁**，`wa-accounts.json` 默认 `maxStartingAccounts: 1`、`maxOnlineAccounts: 5`。这意味着：

- 同一时刻只有一个 WA 账号能初始化 Chrome，N 个账号冷启动是**串行**的，每个 `WA_INIT_HARD_TIMEOUT_MS` 默认 360s，最坏情况启动队列极长。
- 锁基于本机 `/tmp` 文件，**天然无法跨机**。一旦 WA 账号数超过单机 Chrome 内存承载（默认 `max_memory_restart: 4G`/账号，总 `maxChromeRssMbTotal: 12000`），唯一出路是 collector 远程采集架构（已存在），但主库写入与 supervisor 调度仍是单点。

这是当前架构**最硬的扩展天花板**。设计上是有意识的权衡（串行换稳定），但需要明确：WA 这条线的容量上限≈单机能稳定托管的 Chrome 实例数（经验值 5–8 个）。

**建议：** 文档中明确单机 WA 账号上限；规模增长时优先把 WA 采集下沉到多台 collector 机器（架构已就绪），ui-server / 分析层 / 主库保持中心化。

### M2. 主库为单文件 SQLite，所有 worker + 分析层 + server 共享写入

`database.sqlite` 开了 WAL（读写并发友好），但仍是**单写者**模型：所有 worker 通过 `saveMessage()` 写同一文件，server 和分析层（只读）也打开它。WAL 下多读单写没问题，但：

- 高消息量时，多个 worker 的写入会串行化（SQLite 写锁），媒体下载 + 写库在消息洪峰下可能产生背压。
- `messages` 表无分区/归档机制，长期单调增长，索引虽全（timestamp/platform/group_name/has_media/is_synced），但全表会越来越大。

**建议：** 监控 `messages` 行数与 DB 体积；规划冷热分离（如按月归档历史消息到独立库），`media/` 目录已有 `media-retention.js` 但 DB 行未见归档策略。规模再大需评估迁移 Postgres。

### M3. 分析层多进程各自轮询同一主库，轮询而非事件驱动

`supplier-analyzer`（15/30/60s 分时轮询）、`issue-lifecycle-tracker`（30s）、`daily-digest`、`knowledge-*` 等都各自起独立进程，各持一个只读连接，**各自 `SELECT ... WHERE id > cursor LIMIT 500/100` 轮询**。

- 优点：游标隔离干净，单个分析器卡死不影响他人（已验证每个 analyzer 用独立 `ANALYZER_NAME` 游标）。
- 代价：N 个分析器 = N 份重复扫描 + N 个常驻进程；轮询有固有延迟（最高峰 P0 也要等下一个 15s tick）。`issue-lifecycle-tracker` 每个 open issue 都 `SELECT ... LIMIT 100` 扫后续消息，open issue 多时是 O(issues × 100) 的反复扫描。

**建议：** 现规模可接受。若分析器继续增多，考虑引入一个"消息分发器"统一读主库一次、扇出给各分析器（内存队列或轻量 MQ），减少重复扫描与进程数。

### M4. P1 聚合窗口、无响应状态、P0 验证缓存都是纯内存态，进程重启即丢

`supplier-analyzer.js` 的 `p1Windows`、`noResponseState`、`p0ValidationCache` 都是 `Map`，进程重启（PM2 重启 / 崩溃）会全部清空。

**影响：** 重启瞬间，正在聚合的 P1 窗口、已计时的"15 分钟无响应"状态会丢失，可能漏报或重新计时。游标只记录 `last_msg_id`，重启后会从游标继续，但**窗口内的中间聚合状态无法恢复**。

**建议：** 这类瞬态聚合丢失通常可接受（下一条消息会重建状态），但需在文档中明示；若漏报不可接受，可把 open 的聚合窗口落 analytics 库。

### M5. 动态账号创建 / 删除直接 `exec` PM2 命令，且无串行化保护

`routes/accounts.js` 的 `/create`、`/delete`、`/restart` 都通过 `child_process.exec('npx pm2 ...')` 调用，并在回调里 `pm2 save`。多个并发请求（或前端快速点击）可能：

- 同时读改写 `ecosystem.config.js`（`safeWriteEcosystem` 有备份+校验+回滚，但**无文件锁**，并发写存在 race）。
- 同时 `pm2 save` / `pm2 start` 互相干扰。

`safeWriteEcosystem` 的回滚设计很好（写入后 require 校验 apps 数组，失败回滚），但**两个请求交错时仍可能互相覆盖**。

**建议：** 给 accounts 写操作加一个进程内互斥队列（简单 mutex/串行化中间件），保证同一时刻只有一个账号变更在执行。

### M6. `uncaughtException` / `unhandledRejection` 仅记录不退出

`server.js:550-555` 捕获全局异常后**只 console.error，不退出进程**。

**风险：** Node 官方建议 `uncaughtException` 后进程应视为处于不确定状态并优雅退出（由 PM2 拉起）。长期吞掉未捕获异常可能导致 server 进入"僵而不死"的半损坏状态（连接句柄泄漏、内存泄漏），却仍报告 listen 正常。

**建议：** `uncaughtException` 记录后 `process.exit(1)` 交给 PM2 重启；`/readyz` 已有健康检查，配合即可。

---

## 四、🟡 轻微问题

### L1. Telegram 用户账号实时监听对每条消息 `await getChat()` / `await getSender()`
`worker-tg-user.js:278-301` 每条实时消息都发起 2 次 MTProto 调用解析 chat/sender。高频群下这会增加 API 调用量（与防封控目标相悖），且 sender 信息在回溯路径里直接留空（`sender_name: ''`）。建议对 chat/sender 做短期缓存。

### L2. 回溯路径 `sender_name` 恒为空
`tg-backfill-queue.js:248` 历史回溯写入时 `sender_name: ''`，而 `staff-detector` 依赖 `sender_name` 判定内外部。**回溯来的历史消息会全部被当作外部消息**，可能影响基于历史的分析（日报/画像）准确性。建议回溯时也解析发送者，或在分析层对空 sender 做特殊处理。

### L3. `worker-tg-user.js` 顶层使用 `return` 而非函数包裹
第 133 行、第 92 行（worker-tg.js）在模块顶层 `return`（依赖 CommonJS 模块作用域允许顶层 return）。可运行但属边缘语法，建议包进 `main()` 或 `process.exit`，可读性更好。

### L4. `analyzeDailyDigest` 把外部消息截断到 3000 字符、画像样本 2600 字符
多处 `.slice(0, 3000)` 硬截断（`ai-client.js`）。活跃大群一天消息远超此长度，AI 实际只看到开头一小段，日报/画像可能系统性遗漏当天后半段信息。建议改为按重要性采样或分块。

### L5. `extractJSON` 容错较脆
`ai-client.js:231` 的平衡括号匹配对 JSON 字符串内含 `{` `}` 的情况会误判。当前 prompt 都要求纯 JSON 输出，风险低，但模型偶发越界时可能解析错位。可考虑用更严格的 JSON 修复库。

### L6. 时间戳混用本地 `+8 hours` 字面量
analytics schema 大量使用 `datetime('now', '+8 hours')` 把 UTC 硬偏移成北京时间存储。这让 DB 内时间**不带时区语义**，跨时区或夏令时无关场景虽能用，但 `secondsSince()` 等计算处又按 UTC 解析，存在口径不一致隐患。建议统一存 UTC，展示层转时区。

---

## 五、✅ 设计亮点（建议保留）

1. **两库分离真实落地**：分析层一律 `new Database(path, { readonly: true })` 打开采集库，写操作只落 analytics 库，从代码层面杜绝了分析进程污染采集数据。
2. **增量游标隔离干净**：每个分析器独立 `ANALYZER_NAME` 游标，互不干扰，单点卡死不阻塞他人。
3. **WhatsApp 初始化治理扎实**：原子文件锁（`O_CREAT|O_EXCL`）避免惊群、初始化冷却+隔离（strike 累计升级冷却）、QR 空闲超时自停省内存、SIGTERM 立即杀 Chrome 防孤儿进程——这些都是踩过坑后的成熟方案。
4. **AI 熔断降级完整**：429/402/503 触发熔断，30 分钟自动恢复，降级时 P0/P1 仍按关键词推送，并通过钉钉通知降级状态，业务不中断。
5. **Telegram 防封控规范到位**：FloodWait 严格按返回秒数退避、PeerFlood 进程级熔断 24h、日配额 + 断点续传游标（`tg_backfill_tasks`）、预热静默期、随机抖动延迟——与 CLAUDE.md 的防封控规范完全一致。
6. **collector 双写 + 本地 outbox 重放**：远程采集失败时落本地 jsonl 队列、定时重放，保证消息不丢，是很好的最终一致性设计。
7. **ecosystem 写入有备份/校验/回滚**：`safeWriteEcosystem` 写后 require 校验 apps 数组合法性，失败自动回滚，避免写坏配置导致全员无法启动。

---

## 六、优先处理建议（按投入产出比）

| 优先级 | 事项 | 对应问题 |
|---|---|---|
| P0（立即） | 强制 `JWT_SECRET` fail-fast + 默认密码改密 | S1 |
| P0（立即） | 补 `.gitignore`（`.wwebjs_auth/` 等）并移出已追踪缓存 | S2 |
| P1（本周） | `webhooks.json` 改 example + 真实文件 gitignore | S3 |
| P1 | accounts 写操作加串行互斥 | M5 |
| P1 | `uncaughtException` 后退出交 PM2 | M6 |
| P2（规划） | 文档明确 WA 单机账号上限与扩展路径 | M1 |
| P2（规划） | `messages` 表归档/冷热分离策略 | M2 |

---

## 七、修改建议（可落地方案）

> 以下为针对每个问题的具体改法。所有代码片段按当前仓库实际行号/变量名编写，可直接参考套用。改动前请按 CLAUDE.md 部署规范走 `node --check` 语法快检 → `npm test` → `npm run build`。

### S1 修复：JWT 密钥 fail-fast + 默认密码强制改密

**① `middleware/auth.js`（第 3 行）** —— 缺失密钥直接拒绝启动，不再提供兜底值：

```js
// 修改前
const JWT_SECRET = process.env.JWT_SECRET || 'social-monitor-fallback-secret';

// 修改后
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET 未配置或长度不足 32 位，拒绝启动。请在 .env 中设置强随机密钥：');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
  process.exit(1);
}
```

**② `db/database.js`（第 161-176 行）** —— 默认密码改为随机生成并打印一次，且标记 `must_change`（需配合前端首登改密；若暂不做前端，至少随机化消除公开弱口令）：

```js
if (count === 0) {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const salt = bcrypt.genSaltSync(10);

    // 优先用环境变量；未提供则随机生成并打印一次（仅首次初始化可见）
    const adminPwd = process.env.ADMIN_INIT_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const adminHash = bcrypt.hashSync(adminPwd, salt);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('admin', adminHash, 'admin');

    const viewPwd = process.env.VIEW_INIT_PASSWORD || crypto.randomBytes(6).toString('base64url');
    const viewHash = bcrypt.hashSync(viewPwd, salt);
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('view', viewHash, 'view');

    console.log('========================================================');
    console.log('  首次初始化已创建账号，请立即登录并修改密码：');
    console.log(`  admin / ${adminPwd}`);
    console.log(`  view  / ${viewPwd}`);
    console.log('  （此密码仅打印一次，请妥善保存）');
    console.log('========================================================');
}
```

> 落地提示：`JWT_SECRET`、`ADMIN_INIT_PASSWORD` 加入 `.env.example` 占位说明。生产若已用旧 `admin123`，上线后手动改密一次即可。

---

### S2 修复：补全 `.gitignore` 并移出已追踪的缓存

**① 在 `.gitignore` 追加（采集端凭据 + 缓存 + WAL/SHM + outbox）：**

```gitignore
# WhatsApp 运行时凭据与缓存（严禁入库）
.wwebjs_auth/
.wwebjs_cache/
wa-diagnostics/

# collector 本地重放队列
collector-outbox/

# SQLite WAL/SHM 临时文件
*.sqlite-wal
*.sqlite-shm
db/*.sqlite-wal
db/*.sqlite-shm
```

**② 把已被追踪的 `.wwebjs_cache/` 移出版本控制（保留本地文件，仅停止追踪）：**

```bash
cd 社媒监控系统/social-monitor
git rm -r --cached .wwebjs_cache
git commit -m "chore: stop tracking .wwebjs_cache and harden gitignore for collector credentials"
```

> 自查命令（确认无凭据被追踪）：
> `git ls-files | grep -iE 'wwebjs_auth|wwebjs_cache|\.sqlite|whatsapp-session'` —— 应为空。

---

### S3 修复：webhooks.json 改 example 模式，secret 不入库

**① 把真实文件改名为模板入库，真实文件本地化：**

```bash
cd 社媒监控系统/social-monitor/config
cp webhooks.json webhooks.example.json     # 模板（脱敏，仅留键名结构与说明）
git rm --cached webhooks.json              # 真实文件停止追踪
```

**② `.gitignore` 追加：**

```gitignore
config/webhooks.json
```

**③ `lib/dingtalk.js` 增加缺失时的友好兜底**（当前 `getRegionWebhooks` 已对文件不存在返回 `{}`，再加一次启动提示即可）：

```js
function getRegionWebhooks() {
  try {
    if (fs.existsSync(WEBHOOKS_PATH)) {
      return JSON.parse(fs.readFileSync(WEBHOOKS_PATH, 'utf8'));
    }
    console.warn('[DingTalk] 未找到 config/webhooks.json，将回退到环境变量 DINGTALK_* 路由');
  } catch (err) {
    console.error('Error reading webhooks.json:', err.message);
  }
  return {};
}
```

> 说明：代码已支持「JSON → ENV 平台专属 → ENV 全局」的兜底链路，因此把 secret 全部迁到环境变量即可彻底避免入库风险。

---

### M5 修复：accounts 写操作加进程内串行互斥

`routes/accounts.js` 的 `/create`、`/delete`、`/restart`、`/relogin` 会并发改写 `ecosystem.config.js` 并调 PM2。加一个轻量串行队列，保证同一时刻只有一个变更在执行：

```js
// routes/accounts.js 顶部新增一个简单互斥队列
let mutationChain = Promise.resolve();
function serializeMutation(taskFn) {
    const run = mutationChain.then(() => taskFn());
    // 无论成功失败都让链继续，避免一次异常卡死后续请求
    mutationChain = run.catch(() => {});
    return run;
}
```

在每个写路由的处理体外层包一层（以 `/create` 为例）：

```js
router.post('/create', (req, res) => {
    serializeMutation(() => handleCreate(req, res))
        .catch(err => {
            console.error('Create Error:', err);
            if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
        });
});
```

> 把原 `/create` 主体抽成 `async function handleCreate(req, res) { ... }`。`/delete`、`/restart`、`/relogin` 同样处理。这样 `safeWriteEcosystem` 的备份/校验/回滚不会被并发交错破坏。

---

### M6 修复：uncaughtException 后退出交给 PM2

`server.js`（第 550-555 行）—— 记录后优雅退出，由 PM2 拉起干净进程：

```js
process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', err.message, err.stack);
    // 进程已处于不确定状态：停止接收新连接后退出，交给 PM2 重启
    try { const adb = getAnalyticsDb(); if (adb) adb.close(); } catch (_) {}
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', reason);
    // 可先观察（仅记录），确认无误后再升级为 exit(1)
});
```

> PM2 已配置 `autorestart`，退出后会自动重启。建议先在测试环境观察重启频率，避免崩溃循环。

---

### M1 / M2 / M3 / M4 处理建议（规划类，附最小落地动作）

- **M1（WA 单机串行上限）**：无需改代码，先在 `README` / `CLAUDE.md` 补一行：「单台 collector 建议托管 WA 账号 ≤ 6 个（受 Chrome 内存约束，`maxChromeRssMbTotal: 12000`）；超出请新增 collector 机器，ui-server / 分析层 / 主库保持中心化」。

- **M2（messages 单表增长）**：新增一个归档脚本 `scripts/archive-messages.js`，按月把 `timestamp` 早于 N 天的消息搬到 `db/database-archive-YYYYMM.sqlite`，主库只留热数据；接入 `package.json` 的 `db:archive`，由 cron 触发。归档前务必确认所有分析器游标已越过被归档的最大 id。

- **M3（多分析器重复轮询）**：现规模可不动。若分析器继续增多，可抽一个 `analyzers/dispatcher.js`：单进程读主库一次 → 通过内存事件/轻量队列扇出给各分析器订阅，减少 N 份重复全表扫描。

- **M4（聚合态内存丢失）**：在 `supplier-analyzer.js` 给 `noResponseState` 增加落库快照——每次 tick 末尾把未告警的状态写入 analytics 库一张 `analyzer_runtime_state` 表，启动时恢复。P1 窗口（5 分钟）可接受丢失，无响应计时（15 分钟）建议持久化。

---

### L 系列轻微项处理建议

- **L1（TG 实时每条 await getChat/getSender）**：在 `worker-tg-user.js` 加一个 `Map` 缓存 chat/sender（key 为 id，TTL 5–10 分钟），命中则跳过 MTProto 调用，降低 API 频率。

- **L2（回溯 sender_name 为空）**：`tg-backfill-queue.js` 第 248 行，回溯时按 `msg.fromId` 解析发送者名（可批量 `getEntity` 后缓存），或在分析层把空 `sender_name` 的历史消息单独标记，避免被 `staff-detector` 误判为外部。

- **L3（顶层 return）**：把 `worker-tg.js`/`worker-tg-user.js` 的顶层 `return` 包进 `main()` 或改用 `process.exit(0)`，提升可读性（不影响功能）。

- **L4（AI 输入硬截断 3000 字符）**：`ai-client.js` 的 `.slice(0, 3000)` 改为按消息条数采样（如均匀取首中尾各 N 条）或分块多次调用后合并，避免活跃大群只分析到开头一段。

- **L5（extractJSON 容错）**：当前 prompt 都要求纯 JSON，风险低；如需加固可引入 `jsonrepair` 类库替代手写平衡括号匹配。

- **L6（时间戳 +8 hours 字面量）**：长期方向是统一存 UTC、展示层转 `Asia/Shanghai`；改造面较大，建议作为独立技改项排期，不与本次修复混做。

---

*本报告仅基于静态代码阅读，未在运行环境验证。涉及"是否已在生产设置 JWT_SECRET / 是否已改默认密码"等运行时事实，需结合实际部署确认。所有代码片段为建议示例，合入前请做语法快检与回归测试。*
