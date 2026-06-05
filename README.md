# 社媒监控系统

这是一个面向 WhatsApp、Telegram、Telegram 用户账号、Teams 等多平台消息采集与运营分析的本地/生产一体化系统。系统的核心目标不是只保存聊天记录，而是把跨区域、跨业务板块的消息沉淀为可追溯、可复用、可运营的知识资产。

## 核心能力

- 多平台消息采集：支持 WhatsApp、Telegram Bot、Telegram MTProto 用户账号、Teams 等消息来源。
- 原始数据留存：将消息、群、发送人、媒体元数据等写入采集库 `database.sqlite`。
- 分析库沉淀：通过独立分析进程写入 `analytics.sqlite`，避免分析逻辑污染采集库。
- 业务告警：根据关键词、上下文、AI 判断、无响应、生命周期等逻辑生成分级告警并推送钉钉。
- 知识资产：沉淀 QA 知识库、设备知识库、内容模板库、供应商画像、区域运营情报、客服运营情报、设备技术情报、实体关系图谱。
- 资产发现：从历史消息和实时消息中发现候选资产，高置信度自动沉淀，低置信度交给人工复核。
- 前端控制台：基于 Vue 3 + Vite + Element Plus，提供监控、知识库、情报、图谱、配置等页面。
- 本地采集与云端分析分离：生产环境主要运行 API、同步进程和分析器，本地采集器可向云端上报。

## 项目结构

```text
.
├── AGENTS.md                         # Codex/Agent 协作规则
├── Dockerfile                        # 生产镜像构建入口
├── docker-entrypoint.sh              # 生产容器启动脚本
├── .deployhub/                       # Deploy Hub 部署配置
├── 社媒监控系统/
│   ├── social-monitor/               # 主 Node.js 应用
│   │   ├── analyzers/                # 告警、知识库、画像、资产发现等分析进程
│   │   ├── workers/                  # WA/TG/Teams 采集进程
│   │   ├── lib/                      # AI、钉钉、区域、员工识别、知识资产公共逻辑
│   │   ├── routes/                   # Express API 路由
│   │   ├── db/                       # SQLite 数据库与访问层
│   │   ├── config/                   # 区域、Webhook、内部员工、账号配置
│   │   ├── scripts/                  # 初始化、备份、采集器、媒体清理脚本
│   │   ├── frontend/                 # Vue 前端
│   │   ├── server.js                 # API + 静态前端服务
│   │   ├── ecosystem.config.js       # 本地 PM2 配置
│   │   └── ecosystem.cloud.config.js # 生产 PM2 配置
│   └── tools/                        # 实验脚本、审计报告、临时测试文件
└── 前端设计/                         # 设计稿和前端参考资料
```

## 快速开始

进入主应用目录：

```bash
cd /Users/a2026/Desktop/社媒监控/社媒监控系统/social-monitor
```

安装依赖：

```bash
npm install
```

启动开发服务：

```bash
npm run dev
```

访问本地前端：

```text
http://localhost:3000
```

使用 PM2 启动完整本地进程：

```bash
npx pm2 start ecosystem.config.js --env production
npx pm2 status
```

## 常用命令

```bash
# 构建前端
npm run build

# 运行项目验证测试
npm test

# 查看 WA 运行状态
npm run wa:runtime

# 初始化或修复 analytics.sqlite
node scripts/init-analytics-db.js

# 备份数据库
npm run db:backup

# 查看媒体存储报告
npm run media:report
```

## 数据架构

系统采用“两库分离”：

- `db/database.sqlite`：采集库，保存原始消息、媒体、群组、发送人等数据。分析层必须按只读处理。
- `db/analytics.sqlite`：分析库，保存告警、问题生命周期、日报、知识库、供应商画像、知识资产等衍生数据。

核心原则：

- 采集库只做事实留存，不写分析结果。
- 分析器通过 `analysis_cursor` 增量处理消息。
- 任何知识资产、告警、画像、情报都必须能回溯到来源消息或来源窗口。

## 知识资产模块

当前知识资产分为两层：

资产发现层：

- 从历史消息和实时消息中发现候选资产。
- 对候选内容进行去重、评分、AI 判断和自动沉淀。
- 只把低置信度或上下文不足的内容交给人工审核。

正式知识资产层：

- QA 知识库：按问题、关键词、回答步骤沉淀。
- 设备知识库：按设备/型号、故障、方案沉淀。
- 内容模板库：按客户/模板类型、模板内容、合规备注沉淀。
- 供应商画像：按供应商/群、响应、履约、技术能力、主动性等维度沉淀。
- 区域运营情报：按区域和业务板块提炼市场、价格、资源、风险、履约、效果反馈。
- 客服运营情报：按客户侧问题、诉求、风险、处理效果提炼可执行情报。
- 设备技术情报：按设备、故障、处理动作、稳定性、资源状态提炼技术情报。
- 实体关系图谱：沉淀客户、地区、运营商、通道、Sender ID、设备、联系人、供应商之间的关系。

## AI 分析原则

AI 调用统一通过 `lib/ai-client.js`，优先级为：

1. OpenAI 兼容接口
2. Gemini 备用
3. 关键词/规则降级

AI 输出必须尽量基于长上下文，而不是孤立短消息。告警和情报结论应说明：

- 发生了什么
- 涉及哪个区域、业务、供应商、客户、设备或线路
- 为什么有价值或有风险
- 目前缺少什么信息
- 下一步建议动作是什么

如果 AI 不可用或置信度不足，系统应明确标记为规则判断或待复核。

## 生产部署

生产部署使用根目录 `.deployhub/` 配置。

当前生产服务信息：

- 服务名：`social-monitor`
- 命名空间：`g1469`
- 域名：`social-monitor.tyhark.com`

生产环境使用 `社媒监控系统/social-monitor/ecosystem.cloud.config.js`。如果修改云端 PM2 配置，需要同步提升根目录 `docker-entrypoint.sh` 中的 `CLOUD_ECOSYSTEM_VERSION`，否则生产容器可能继续使用旧的持久化 PM2 配置。

部署前建议流程：

```bash
npm test
npm run build
git status --short
git add <相关文件>
git commit -m "<提交说明>"
git push
```

推送到 Codeup 后再通过 Deploy Hub 部署。

## 开发约束

- 修改 PM2 托管代码后，本地验证前需要重启对应 PM2 进程。
- 实验脚本、审计脚本、一次性报告放到 `社媒监控系统/tools/`。
- 不要向 `database.sqlite` 写入分析结果。
- 不要提交 `.env`、Token、Session、媒体文件、SQLite WAL/SHM 文件或包含敏感消息正文的报告。
- 前端改动后运行 `npm run build`。
- 后端行为改动后运行 `npm test` 或对应的定向测试。
- 生产历史回溯和知识资产批处理要限速，避免影响页面和 API 响应。

## 相关文档

- [AGENTS.md](./AGENTS.md)：Agent 协作规则和项目操作约束。
- [主应用 README](./社媒监控系统/social-monitor/README.md)：早期主应用说明。
- [知识资产路线图](./社媒监控系统/social-monitor/docs/knowledge-assets-roadmap.md)：知识资产设计和演进说明。
- [WhatsApp 采集器部署](./社媒监控系统/social-monitor/docs/whatsapp-collector-deployment.md)：采集器部署说明。
- [WhatsApp 采集迁移计划](./社媒监控系统/social-monitor/docs/whatsapp-collector-migration-plan.md)：本地采集与云端分析拆分方案。
