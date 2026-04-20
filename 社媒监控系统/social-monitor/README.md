# Social Monitor (多平台社媒监控系统)

这是一个用于捕获和持久化存储多平台(WhatsApp, Telegram 等)群聊原始数据的独立后台监控系统。系统通过全量采集、防撞锁与媒体冷热分离的存储策略，提供了一套极为稳健的“纯净”数据流中枢底座。附带了极具高级审美质感的新拟态 (Neumorphism) Web 大屏监控面板。

## 🔑 准备工作与初次配置

**对于 Telegram：**
1. 找到项目目录下的 `.env` 文件。
2. 使用任何文本编辑器打开它，将其中的 `TG_BOT_TOKEN="your_telegram_bot_token_here"` 替换成您找 @BotFather 申请到的机器人 Token 密钥。

**对于 WhatsApp：**
1. 无需额外配置，您只需确保本机安装了 Google Chrome 浏览器。
2. 初次启动程序时请查看后台日志，扫描 WhatsApp 返回的二维进行设备登入。(一旦登录成功，数据将持久保存在本地的 `whatsapp-session` 目录中，日后启动无需再扫码)。

## 🖥️ 服务器部署指南

适用于 Linux 服务器（Ubuntu / CentOS）生产环境部署。

### 1. 环境准备

```bash
# 安装 Node.js 18+（以 Ubuntu 为例）
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 PM2
npm install -g pm2

# 安装 Chromium 依赖（Puppeteer 运行 WhatsApp 所需）
sudo apt-get install -y chromium-browser \
  libgbm-dev libxkbcommon-dev libglib2.0-dev \
  libnss3 libatk-bridge2.0-0 libgtk-3-0
```

### 2. 克隆并安装依赖

```bash
git clone <repo-url>
cd 社媒监控系统/social-monitor
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
vim .env   # 填写以下配置项
```

| 变量 | 说明 | 是否必填 |
|------|------|----------|
| `TG_BOT_TOKEN` | Telegram Bot Token（从 @BotFather 获取） | Telegram 必填 |
| `SYNC_URL` | 中台数据同步接口地址 | 必填 |
| `SYNC_TOKEN` | 中台 Bearer Token | 必填 |
| `MEDIA_BASE_URL` | 本机对外访问地址，如 `http://1.2.3.4:3000` | 必填 |
| `PORT` | Web 服务端口，默认 3000 | 可选 |

### 4. 启动服务

```bash
npx pm2 start ecosystem.config.js --env production
npx pm2 save          # 持久化进程列表

# 设置开机自启（按提示执行输出的命令）
pm2 startup
```

### 5. WhatsApp 首次扫码

```bash
npx pm2 logs worker-wa-1   # 查看日志，等待二维码出现后扫码登录
```

或访问 `http://your-server-ip:3000` 在大屏上直接扫码。会话保存在 `whatsapp-session-{accountName}/`，重启后无需重新扫码。

### 6. 验证运行状态

```bash
npx pm2 status           # 所有进程应显示 online
curl localhost:3000/api/stats   # 返回 JSON 表示 API 正常
```

---

## 🚀 启动与使用指南 (Mac 用户专属)

我们已经为您准备好了自动化的“傻瓜式”启动器，不仅能在终端运行，也原生支持鼠标双击执行。

### 方式 A：鼠标双击运行 (最便捷)
1. 赋予执行权限 (仅需操作一次)：打开您的 Mac `终端(Terminal)`，复制输入并敲击回车执行：
   `chmod +x ~/Desktop/运营ai项目/社媒监控系统/social-monitor/*.command`
2. 进入目录：打开桌面文件夹 `/Desktop/运营ai项目/社媒监控系统/social-monitor`
3. 启动指令：双击运行 **`start.command`**（即可自动挂起数据流及所有的 Web 服务支持，同时会弹出 WA 日志界面等待扫码。按 `Ctrl + C` 可退出小黑窗查看区，后台将继续值守。）
4. 退出系统：双击运行 **`stop.command`** 进行优雅的全线进程退出。

### 方式 B：终端高级运行命令
习惯命令行的极客用户，直接使用 `PM2` 面板：
- **启动所有的进程后台：** `npx pm2 start ecosystem.config.js --env production`
- **查看当前的运行状态（任务管理器）：** `npx pm2 status`
- **监控 WhatsApp 扫码/错误日志：** `npx pm2 logs worker-wa`
- **重启群组拉取等更新：** `npx pm2 restart all`
- **停止全域系统：** `npx pm2 stop all`

## 📊 新拟态数据观测中心 (Web UI)

本套系统不仅是黑核数据吞吐库，我们还在本地开放了一层**可视化控制台大屏面板**供人直观监测：
> **请在运行了上面的启动器后，打开浏览器访问这串网址** 👇
> 👉 **[http://localhost:3000](http://localhost:3000)**

这是一个拥有极度玻璃物理反馈的“原生美学瀑布流”：
- [全盘态势 Dashboard] 汇聚统计全部已截获的消息和各渠道占比。
- [带图聊天数据流 Feed] 支持带图消息相册预览显示。可以直接看到发出人、内容、与精准时间轨迹。

## 💾 核心数据架构说明 (写给数据开发者)
此架构经过工业级重构，确保永远不会“死磕”数据和重复漏抓，底层数据规范标准如下：

1. **强事务数据仓库 (SQLite - WAL模式)：** 
   所有对话记录一律被封存在 `db/database.sqlite` 的 `messages` 关系表中。依靠极其坚固的组合唯一主键限制约束：`UNIQUE(platform, message_id)` ，以 `ON CONFLICT DO NOTHING` 完成并发过滤（网络断线或重发也绝不再惧怕产生死循坏写入）。
2. **多媒体存储冷热分离中心：** 
   只要机器人或探针发现发言附带相片媒体实体，实体文件均会被全速下载至 `media/` 底层物理目录(也就是"冷库")；随后仅将对应的相对路径映射（如 `media/xxxx.jpg`）记录在数据库 `media_path` "热库" 之中。保障了数据库的体积极致轻盈。

3. **数据字典 (`messages` 归一化表结构)：** 
   无论前端何种渠道，统一脱水提纯为以下字段池存储：
   | 字段名称       | 类型       | 说明 |
   |--------------|------------|------|
   | `id`         | INTEGER    | 内部自增主键索引 |
   | `platform`   | TEXT       | 采集来源渠道 (`whatsapp` 或 `telegram`) |
   | `message_id` | TEXT       | 该渠道原生分配的唯一消息码（连同平台字段组成唯一防重锁）|
   | `group_id`   | TEXT       | 社群内部的系统识别 ID |
   | `group_name` | TEXT       | 所属社群或频道的显示名称 |
   | `sender_id`  | TEXT       | 发言人的系统识别码 |
   | `sender_name`| TEXT       | 发言人的具体昵称/称呼 |
   | `content`    | TEXT       | 聊天的原始文本内容 |
   | `has_media`  | BOOLEAN    | 判定本条消息是否挂载了图片附件 (1 为是，0 为否) |
   | `media_path` | TEXT       | 若有附件，指向本地物理文件的链接 (例如 `media/TG_photo_123.jpg`) |
   | `timestamp`  | INTEGER    | 基于平台原消息发出的 10/13 位秒级精确时间戳 |
   | `is_synced`  | INTEGER    | 数据同步标记 (0 为未同步至中心服务器，1 为已同步) |
   | `raw_data`   | TEXT       | 平台原生传输的底层 JSON Payload 全本备份 |
   | `created_at` | DATETIME   | 录入监控系统库内的时间标记 |

## 🗺️ 当前开发进度说明 (基于七步开发方案)

本系统正在严格按照《多平台社媒监控_7步开发方案》文档落地。目前整体已平稳推进至 **全量数据采集与中心推流阶段**。

### ✅ 已达成里程碑 (已清点交付)
- [x] **极高鲁棒性进程调度基建**：由 PM2 完全接管的多核并发体系，同时支持多节点平行运行（支持在一台主机挂载 N 个独立 WA 及 Telegram 机器人），实现了防死锁与自动拉起。
- [x] **全无代码视效版控面板**：完全不需要写代码，直接在一个纯 UI 管理网页上点击 `[+ 新增设备]`，后台便会全自动搭建部署新的 PM2 引擎分配任务。自带数据直观化管理和相册瀑布流展示 (Neumorphism UI)。
- [x] **坚实的数据拦截底座模型 (全本存储)**：建立基于独立隔离表和带本地时间 (UTC+8) 的 SQLite WAL 数据库系统，确立了绝对核心规则：“不怕撞号并发、自动排重去噪、连同附件分层冷储”。新增了 `receiver_account` 溯源节点追踪。
- [x] **独立防断血浏览器安全壳**：WhatsApp 端采用独立冷库挂载了 Chromium 服务版，告别传统对 Mac 系统本地谷歌浏览器的占用及互相崩溃问题。
- [x] **动态画板二维登入**：底层产生的鉴权 Base64 QR 已深度直连前端的网页端渲染引擎，直接面向大屏用手机一扫即登，大幅降低门槛。
- [x] **异步无损数据穿透 (Data Sync Agent)**：独立建立并挂载了一根防坠毁数据长臂 (`sync-agent`)，每 10 秒自动静默轮询未分发的数据（`is_synced=0`），成功将其封包（带时间戳处理与媒体 URL 拼装）推送至外部 PHP/Laravel 中控服务器，达成闭环。

### ⏳ 下一步即将启动的核心动作 (Pending)
- [ ] **AI 黑盒核心双拆分研发**：按照路线即将破冰核心架构：开发两套脱离采集端绝对独立的 `supplier-analyzer.js` （处理防崩与告警降噪）与 `client-analyzer.js` （沉淀舆情画像）。
- [ ] **打通两路闭环系统接驳端口**：准备开启 CRM 相关业务推送探针（企微体系 / 第三方工单）。
- [ ] **Teams 及 WeCom 攻坚**：打通相关授权鉴权回调，最终合并至四大家族监听矩阵中心。
