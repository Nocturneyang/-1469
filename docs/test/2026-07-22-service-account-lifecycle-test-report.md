# 服务账号退出与删除测试报告

日期：2026-07-22

## 验证范围

- 退出登录仅清理渠道 session，保留账号配置、历史消息和外发记录。
- 有活跃 worker 时先进入 `logout_requested`，由对应 worker 执行渠道退出。
- 没有活跃 worker 时可直接清理本地 session 并进入 `logged_out`。
- 永久删除要求账号已离线、没有活跃 runtime lease，并校验“删除历史与配置”和账号名两项确认字段。
- 前端永久删除采用两次确认，第二次明确提示所有历史消息及配置将不可恢复。

## 执行结果

- `npm test`：通过。
- `npm run build`：通过；仅出现第三方 `@vueuse/core` 的既有 Rolldown annotation 警告。
- 相关后端文件 `node --check`：通过。
- 账号隔离测试覆盖 active lease、退出保留数据、清 session、未确认删除拦截和确认后删除。

## 生产影响

部署功能本身不会自动退出或删除任何真实服务账号；只有管理员在页面确认操作后才会调用对应生命周期接口。`Ally-Zhong` 在发布过程中保持登录和运行状态。
