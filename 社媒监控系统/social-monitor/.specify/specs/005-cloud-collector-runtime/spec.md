# 云端账号登录与采集运行时规格

## 目标

让 WhatsApp、Telegram Bot、Telegram 用户号和 Teams 账号都可以在管理网站中完成新增、登录、重登、停止、删除和状态查看；采集进程不再要求运行在本地电脑。

## 用户故事

- 管理员新增 WA 账号后，系统自动创建云端 collector Pod，并在账号卡片中展示二维码。
- 管理员新增 TG 用户号后，在网站中输入 API ID/Hash、手机号、验证码和 2FA，云端 collector 使用加密 session 继续采集。
- 管理员新增 Teams 账号后，通过 OAuth 授权，云端 `teams-graph` collector 自动检测 token 并采集群聊消息。
- 管理员可以对任一云端账号执行启动、停止、滚动重启、重新登录和删除操作。

## 验收标准

- 每个账号对应独立 K8s Deployment/Pod，主 `ui-server` 不直接运行采集 worker。
- 云端 collector 设置 `COLLECTOR_REMOTE_ONLY=true`，不直接打开或写入主 `database.sqlite`。
- TG 用户号 session 与 Teams token 使用固定 `ACCOUNT_SESSION_ENCRYPTION_KEY` 加密存储。
- 旧本地 collector 上报链路继续兼容；同一账号迁移到云端前需要人工停掉旧 collector。
- `GET /api/accounts` 返回云端 runtime provider、期望状态、deployment 名和 session 状态。

## 非目标

- 第一版不切换 WhatsApp Business Cloud API。
- 第一版不改变生产 `DISABLE_MEDIA_UPLOAD=1` 的媒体策略。
- 第一版不做 30 个以上账号的跨节点容量调度。
