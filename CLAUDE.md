# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目结构

```
运营ai项目/
└── 社媒监控系统/
    └── social-monitor/          # 主 Node.js 应用
        ├── db/database.js       # SQLite 初始化、表结构、saveMessage()、updateAccountStatus()
        ├── workers/
        │   ├── worker-wa.js     # WhatsApp 采集进程（whatsapp-web.js + Puppeteer）
        │   └── worker-tg.js     # Telegram 采集进程（node-telegram-bot-api）
        ├── server.js            # Express REST API + 静态文件服务（端口 3000）
        ├── public/index.html    # 新拟态风格监控大屏
        ├── media/               # 下载的媒体文件（冷存储）
        ├── ecosystem.config.js  # PM2 进程配置
        ├── .env                 # TG_BOT_TOKEN（已 gitignore，参考 .env.example）
        └── start.command / stop.command  # Mac 双击启动/停止脚本
```

## 运行系统

所有命令在 `社媒监控系统/social-monitor/` 目录下执行：

```bash
# 启动所有进程（推荐）
npx pm2 start ecosystem.config.js --env production

# 常用 PM2 命令
npx pm2 status                   # 查看所有进程状态
npx pm2 logs worker-wa-1         # WhatsApp 进程日志（首次运行在此扫码）
npx pm2 logs worker-tg-1         # Telegram 进程日志
npx pm2 restart all              # 重启所有进程
npx pm2 stop all                 # 停止所有进程
npx pm2 save                     # 持久化 PM2 进程列表
```

Web 监控面板：http://localhost:3000

项目未配置自动化测试（`npm test` 会直接报错退出）。

## 架构说明

**PM2 多进程设计：**
- 每个 WhatsApp 账号作为独立的 `worker-wa-{name}` 进程运行，Puppeteer/Chromium 会话独立存储在 `whatsapp-session-{accountName}/` 目录
- 每个 Telegram Bot 作为独立的 `worker-tg-{name}` 进程运行，使用长轮询方式
- `ui-server` 运行 `server.js`，提供 REST API 和静态文件服务
- 所有 worker 共享同一个 SQLite 数据库（`db/database.sqlite`，WAL 模式）

**数据流：**
1. Worker 接收 WhatsApp/Telegram 消息 → 将媒体文件下载至 `media/` → 调用 `db/database.js` 中的 `saveMessage()`
2. `saveMessage()` 使用 `INSERT ... ON CONFLICT(platform, message_id) DO NOTHING` 实现幂等写入，防止重复数据
3. `server.js` 对外暴露 REST API（`/api/stats`、`/api/messages`、`/api/accounts`），供前端大屏消费

**动态账号创建：**
`POST /api/accounts/create` 会在运行时修改 `ecosystem.config.js` 并启动新的 PM2 进程。`accounts` 表实时跟踪各账号的 QR 码和鉴权状态，供大屏展示连接情况及渲染 WhatsApp 登录二维码。

**关键环境变量：**
- `TG_BOT_TOKEN` — Telegram Bot Token（写在 `.env`，由 `worker-tg.js` 通过 dotenv 读取）
- `ACCOUNT_NAME` — WhatsApp 账号标识符，在 `ecosystem.config.js` 中按进程单独配置
- `TG_ACCOUNT_NAME` — Telegram 账号标识符，在 `ecosystem.config.js` 中按进程单独配置
- `PORT` — Web 服务端口（默认：3000）

## 新增账号

**通过 UI：** 在大屏点击「+ 新增设备」按钮，会调用 `POST /api/accounts/create`，自动更新 `ecosystem.config.js` 并启动新 PM2 进程。

**手动添加（WhatsApp）：** 在 `ecosystem.config.js` 的 `apps` 数组中新增一条记录，设置唯一的 `name` 和 `ACCOUNT_NAME` 环境变量，然后运行 `npx pm2 start ecosystem.config.js`。

**手动添加（Telegram）：** 同上，但需在 env 块中额外包含 `TG_BOT_TOKEN`。
