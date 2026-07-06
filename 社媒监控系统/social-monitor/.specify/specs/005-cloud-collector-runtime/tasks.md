# 云端账号登录与采集运行时任务

- [x] 增加 runtime spec schema 和账号 runtime 字段。
- [x] 增加 remote-only DB 保护，禁止云端 collector 直接写主 SQLite。
- [x] 增加云端 Deploy Hub 组件编排器和 supervisor。
- [x] 接入 WA、TG Bot、TG 用户号、Teams 创建和运行时操作 API。
- [x] 增加统一 runtime API：状态、启动、停止、重启、重登。
- [x] 增加 TG/Teams 加密 session 存储。
- [x] 更新容器入口、PM2 生产配置和 Deploy Hub API Token 注入。
- [x] 前端账号卡片增加 Deploy Hub 云端组件启停控制。
- [ ] 使用测试账号在生产灰度创建 1 个 WA collector 组件。
- [ ] 灰度完成后逐个停止本地 collector 并切换同名账号到云端。
