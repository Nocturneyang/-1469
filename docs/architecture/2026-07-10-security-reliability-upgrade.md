# 工作台安全与可靠性升级

## 安全默认

- 工作台会话使用服务端校验、可撤销的 HttpOnly Cookie；浏览器不保存 SSO Token。
- CORS 默认同源，写请求校验 Origin 和 CSRF Token。
- `operators.status != active` 或显式入口权限为 0 时立即拒绝。
- 真实发送总开关和新账号发送开关默认关闭。
- 工作台数据库路径不得指向监控项目，任何环境不提供绕过开关。

## 外发账本

仍遵循：

```text
DB = 账本
文件 = 门铃
定时扫描 = 保险
```

增加原生引用、WA ACK 回执、失败分类、`dead`、Telegram FloodWait/PeerFlood 冷却和账号级限速。TG 无可靠送达回执时以 `sent` 为最终成功状态。

## 媒体

入站媒体写入账号隔离目录，SQLite 只保存相对路径和元数据。媒体下载接口必须重新校验账号及会话查看权限；HTML、SVG和可执行类型不能内联预览。

## 运行健康

- `/healthz` 只表示 API 进程存活。
- `/readyz` 在生产渠道运行态必需时检查数据库、Worker 租约、任务积压和过期发送任务。
- Supervisor 分别限制 WA/TG Worker 容量，并公开容量等待状态。
- 全局库和账号库必须可在线备份、校验和恢复到临时目录。

