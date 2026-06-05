# AGENTS.md

本文件用于说明 Codex 或其他代码协作 Agent 在本仓库中应该如何工作，重点是项目边界、运行方式、数据安全、测试要求和部署注意事项。

## 项目边界

- 仓库根目录：`/Users/a2026/Desktop/社媒监控`
- 主应用目录：`社媒监控系统/social-monitor/`
- Node、PM2、构建、测试等命令默认都在 `社媒监控系统/social-monitor/` 目录下执行。
- 根目录部署文件也是应用生命周期的一部分，包括：`Dockerfile`、`docker-entrypoint.sh`、`.deployhub/`。
- 一次性实验、审计脚本、临时测试脚本统一放在 `社媒监控系统/tools/`，不要放进 `social-monitor/` 核心代码目录。
- 不要强制提交被忽略的实验输出、HTML 报告或本地数据文件，除非用户明确要求。

## 当前项目结构

```text
社媒监控系统/social-monitor/
├── db/                         # SQLite 访问层和本地数据文件
│   ├── database.js             # 采集库写入辅助方法
│   ├── database.sqlite         # 原始采集消息库，分析层必须按只读处理
│   └── analytics.sqlite        # 分析输出库
├── workers/                    # WhatsApp、Telegram、Teams 采集器和 WA supervisor
├── analyzers/                  # 后台分析器，只写 analytics.sqlite
├── lib/                        # AI、钉钉、员工识别、区域、采集器、知识资产等公共逻辑
├── routes/                     # Express API 路由模块
├── config/                     # 账号区域、内部员工白名单、Webhook、WA 账号配置
├── scripts/                    # 表结构、备份、采集器、Chrome、媒体清理等工具
├── frontend/                   # Vue 3 + Vite + Element Plus 前端
├── docs/                       # 设计文档和迭代说明
├── server.js                   # Express API + 静态前端服务
├── ecosystem.config.js         # 本地 PM2 进程配置
└── ecosystem.cloud.config.js   # 生产 PM2 进程配置
```

重要前端页面：

- `frontend/src/views/KnowledgeAssets.vue`：资产发现
- `frontend/src/views/RegionIntelligence.vue`：区域运营情报
- `frontend/src/views/DomainIntelligence.vue`：客服运营情报、设备技术情报
- `frontend/src/views/EntityGraph.vue`：实体关系图谱
- `frontend/src/views/KnowledgeBase.vue`：QA 知识库
- `frontend/src/views/DeviceKB.vue`：设备知识库
- `frontend/src/views/ContentTemplates.vue`：内容模板库
- `frontend/src/views/SupplierProfiles.vue`：供应商画像

## 常用命令

以下命令默认在 `社媒监控系统/social-monitor/` 目录执行：

```bash
npm test
npm run build
npm run dev
npm run wa:runtime
npm run db:backup
npm run media:report
```

PM2 常用命令：

```bash
npx pm2 start ecosystem.config.js --env production
npx pm2 status
npx pm2 logs ui-server
npx pm2 logs knowledge-asset-analyzer
npx pm2 restart ui-server
npx pm2 restart knowledge-asset-analyzer
npx pm2 save
```

初始化或修复分析库：

```bash
node scripts/init-analytics-db.js
```

## 架构说明

系统采用采集库和分析库分离的设计。

- `database.sqlite` 是采集库，由 workers 写入原始消息和媒体元数据。
- `analytics.sqlite` 是分析库，由 analyzers 写入告警、问题、日报、画像、知识库、知识资产等结果。
- `analysis_cursor` 表记录每个分析器的增量处理游标。
- 分析代码应尽量以只读方式打开 `database.sqlite`，不得向采集库写入衍生字段或分析结果。

主数据流：

1. Workers 采集 WhatsApp、Telegram、Telegram 用户账号或 Teams 消息。
2. 消息通过 `db/database.js` 幂等写入采集库。
3. Analyzers 按游标轮询新消息，结合规则和 AI 分析后写入 `analytics.sqlite`。
4. `server.js` 对外提供 REST API，并托管构建后的 Vue 前端。
5. 钉钉推送通过 `lib/dingtalk.js` 完成，并支持按区域和平台路由到不同 Webhook。

## 知识资产

当前正式资产包括：QA 知识库、设备知识库、内容模板库、供应商画像、区域运营情报、客服运营情报、设备技术情报、实体关系图谱和资产发现。

资产发现应该作为候选资产的分诊和流转层：

- `analyzers/knowledge-asset-analyzer.js` 从消息长上下文和事件窗口中发现候选资产。
- `lib/knowledge-assets.js` 负责评分、去重、自动沉淀、人工审核和投影到正式资产格式。
- 高置信度候选应优先由规则和 AI 自动沉淀。
- 人工审核主要处理低置信度、上下文不足或存在歧义的候选。
- 审核通过或自动沉淀后的内容，必须流入对应正式知识板块，并按该板块原有展示形式呈现：
  - 设备知识库：设备/型号 -> 故障 -> 方案
  - QA 知识库：问题 -> 关键词 -> 回答步骤
  - 内容模板库：客户/模板类型 -> 模板内容 -> 合规备注
  - 供应商画像：供应商/群 -> 行为指标和标签
  - 区域/客服/设备情报：区域或业务板块 -> 具体情报对象 -> 总结 -> 下一步动作
  - 实体关系图谱：实体 -> 关系 -> 证据和运营用途

所有从消息生成的候选资产或正式资产都应该保留可追溯字段，例如来源消息 ID、群名、采集账号、区域、业务板块、时间窗口、置信度和价值分。

## AI 使用原则

AI 调用统一通过 `lib/ai-client.js`。

调用优先级：

1. OpenAI 兼容接口
2. Gemini 备用
3. 关键词/规则降级

AI 总结必须基于足够的上下文，而不是单条短消息或无意义片段。告警和情报页面中的 AI 结论应尽量回答：

- 发生了什么
- 涉及哪个区域、业务、客户、供应商、设备或线路
- 为什么重要
- 目前缺什么信息
- 下一步应该做什么

当 AI 不可用、置信度不足或上下文不够时，应明确标记为规则判断或待人工复核，不要伪装成确定结论。

## 告警

告警相关逻辑主要在：

- `analyzers/supplier-analyzer.js`
- `analyzers/issue-lifecycle-tracker.js`
- `lib/ai-client.js`
- `lib/dingtalk.js`
- `routes/analytics.js`

告警内容应避免推送无价值片段，例如简单确认、@某人、问候语或孤立短句。一个有用的告警应包含上下文、等待时长、可能责任方、业务影响和建议动作。

## 本地与生产环境

本地 PM2 使用 `ecosystem.config.js`，可以包含本地采集器、UI 服务、同步进程、WA supervisor 和分析器。

生产环境使用 `ecosystem.cloud.config.js`：

- 生产容器运行 API/UI、sync-agent 和各类 analyzers。
- 本地 WhatsApp/TG 采集器应通过云端 API 上报，不应在生产容器内运行 Chrome 采集器。
- 生产数据目录通常是 `/data`。
- 如果修改了 `ecosystem.cloud.config.js`，需要同步提升根目录 `docker-entrypoint.sh` 中的 `CLOUD_ECOSYSTEM_VERSION`，确保生产容器刷新持久化 PM2 配置。
- 生产环境中的历史回溯和知识资产批处理必须限速，避免影响页面/API 响应。

Deploy Hub 从 `.deployhub/` 读取部署配置。

当前生产服务信息：

- 服务名：`social-monitor`
- 命名空间：`g1469`
- 域名：`social-monitor.tyhark.com`

使用 Deploy Hub 部署前，必须先把代码推送到远程仓库。

## 测试要求

- 后端行为变化后运行 `npm test`。
- 前端变化后运行 `npm run build`。
- 修改 CommonJS 后端文件时，可先用 `node --check <file>` 做快速语法检查。
- 修改 PM2 托管的运行时代码后，本地验证前必须重启对应 PM2 进程。
- 本地前端验证优先使用内置浏览器访问 `http://localhost:3000`。
- 编辑原始 HTML 时，需要验证 `<style>`、`</style>`、`<script>`、`</script>` 标签数量是否匹配。
- 临时测试脚本和报告放在 `社媒监控系统/tools/`。
- 测试和实验脚本不得写入 `database.sqlite`，也不得污染正式 `analytics.sqlite`；需要输出时使用实验库或报告文件。

## 编辑规则

- 不要提交 `.env`、Token、Session、本地媒体、SQLite WAL/SHM 文件或包含敏感消息正文的审计报告。
- Analyzers、测试脚本和报告不得修改 `database.sqlite`。
- 优先使用结构化 SQL 和 JSON 解析，不要用脆弱的字符串截取处理结构化数据。
- 改动范围应聚焦用户当前需求，不做无关重构。
- 不要回滚用户已有改动，除非用户明确要求。
- 修改 `ecosystem.config.js` 要谨慎，UI 动态账号创建依赖 `// --- Web UI Server ---` 这个锚点。
- 前端优先沿用现有 Vue、Element Plus、路由和 API 风格，不要随意引入新依赖。

## Telegram 采集安全

针对 Telegram MTProto 历史回溯或高频采集：

- 单批建议控制在 50-100 条。
- 请求之间加入随机延迟和指数退避。
- 游标持久化到 `tg_backfill_tasks`。
- 严格遵守 `FloodWait` 返回的等待时间。
- 遇到 `PeerFlood` 等风控信号时，应停止或隔离任务，并推送运维告警。
- 避免同一账号并发执行多个历史回溯任务。

## 配置项

重要环境变量包括：

- `TG_BOT_TOKEN`
- `ACCOUNT_NAME`
- `TG_ACCOUNT_NAME`
- `TG_WHITELIST_<NAME>`
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `GEMINI_API_KEY`
- `DINGTALK_ALERT`
- `DINGTALK_DIGEST`
- `DINGTALK_WEEKLY`
- `COLLECTOR_TOKEN`
- `DATA_DIR`

区域专属 Webhook 配置在 `config/webhooks.json` 中，由 `lib/dingtalk.js` 解析。

内部员工识别使用 `config/internal-staff.json` 和 `lib/staff-detector.js`。

## Git 注意事项

根目录 `.gitignore` 默认只跟踪主应用和部署相关文件。实验脚本、报告和本地输出默认保持忽略，除非用户明确要求纳入版本管理。

提交和推送生产变更前：

1. 查看 `git status --short`。
2. 确认没有敏感信息或大型本地数据文件被暂存。
3. 运行相关测试或构建。
4. 提交、推送到 Codeup，然后再部署。
