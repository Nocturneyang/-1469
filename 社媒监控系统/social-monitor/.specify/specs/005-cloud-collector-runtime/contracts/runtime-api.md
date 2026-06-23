# Runtime API Contract

## GET `/api/accounts/:id/runtime`

返回指定账号的云端 runtime spec 和 K8s Deployment 状态。

```json
{
  "success": true,
  "data": {
    "spec": {
      "account_id": "wa-demo",
      "platform": "whatsapp",
      "desired_state": "running",
      "deployment_name": "sm-collector-wa-demo",
      "session_dir": "/data/collector-sessions/wa/session-demo"
    },
    "deployment": {}
  }
}
```

## POST `/api/accounts/:id/runtime/:action`

`action` 允许值：`start`、`stop`、`restart`、`relogin`。

成功响应：

```json
{
  "success": true,
  "message": "Runtime restart command sent."
}
```

错误响应：

```json
{
  "success": false,
  "error": "Runtime spec not found"
}
```
