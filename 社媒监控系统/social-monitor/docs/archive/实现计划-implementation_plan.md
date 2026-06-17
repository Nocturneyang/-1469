# 数据分析与信息推送系统 — 开发实施计划

> 基于《数据分析与信息推送方案（第3版）》分阶段落地

## 当前基础

已完成（collector 层完整）：
- `workers/worker-wa.js` / `worker-tg.js` — WhatsApp/Telegram 消息采集
- `sync-agent.js` — 10秒轮询推送至中控
- `config/account-regions.json` — 区域账号映射
- `config/webhooks.json` — 钉钉机器人配置说明
- `.env.example` — 三路钉钉 Webhook 变量已定义
- `db/database.sqlite` — 原始采集库（已有1587+条消息）

**关键约束：不修改 `database.sqlite` 结构；分析器独立读，写入 `analytics.sqlite`**

---

## 阶段 A：基础告警链路（本次开发）

### 新建文件

#### [NEW] `scripts/analytics-schema.sql`
建库 SQL — `analytics.sqlite` 全部7张分析表（幂等 IF NOT EXISTS）。

#### [NEW] `scripts/init-analytics-db.js`
初始化脚本，首次运行建表，后续幂等。

#### [NEW] `analyzers/supplier-analyzer.js`
核心告警引擎：
- 30s/15s/60s 分时轮询（按方案峰谷）
- 从 `database.sqlite` 只读拉取新消息
- P0 组合词直接路由推送
- P1 5分钟窗口聚合 → AI 评分 → ≥7分创建 issue_records
- 无响应检测（外部问 → 15分钟 ITNIO 未回）
- SID 变更检测写入 `sid_change_records`

#### [NEW] `analyzers/issue-lifecycle-tracker.js`
问题生命周期追踪：
- 30s 扫描 open issue_records
- 检测同群后续闭环词 → 关闭 issue，记录 duration_mins
- 30分钟超时 → 推送「问题未解决提醒」
- 2小时超时 → 升级推送，承诺追踪到期检查

#### [NEW] `analyzers/daily-digest.js`
每日群汇总：
- node-cron 09:00 Asia/Shanghai 调度
- 按区域分组昨日活跃群 → AI 生成摘要
- 注入未闭环 issue_records
- 沉默群提醒（>24h 无消息）
- 推送至 DINGTALK_DIGEST

#### [NEW] `lib/dingtalk.js`
钉钉推送工具库（封装 text/markdown/actionCard 三种格式，支持 @成员）

#### [NEW] `lib/ai-client.js`
AI 调用封装（Gemini/OpenAI，含429熔断 → 退回纯关键词模式，Prompt版本管理）

#### [MODIFY] `ecosystem.config.js`
新增 `supplier-analyzer`、`issue-lifecycle-tracker`、`daily-digest` 三个 PM2 进程。

#### [MODIFY] `.env.example`
新增 `GEMINI_API_KEY` / `OPENAI_API_KEY` 变量。

---

## 阶段 B（下次）：供应商可靠性评分周报
- `analyzers/supplier-reliability-scorer.js`
- 每周一09:00 cron，从 issue_records 聚合评分
- 推送至 DINGTALK_WEEKLY

## 阶段 C（下次）：情报积累
- `analyzers/content-review-extractor.js`
- `analyzers/sid-change-detector.js`（可合并入 supplier-analyzer）

---

## 验证计划

1. `node scripts/init-analytics-db.js` — 确认建表成功
2. 修改轮询频率为 5s 临时测试，确认告警从 database.sqlite 读取消息正常
3. 手动构造含 P0 词的模拟消息，验证钉钉推送
4. 添加阶段A全部进程到 PM2，确认 `npx pm2 status` 全部 online
