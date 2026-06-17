# 多平台社媒监控系统 - 第4/5阶段开发交付与总结

根据《多平台社媒监控_7步开发方案》和您的指示，我们已经全量完成了【Phase 4 和 Phase 5】的基础建设，成功实现了“仅接收+持久化存储”和“底层隔离”这两大重构目标。以下是此次交付的架构成果。

## 架构变化亮点

> [!TIP]
> 摒弃了原系统容易卡死和数据丢失的单体 JSON 文件读写模型，现在基于 `better-sqlite3` 实现了 SQLite 本地高并发落盘（WAL 模式），大大增强了稳健性和性能。

本次已在 `social-monitor` 根目录部署以下核心部分：

1. **环境与运行层基建**：
   - 自动全局安装了 `pm2`
   - 使用 `package.json` 引进了稳定的依赖关系。对于 Puppeteer 的安装也做了环境规避处理，已自动挂载并适配了您本机的 Google Chrome 作为渲染内核。
   - `ecosystem.config.js` 分离配置：WA (分配 1G 重启阈值硬保护) 和 TG 同步隔离运行。

2. **数据库结构确立：**
   - 见：[db/database.js](file:///Users/a2026/Desktop/运营ai项目/社媒监控系统/social-monitor/db/database.js)
   - 建立了包含 `has_media` 和 `media_path` 等新属性的 `messages` 关系表。加入了组合索引主键以物理防御死循环。

3. **双平台收集引擎**：
   - **WhatsApp：** [worker-wa.js](file:///Users/a2026/Desktop/运营ai项目/社媒监控系统/social-monitor/workers/worker-wa.js) 从原老版项目中剥离，直接支持保存图片多媒体至 `media/`。
   - **Telegram**：[worker-tg.js](file:///Users/a2026/Desktop/运营ai项目/社媒监控系统/social-monitor/workers/worker-tg.js) 全新构建，集成了从电报接口捕获高质量原片 `photo` 与原图 `document` 以及处理获取 `msg.chat.title` (群名) 的存入逻辑。

## 如何验证与后续使用

> [!IMPORTANT]
> WhatsApp 初次登录需要扫码！鉴于其运行在后台 Daemon 进程中，您可以通过日志来获取二维码。

### 查看 WhatsApp 二维码及日志
目前系统已经在 PM2 后台常驻守护并自启动，您只需在终端运行以下命令即可查看实时系统运转日志：
```bash
pm2 logs worker-wa
```
请在终端中用手机 WhatsApp 扫描出现的大尺寸二维码，扫描成功后即可保持持久登录。

### 更新 Telegram 配置
请将您的 Bot Token （于 @BotFather 获取）填入 `.env` 文件。
然后运行以下命令重启电报采集进程以使 Token 生效：
```bash
pm2 restart worker-tg
```

系统未来均可通过查看可视化控制文件 `database.sqlite` 来确保数据正在稳定收取。如果您需要我为您拉取测试一下某个平台的效果，或者启动后续规划开发，请随时告诉我。
