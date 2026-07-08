# 会话工作流 14 项优化交付说明

日期：2026-07-08

本次补齐三类优先级共 14 个对话台能力，仍保持工作台独立边界：数据写入账号自己的 `workbench.sqlite`，外发仍由账号 runtime worker 串行执行，不引入 Redis、队列系统或新数据库。

## 数据模型

- `conversation_profiles`：会话状态、星标、重要度、跟进提醒、内部展示名、客户类型、负责人备注。
- `conversation_notes`：内部备注。
- `conversation_presence`：坐席正在查看/输入状态，用于协作防撞。
- `conversation_timeline`：回复、已读、认领/释放、标签、备注、资料和批量动作的操作时间线。

这些表按 `platform + account + group_id` 隔离，兼容账号独立库模式。

## API

- `GET/PATCH /api/workbench/groups/:groupId/workspace`
- `POST /api/workbench/groups/:groupId/notes`
- `POST /api/workbench/groups/:groupId/presence`
- `GET /api/workbench/groups/:groupId/timeline`
- `POST /api/workbench/groups/bulk`

批量操作只支持标已读、认领/释放、改状态、星标和打标签，不支持批量外发。

## UI

- 左侧会话列表增加批量选择栏、状态、星标、重要度、跟进提醒和协作占用提示。
- 中间消息线程增加当前群消息搜索：关键词、发送人、时间范围、附件过滤。
- 消息气泡增加引用按钮和可读化失败原因。
- 回复框增加引用预览、Esc 取消引用和输入中 presence。
- 右侧群信息页增加会话工作流、群备注字段、内部备注、协作防撞、操作时间线。
- 快捷键：非输入区域 `j/k` 切会话，`m` 标已读，`a` 认领/释放，`Esc` 取消引用。

## 外发附件

账号 runtime worker 现在会读取 `outbound_messages.attachment_json`：

- WA 使用 `whatsapp-web.js` 的 `MessageMedia` 真实发送附件。
- TG Bot 使用 `sendPhoto/sendDocument/sendSticker`。
- TG 用户号使用 GramJS `sendFile`。
- 多附件按账号串行发送，首个附件携带正文 caption。

发送事实源仍是 `outbound_messages`，outbox 文件仍只是门铃。

## 验证

- `node --check server/routes/workbench.js`
- `node --check workers/account-runtime-worker.js`
- `npm run build`
- `npm test`

