# TG 用户号登录 API 凭据

TG 用户号使用 MTProto 登录时，需要同一 Telegram App 的 `api_id` 和 `api_hash`。工作台现在支持两种用户号接入方式：

1. 默认方式：`TG 用户号登录`
2. 高级导入：`导入 StringSession`

默认方式不再要求人工生成 `StringSession`。登录页要求同时提交：

- `TG API ID`
- `App api_hash`
- `手机号`

提交后，登录 worker 会向 Telegram 发送验证码。管理员在登录任务卡片中输入验证码；如果账号启用了 Telegram 二步验证，再输入二步密码。worker 校验成功后自动生成并保存最终 `StringSession`。

工作台 API 只在一次性门铃中携带手机号、验证码或二步密码；登录任务列表和任务详情只返回脱敏 `credential_hint`，不会返回 `api_hash`、验证码、二步密码或完整 session。

登录 worker 发码后，会把临时 MTProto session、`phone_code_hash`、`api_id` 和 `api_hash` 写入对应账号 `session/` 目录的 pending 文件。校验成功后删除 pending 文件，并把最终 `api_id` / `api_hash` / `StringSession` 写入该账号 TG session 凭据文件。后续每账号 `account-runtime-worker` 会优先读取账号凭据中的值。旧部署仍兼容环境变量兜底：

```text
WORKBENCH_TG_API_ID
WORKBENCH_TG_API_HASH
WORKBENCH_TG_API_ID_{ACCOUNT}
WORKBENCH_TG_API_HASH_{ACCOUNT}
```

高级导入方式仍支持粘贴已有 `StringSession`，用于迁移历史账号。TG Bot 登录仍只需要 Bot Token。
