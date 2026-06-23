# 评审清单

- [ ] 云端 collector Pod 中 `COLLECTOR_REMOTE_ONLY=true`。
- [ ] `ACCOUNT_SESSION_ENCRYPTION_KEY` 已作为生产 Secret 配置。
- [ ] `COLLECTOR_TOKEN` 在主服务和 collector Pod 中一致。
- [ ] 旧本地 collector 已在迁移同账号前停止。
- [ ] WA 账号每次只并发初始化一个，避免 Chrome 资源打满。
- [ ] API/前端不会回显 token、session、手机号或消息正文。
