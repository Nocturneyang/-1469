# TG 会话实时与媒体展示修复

日期：2026-07-14

## 问题

- TG user worker 先下载媒体、再写入消息，大图或网络延迟会阻塞文本出现。
- TG 图片使用 `application/octet-stream` 和无扩展名文件名，媒体 API 只能下载，不能安全地内联预览。
- 会话靠 1.5 秒轮询刷新，新页面数据会覆盖用户已加载的旧历史。
- TG 原始记录未物化群名、发送人、用户名、引用、转发、编辑和媒体详情。

## 实现

### Worker

`workers/account-runtime-worker.js` 在收到 TG user 消息后立即写入一条可展示记录，然后并行执行：

- 解析 chat / sender entity。
- 下载媒体并写入工作台账号自己的 `media/` 目录。
- 第二次幂等 upsert 补齐名称、MIME、大小、引用、转发和阅读数等数据。

图片统一标记为 `image/jpeg` 并使用 `.jpg` 名称；文档保留原始文件名，磁盘路径仍使用安全文件名。

### API

- `messages.updated_at` 表示消息记录或媒体补齐时间。
- `GET /api/workbench/groups/:groupId/events` 提供已认证的 SSE 通知，默认 350ms 检查选中会话变化，15 秒心跳。
- SSE 仅通知刷新，消息仍通过原有权限受控 API 读取；API 不访问 TG session。
- 媒体响应支持 UTF-8 文件名，安全图片 MIME 使用 inline，其他文件继续使用 attachment。

### 前端

- 选中会话后建立 EventSource，变化时只合并最新页，不丢失已加载历史。
- 保留 1.5 秒轮询作为 SSE 断线降级。
- 图片/贴纸使用鉴权媒体接口预览，支持点击原图、懒加载、长宽自适应。
- 展示用户名、原始消息 ID、引用、转发来源、编辑状态、查看/转发次数、MIME、大小、时长和媒体详情。

## 边界

- 数据只写入工作台自己的 raw/workbench/runtime 库和账号目录。
- runtime worker 仍是唯一 TG session 持有者。
- 未开启 `WORKBENCH_CHAT_SYNC_ENABLED` 或账号 worker 不在线时，UI 只展示已入库数据。

