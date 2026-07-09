# TG 用户号登录 API 凭据

TG 用户号使用 MTProto `StringSession` 登录时，需要同一 Telegram App 的 `api_id` 和 `api_hash`。工作台登录页现在在 `TG 用户 Session` 模式下要求同时提交：

- `TG API ID`
- `App api_hash`
- `TG 用户 Session`

提交后，工作台 API 只在登录任务门铃中携带这些一次性凭据；登录任务列表和任务详情只返回脱敏 `credential_hint`，不会返回 `api_hash` 或完整 session。

登录 worker 校验成功后，会把 `api_id` / `api_hash` 写入对应账号的 TG session 凭据文件，后续每账号 `account-runtime-worker` 会优先读取账号凭据中的值。旧部署仍兼容环境变量兜底：

```text
WORKBENCH_TG_API_ID
WORKBENCH_TG_API_HASH
WORKBENCH_TG_API_ID_{ACCOUNT}
WORKBENCH_TG_API_HASH_{ACCOUNT}
```

这只影响 TG 用户号；TG Bot 登录仍只需要 Bot Token。
