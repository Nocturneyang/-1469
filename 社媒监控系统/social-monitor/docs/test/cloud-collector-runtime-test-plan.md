# 云端采集运行时测试计划

## 本地检查

- 对新增后端文件执行 `node --check`。
- 执行 `npm test`。
- 前端执行 `npm run build`。

## 集成场景

- 创建 WA 测试账号，确认生成 K8s Deployment、账号卡片显示 QR、扫码后状态变为 authenticated。
- 创建 TG Bot 测试账号，确认 token 从账号专属环境配置读取，群消息通过 collector API 入库。
- 创建 TG 用户号，完成验证码和 2FA，确认 session 写入加密文件且 `.env` 不新增明文 session。
- 创建 Teams 账号，完成 OAuth，确认 token 写入新加密路径且 collector 进入 authenticated。
- 停止、启动、滚动重启、重新登录和删除账号，确认 Deployment 与数据库状态一致。

## 生产灰度

- 先灰度 1 个低风险账号。
- 停止同名本地 collector 后再创建云端 runtime。
- 观察 24 小时 heartbeats、消息入库、分析器延迟和容器资源。
