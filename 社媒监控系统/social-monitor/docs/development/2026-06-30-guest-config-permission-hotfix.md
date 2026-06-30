# 游客配置权限收口修复记录

日期：2026-06-30

## 背景

生产域名 `social-monitor.tyhark.com` 的游客只读账号可在登录后直接访问部分管理配置 API。受影响接口包含钉钉 Webhook 配置、环境配置、内部员工识别配置、区域账号映射和价值标签配置。其中 Webhook 配置读取接口会返回 `config/webhooks.json` 原文，存在机器人 URL access token 和加签 secret 泄漏风险。

排查时还发现 SSO 开启后默认信任 `x-user-*` / `x-sso-*` 等代理注入头，若公网入口未严格剥离客户端同名请求头，可能造成身份伪造或权限提升。

## 修复内容

- `routes/config.js`：对所有配置路由统一加 `requireAdmin`，游客账号访问返回 403。
- `routes/config.js`：Webhook 列表响应只返回脱敏预览、是否已配置标记，不再返回真实 URL 或 secret。
- `routes/config.js`：拒绝把 `[redacted]`、`****` 等脱敏占位符写回 Webhook 配置。
- `server.js`：修复兼容版 `/api/config/value-labels` GET 路由，补齐管理员校验。
- `middleware/auth.js`：SSO 代理头默认不信任，必须显式设置 `SSO_TRUST_PROXY_HEADERS=true` 才读取；SSO 中声明的 admin 角色默认不直接授予管理员，必须命中 `SSO_ADMIN_USERS` 或 `sso_admins` 表，若确需信任上游 admin 角色需显式设置 `SSO_TRUST_ADMIN_ROLE=true`。
- `frontend/src/components/admin/WebhookConfig.vue`：适配脱敏 Webhook 响应，避免把脱敏占位符误保存。

## 上线注意

- 如果生产 SSO 只依赖网关注入用户头而没有可用 satoken/userinfo 校验，需要在确认公网入口会剥离客户端伪造头之后设置 `SSO_TRUST_PROXY_HEADERS=true`。
- 管理员授权建议使用 `SSO_ADMIN_USERS` 或后台 `sso_admins` 表维护，不建议开启 `SSO_TRUST_ADMIN_ROLE`。
- 已泄漏的钉钉机器人 URL 或 secret 应在钉钉侧轮换，代码修复不能使已经泄漏的密钥失效。

## 对抗性复查后的二次收口

复查发现游客读面之外还存在 Collector 接收令牌、原始媒体、知识资产审核写口、Teams OAuth 入口和默认账号初始化等攻击面。二次修复按默认安全处理：

- `routes/collector.js`：删除内置 fallback Token hash，Collector 接收端必须通过 `COLLECTOR_TOKEN` 或 `COLLECTOR_TOKEN_SHA256` 配置令牌；令牌比较改为定长安全比较。
- `routes/collector.js`：当 `COLLECTOR_TOKEN_SHA256` 已配置时优先使用 hash 校验并忽略明文 `COLLECTOR_TOKEN`，避免生产组件旧明文环境变量覆盖新 Secret 后继续放行旧 Token。
- `.deployhub/k8s/app.yaml`：生产清单显式注入 `COLLECTOR_TOKEN_SHA256` 普通环境变量；明文 `COLLECTOR_TOKEN` 仍仅从 Secret 引用，避免把上报凭证暴露到普通组件环境。
- `ecosystem.config.js`：移除本地 PM2 配置中的明文 `COLLECTOR_TOKEN`，改为从运行环境注入。历史中出现过的 Collector Token 必须视为已泄漏并轮换。
- `routes/auth.js`、`db/database.js`：默认关闭游客免密登录；新库不再自动创建 `admin/admin123` 和 `view/view`，除非显式配置 `INITIAL_ADMIN_PASSWORD` 或 `ALLOW_INSECURE_DEFAULT_USERS`；旧库保留默认密码时，登录接口默认拒绝 `admin/admin123` 和 `view/view`。
- `routes/data.js`、`server.js`：原始消息 `/api/messages`、群列表 `/api/groups` 和 `/media/*` 默认仅管理员可访问；如确需内部 viewer 访问，需要显式配置 `ALLOW_VIEWER_RAW_MESSAGES`、`ALLOW_VIEWER_RAW_DATA` 或 `ALLOW_VIEWER_MEDIA`。
- `routes/analytics.js`：知识资产 usage、promote、contact-side、review 和 review-batch 写接口补齐 `requireAdmin`。
- `server.js`：删除鉴权前的公开 Teams auth/poll 入口，仅保留 `/api/teams/*` 管理员路由。
- 前端：隐藏默认游客登录入口，将原始数据流页面标记为管理员页面，并为管理员媒体链接附加当前 JWT 以配合受保护的 `/media/*` 路由。

## 验证结果

- `node --check routes/collector.js routes/data.js routes/auth.js routes/analytics.js server.js db/database.js ecosystem.config.js`：通过。
- 临时 `DATA_DIR` 黑盒验证：游客免密登录返回 403；viewer JWT 访问 `/api/messages`、`/media/*` 和知识资产 review 写口均返回 403；管理员访问 `/api/messages` 成功；Collector 错误或缺失 Token 返回 401，正确 Token 可进入业务字段校验。
- `npm run build`：通过。
- `npm test`：仍有 2 个历史失败项，分别是 `config/account-regions.json` 的 `tg-account1` 直查用例和 `lib/staff-detector.js` 的 `A-Support` 外部联系人用例；这两个失败在本次权限收口前已存在。
