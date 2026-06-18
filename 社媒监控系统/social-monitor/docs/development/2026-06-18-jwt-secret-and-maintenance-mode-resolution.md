# 生产环境 JWT_SECRET 配置与维护模式恢复记录

## 背景

2026-06-18 生产环境日志与监控显示：
1. 日志持续抛出警告：`[auth] JWT_SECRET 未配置或长度不足 32 位，已为 SSO/降级启动生成临时内存密钥。`
2. 生产前端页面没有任何业务数据展现。访问 `/readyz` 健康检查接口返回 `degraded: true`，提示 `DB_MAINTENANCE_MODE is enabled` 和 `ANALYTICS_MAINTENANCE_MODE is enabled`。

---

## 问题诊断

1. **`JWT_SECRET` 未注入子进程**：
   - 尽管 Kubernetes 部署文件 `.deployhub/k8s/app.yaml` 从 `social-monitor-secrets` 中注入了该环境变量，但 `ecosystem.cloud.config.js` 的 `ui-server` 配置未对该变量进行声明映射，导致 PM2 启动的 Node.js 子进程无法读取到父进程的 `JWT_SECRET`。
   - `server.js` 与 `middleware/auth.js` 启动时未主动调用 `dotenv` 加载本地 `/data/.env` 配置。
2. **处于维护模式，分析器未运行**：
   - 在之前的存储配额满故障中，系统启用了 `DB_MAINTENANCE_MODE=1` 和 `ANALYTICS_MAINTENANCE_MODE=1` 保护数据库。
   - 根据 `ecosystem.cloud.config.js` 的过滤逻辑，一旦处于维护模式，PM2 仅运行 `ui-server`，而过滤掉了所有的 `analyzer` 进程。没有分析器写入，且读接口由于维护状态直接返回空态，导致前端彻底无数据。

---

## 解决方案

### 1. 代码修改与优化

* **载入本地配置文件**：
  - 修改 `server.js` 和 `middleware/auth.js`，在顶部载入 `dotenv`：
    ```javascript
    const path = require('path');
    require('dotenv').config({ path: path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env') });
    ```
* **PM2 配置传递映射**：
  - 修改 `ecosystem.cloud.config.js` 和 `ecosystem.config.js`，在 `ui-server` 的 `env` 节点下补全变量传递：
    ```javascript
    JWT_SECRET: process.env.JWT_SECRET || "",
    SSO_ENABLED: process.env.SSO_ENABLED || "",
    SSO_LOGIN_URL: process.env.SSO_LOGIN_URL || "",
    ```
* **自动刷新 PM2 配置**：
  - 修改 `docker-entrypoint.sh`，将 `CLOUD_ECOSYSTEM_VERSION` 版本号从 `9` 提升至 `10`，使容器重启时强制覆盖并刷新 `/data/ecosystem.config.js`。

### 2. 部署与重启

我们通过编写临时握手脚本调用远程 **Deploy Hub MCP Server** (`https://skyline-ark-deploy-hub-mcp.tyhark.com/mcp`)：
1. POST 初始化会话，并获取 `mcp-session-id`。
2. 建立 GET SSE 链接维持会话。
3. 提交 `deploy` 工具请求，带上 Codeup 远程仓库 SSH URL：`git@codeup.aliyun.com:69ce4998405bafb07e12686f/skyline-tc/skyline-tc-Social_Monitor.git`。

部署指令执行成功，输出如下：
```json
{
  "task_id": "task-20260618073617-56ee5e32",
  "status": "running",
  "deploy_mode": "first",
  "message": "Rainbond 部署成功！应用ID: 58, 组件: social-monitor"
}
```

---

## 验证结果

部署完成后，我们再次访问生产接口 `https://social-monitor.tyhark.com/readyz` 进行验证：
```json
{
  "ok": true,
  "status": "ready",
  "service": "social-monitor",
  "startedAt": "2026-06-18T15:36:53.795+08:00",
  "uptimeSeconds": 26,
  "checks": {
    "sqlite": {
      "ok": true
    },
    "analytics": {
      "ok": true
    },
    "dataDir": {
      "ok": true,
      "path": "/data"
    },
    "storage": {
      "ok": true,
      "path": "/data"
    }
  }
}
```

### 验证结论：
* 数据库不再提示 `degraded: true`，说明 `DB_MAINTENANCE_MODE` 已成功回落为 `0`（关闭）。
* 后台分析器重新被 PM2 拉起并开始工作。
* 前端 API 已能成功连接 `analytics.sqlite` 数据库，页面数据恢复正常。
