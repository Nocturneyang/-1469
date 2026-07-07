# 2026-07-06 工作台人工分组测试记录

## 自动化覆盖

- 创建人工一级分组。
- 创建人工二级分组，并校验父级必须存在。
- 给会话保存人工二级分组。
- 使用二级人工分组筛选会话。
- 使用父级一级人工分组筛选二级会话。
- 只有父级一级分组授权的坐席可以看到二级会话。

## 执行命令

- `npm test`
- `npm run build`
- `npm run build` in `社媒监控系统/social-monitor`

## 结果

- `npm test`：通过。沙盒内首次执行因测试服务器不能监听 `127.0.0.1` 报 `EPERM`；授权非沙盒执行后通过。
- `workbench` 前端构建：通过。Vite/Rolldown 输出第三方 `@vueuse/core` pure annotation 警告和大 chunk 警告，非本次改动引入，构建退出码为 0。
- `social-monitor` 前端构建：通过。保留既有 `/runtime-config.js` 非 module 警告，构建退出码为 0。
