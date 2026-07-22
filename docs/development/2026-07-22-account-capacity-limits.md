# 生产服务账号容量限制

日期：2026-07-22

生产工作台采用“允许新增多个账号、在线容量超限排队”的方式管理渠道账号：

- WA 在线 worker 上限：5。
- TG 在线 worker 上限：8。
- WA/TG 在线 worker 总上限：13。
- WA 扫码登录并发：1；其余 WA 登录任务保留在队列中等待。
- TG 登录流程并发：1；登录 worker 的轮询不可重入。
- 容器内存上限：8Gi。

在线容量限制只控制 runtime worker 数量，不删除账号、session、历史消息或配置。超过容量的已认证账号显示为 `capacity_waiting`，有名额后由 supervisor 自动启动。
