# Microsoft Teams OAuth 2.0 授权配置指南

## 概述

新的 Teams 登录流程使用 Microsoft Graph API 和 OAuth 2.0，支持两种授权模式：

1. **设备代码流（Device Code Flow）** - 推荐用于个人账户
2. **授权码流（Authorization Code Flow）** - 用于企业账户

### 主要改进

- **用户体验更好**：无需服务器端手动操作
- **更稳定可靠**：使用官方 API，不受 Teams UI 变更影响
- **安全性更高**：OAuth 2.0 标准授权流程，Token 加密存储
- **信息更完整**：获取用户 ID、邮箱、显示名称等完整信息
- **自动刷新**：Token 过期自动刷新，无需频繁重新授权
- **个人账户支持**：设备代码流无需 Azure Portal 注册

## 授权模式选择

### 设备代码流（推荐个人账户）

**适用场景**：
- 个人 Microsoft 账户（@outlook.com、@hotmail.com）
- 无法访问 Azure Portal
- 快速部署

**优势**：
- 无需在 Azure Portal 注册应用
- 使用 Microsoft 公共客户端 ID
- 配置简单，只需设置加密密钥

### 授权码流（企业账户）

**适用场景**：
- 企业 Microsoft 账户（@company.com）
- 需要自定义应用配置
- 需要更细粒度的权限控制

**要求**：
- 需要在 Azure Portal 注册应用
- 需要配置重定向 URI

## 配置步骤

### 方案一：设备代码流（推荐）

#### 1. 配置环境变量

在 `.env` 文件中添加以下配置：

```bash
# 授权模式：设备代码流
TEAMS_AUTH_MODE=device

# Token 加密密钥（用于加密存储 access_token 和 refresh_token）
# 生成方法：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
TEAMS_TOKEN_ENCRYPTION_KEY=随机生成的32字节十六进制字符串
```

设备代码流使用 Microsoft 公共客户端 ID，无需配置 `MICROSOFT_GRAPH_CLIENT_ID` 和 `MICROSOFT_GRAPH_CLIENT_SECRET`。

#### 2. 使用新 Worker

更新 `ecosystem.config.js`，将 Teams worker 的脚本路径改为新的 Graph API 版本：

```javascript
{
  name: "worker-teams-account1",
  script: "./workers/worker-teams-graph.js",
  max_memory_restart: '600M',
  instances: 1,
  autorestart: true,
  watch: false,
  env: { NODE_ENV: "production", ACCOUNT_NAME: "account1" }
}
```

#### 3. 完成授权

1. 启动服务后，访问管理界面
2. 创建 Teams 账号（或使用现有账号）
3. 点击"授权"按钮，系统会返回设备代码和验证链接
4. 在浏览器中打开验证链接，输入设备代码
5. 完成登录和授权
6. 系统自动轮询授权状态，完成后账号状态变为"已授权"

### 方案二：授权码流（企业账户）

#### 1. 在 Azure Portal 注册应用

1. 访问 [Azure Portal - 应用注册](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. 点击"新注册"
3. 填写以下信息：
   - **名称**：Social Monitor Teams（或自定义名称）
   - **支持的账户类型**：选择"任何组织目录(任何 Azure AD 目录 - 多租户)中的账户"
   - **重定向 URI**：选择"Web"，输入 `http://localhost:3000/api/teams/callback`
4. 点击"注册"

#### 2. 获取客户端凭据

1. 在应用概览页面，记录以下信息：
   - **应用程序(客户端) ID**：这是 `MICROSOFT_GRAPH_CLIENT_ID`
2. 点击左侧菜单"证书和机密"
3. 点击"新建客户端机密"
4. 填写描述（如"Social Monitor"），选择过期时间
5. 点击"添加"
6. 记录机密的**值**（这是 `MICROSOFT_GRAPH_CLIENT_SECRET`，只显示一次）

#### 3. 配置 API 权限

1. 点击左侧菜单"API 权限"
2. 点击"添加权限" → "Microsoft Graph"
3. 选择"委托的权限"，搜索并添加以下权限：
   - `Chat.Read` - 读取聊天消息
   - `Chat.ReadBasic` - 读取基本信息
   - `User.Read` - 读取用户信息
   - `User.ReadBasic.All` - 读取所有用户基本信息
4. 点击"添加权限"
5. 点击"授予管理员同意"（如果是管理员账号）

#### 4. 配置环境变量

在 `.env` 文件中添加以下配置：

```bash
# 授权模式：授权码流
TEAMS_AUTH_MODE=code

# Microsoft Graph 应用注册信息
MICROSOFT_GRAPH_CLIENT_ID=你的客户端ID
MICROSOFT_GRAPH_CLIENT_SECRET=你的客户端机密

# OAuth 回调地址（必须与 Azure Portal 中配置的重定向 URI 一致）
MICROSOFT_GRAPH_REDIRECT_URI=http://localhost:3000/api/teams/callback

# Token 加密密钥
TEAMS_TOKEN_ENCRYPTION_KEY=随机生成的32字节十六进制字符串
```

#### 5. 完成授权

1. 启动服务后，访问管理界面
2. 创建 Teams 账号（或使用现有账号）
3. 点击"授权"按钮，系统会跳转到 Microsoft 登录页面
4. 完成登录和授权
5. 授权成功后，页面会自动关闭，账号状态变为"已授权"

## API 接口说明

以下接口均挂在管理员鉴权之后，不能作为公网匿名 OAuth 入口使用。

### 获取授权信息

```
GET /api/teams/auth/:name
```

设备代码流返回：
```json
{
  "success": true,
  "mode": "device",
  "userCode": "ABC123",
  "verificationUri": "https://microsoft.com/devicelogin",
  "message": "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABC123 to authenticate.",
  "expiresIn": 900
}
```

授权码流返回：
```json
{
  "success": true,
  "mode": "code",
  "authUrl": "https://login.microsoftonline.com/..."
}
```

### 轮询设备代码授权状态（仅设备代码流）

```
GET /api/teams/poll/:name
```

返回：
```json
{
  "success": true,
  "pending": true
}
```

授权成功后返回：
```json
{
  "success": true,
  "pending": false,
  "authorized": true,
  "userInfo": {
    "id": "...",
    "displayName": "...",
    "mail": "...",
    "userPrincipalName": "..."
  }
}
```

### OAuth 回调（仅授权码流）

```
GET /api/teams/callback?code=...&state=...
```

自动处理授权回调，保存 token 和用户信息。

### 检查授权状态

```
GET /api/teams/status/:name
```

返回：
```json
{
  "success": true,
  "authorized": true,
  "userInfo": {
    "id": "...",
    "displayName": "...",
    "mail": "...",
    "userPrincipalName": "..."
  }
}
```

### 手动刷新 Token

```
POST /api/teams/refresh/:name
```

### 重新授权

```
POST /api/teams/relogin/:name
```

清除现有 token，需要重新完成授权流程。

## 故障排查

### 设备代码流

#### 授权超时
- 设备代码有效期为 15 分钟，请在有效期内完成授权
- 重新获取设备代码

#### 授权被拒绝
- 用户拒绝了授权请求
- 重新发起授权流程

### 授权码流

#### 授权失败
- 检查 `MICROSOFT_GRAPH_CLIENT_ID` 和 `MICROSOFT_GRAPH_CLIENT_SECRET` 是否正确
- 检查重定向 URI 是否与 Azure Portal 配置一致
- 检查 API 权限是否已授予管理员同意

### 通用问题

#### Token 刷新失败
- 检查 `TEAMS_TOKEN_ENCRYPTION_KEY` 是否一致
- 如果 refresh_token 过期，需要重新授权

#### API 调用失败
- 检查网络连接
- 检查 API 权限是否正确配置
- 查看日志中的具体错误信息

## 迁移说明

从旧的 Playwright 方案迁移到新的 Graph API 方案：

1. 选择授权模式（个人账户推荐设备代码流）
2. 按照对应方案完成配置
3. 更新 ecosystem.config.js 使用新的 worker
4. 重启 PM2 服务：`pm2 restart all`
5. 在管理界面为每个 Teams 账号完成授权
6. 验证消息采集是否正常

旧的 Playwright 相关文件可以保留作为备用，但建议在确认新方案稳定后删除：
- `lib/teams-session-store.js`
- `lib/teams-page-parser.js`
- `workers/worker-teams.js`
