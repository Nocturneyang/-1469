# WA 账号与媒体处理操作规范

> 适用范围：工作台中所有 WhatsApp（WA）账号、`whatsapp-web.js`、Chromium、session、消息同步、媒体下载、标签同步、外发状态及相关部署变更。
>
> 强制要求：开始任何 WA 变更前，必须完整阅读本规范、`AGENTS.md` 与 `DEVELOPMENT_GUIDE.md`。如果变更不能说明其对本规范中“账号生命周期、消息身份、媒体落盘、可观测性、验证与回滚”的影响，则不得合并或发布。

## 1. 第一性原则

WA 工作台的目标不是“调用一次 `whatsapp-web.js` 方法”，而是让坐席可在受控、可审计的前提下稳定地看到、下载、回复渠道消息。

因此以下事实必须同时成立：

```text
渠道账号真正在线
→ worker 保持运行并进入 ready
→ 原始消息拥有可重建的渠道身份
→ 媒体字节成功下载并落盘
→ 受鉴权 API 可读取该文件
→ UI 才能预览图片或下载文件
```

任何一环失败，前端“有入口”都不代表功能可用。排障与验收必须沿此链路逐层取证，不能只改最后一层页面。

`whatsapp-web.js` 是非官方 WhatsApp Web 驱动，WhatsApp Web 内部对象、下载器、消息 ID 和 Chromium 兼容性可能变化。业务代码不得把它当成稳定事实源；所有不稳定性必须收敛在工作台 WA runtime/adapter 中。

## 2. 账号生命周期与唯一执行者

```text
服务账号登录任务
→ account.json + 独立 raw/runtime/workbench DB + session 目录
→ account-worker-supervisor 发现账号
→ account-runtime-worker 启动（starting）
→ Chromium / WhatsApp Web 初始化
→ authenticated / ready
→ 消息、媒体、标签同步与串行外发
```

规则：

- 每个 `platform + account` 只能由一个工作台 runtime worker 持有 session 和执行 WA 操作。
- API、前端、测试脚本不得直接持有或调用 WA session；只可通过工作台 DB、outbox 和 worker 协作。
- `starting` 是合法可运行状态。supervisor 在账号进入 `ready` 前不得因状态尚未就绪而终止 worker。
- 只有明确禁用采集、登出、账号不可见、会话失效或达到故障熔断条件时，才停止或隔离 worker。
- worker 的 `ready` 不是进程启动成功，而是 WA Web 已完成初始化、可安全读取消息和执行同步。

每次修改 supervisor、账号状态或 session 初始化时，必须验证：启动超过一个 discovery 周期后，worker 仍在运行，并最终到达 `ready` 或产生明确的二维码/认证故障状态。

## 3. 消息身份：原始值与可重建值同时保存

WA 历史消息、事件消息和 `getMessageById()` 返回的模型不保证始终带有相同字段。不得只依赖 `message.id._serialized`。

入库时必须保留：

- 工作台 canonical `message_id`；
- `native_chat_id`；
- `native_message_id`（优先 WA 原始序列化 ID）；
- 原始 `raw_data.id` 中的 `fromMe`、`remote`、`id`、`participant` 等可重建片段；
- 账号和平台。

需要重新定位 WA Web 消息时，按以下顺序使用：

1. 有效的原始序列化 ID；
2. 已保存的 `native_message_id`；
3. 用 `fromMe + remote + id [+ participant]` 重建标准 WA 消息 ID；
4. 仍无法定位时记录结构化 `message_id_unavailable`，保留媒体占位，不伪造成功。

不得以 UI 展示的短消息 ID、数据库自增 ID 或群 ID 拼接值替代 WA 原始消息 ID。

## 4. 入站消息与媒体落盘链路

### 4.1 两阶段写入

收到 WA 消息后先写入消息摘要，再下载媒体：

```text
message / message_create
→ 解析内容、方向、媒体类型、MIME、文件名、大小、原始身份
→ upsert raw.sqlite.messages（media_path 为空的可见占位）
→ 下载并解密媒体
→ 写入该账号 media/YYYY-MM/ 目录
→ 同一消息幂等更新 media_path、MIME、大小、哈希
→ 发送会话更新事件
```

所有媒体类型使用同一链路：图片、贴纸、PDF、Office 文件、压缩包、视频、音频和语音。图片与文件的 UI 差异只发生在落盘之后：图片以内联方式展示，非图片以附件方式下载。

### 4.2 下载兼容层

当前优先使用 `Message.downloadMedia()`；失败后必须：

- 刷新消息模型并有限次数重试；
- 通过保存/重建的序列化消息 ID 定位 WA Web 原始消息；
- 使用同一 WA 官方 Web 下载/解密管理器的兼容适配路径；
- 为 QPL 等内部可选遥测接口提供前向兼容的无操作适配器；
- 记录 library 与兼容路径各自的错误、媒体阶段和消息定位信息。

禁止直接修改 `node_modules/whatsapp-web.js`。兼容逻辑必须放在工作台代码中，便于测试、升级、灰度和回滚。

### 4.3 补偿与不可恢复媒体

worker 在 ready 后和周期任务中扫描近期 `has_media = 1 AND media_path IS NULL` 的记录，并按原生 ID 补偿下载。补偿成功后必须触发会话刷新。

若 WA 返回媒体已过期、已撤回、重新上传中或源文件不可用：

- 保留消息与附件元信息；
- 记录明确的可检索错误分类；
- 不写假路径、不伪造文件、不把空数据标为下载成功；
- UI 可以显示文件卡片/不可用状态，但不得提供无效下载链接。

## 5. 受鉴权访问与 UI 规则

媒体文件只能保存在该账号隔离目录中，SQLite 仅保存相对路径。读取必须经过：

```text
坐席权限
→ platform + account 可见范围
→ conversation 可见权限
→ 路径在该账号目录内
→ 媒体文件存在且大小合规
```

图片使用安全的 inline MIME；PDF、Office 文件和其他非图片附件必须返回 `Content-Disposition: attachment` 与原始文件名。前端只有在 `media_url` 存在时才展示预览或下载入口。

## 6. WA 事件同步、原生动作与展示边界

WA 的账号状态与会话事实必须由 runtime worker 订阅、写入账号隔离数据库，再由 API/UI 只读展示。当前工作台同步以下能力：

- 账号二维码、认证、`ready`、连接状态、认证失败和断连；保留 ready 时刻、运行时长和最近错误。
- 消息编辑、对所有人/仅自己撤回；撤回消息不再暴露原正文或历史附件下载入口。
- 表情回应；按 emoji 聚合展示，不向坐席暴露回应者的原始标识。
- 联系人 LID、手机号 WID、原始会话 ID 与展示名的账号内别名映射；不得跨账号合并联系人。
- 原生标签、渠道未读数、置顶和归档状态；标签仍只读，不在工作台内修改 WA 原生标签。
- 群名、群成员加入/离开、群元数据等会话变更；事件到达后重新同步会话快照。

### 6.3 群成员快照与原生提及

群成员、群简介和管理员身份是随账号、随会话变化的原生数据。worker 将其写入该账号 `workbench.sqlite.channel_groups.raw_json`，API/UI 只读取该快照；不得让浏览器或 API 为了补齐成员信息直接操作 WA session。

发送提及必须经过完整链路：

```text
worker 同步 participants[{ id, name, is_admin }]
→ UI 只从当前会话快照选择成员并生成显示文本
→ API 校验每个 ID 仍属于 platform + account + group_id
→ outbound_messages.mentions_json 记账
→ 唯一账号 worker getContactById + sendMessage({ mentions })
```

规则：

- `@显示名`、手机号、数据库行 ID 和 UI 短 ID 都不是原生提及身份，不能据此推断或伪造 WA `mentions`。
- 快照缺失、超时或成员不在当前群时，创建外发任务必须返回明确冲突错误；不能静默发成普通消息。
- worker 发送时再次解析联系人；解析失败按不可重试的 `MENTION_ID_INVALID` 结束任务，并保留账本和错误证据。
- 群成员快照只用于会话展示和受控提及，不得跨账号复用，也不得把它变成工作台自行维护的通讯录事实源。

### 6.4 实时消息去重与历史校准

WA 事件流用于低延迟，不是历史完整性的唯一保证。worker 必须把同一原生消息 ID 的 `message_create` 与 `message` 收敛为一次处理，且在调用 `getChat`、联系人解析或媒体下载之前完成去重；不能只依靠 SQLite 唯一键在末端吞掉重复写入。

历史消息采用后台、受限、可续跑的校准：worker 在 ready、重连后的会话快照同步后，按会话状态分批调用 WA `chat.fetchMessages({ limit })`，以原生消息 ID 幂等写入 `raw.sqlite`。进度写入账号 `runtime.sqlite.wa_history_sync_state`，每个会话逐步扩大读取范围，直至源端可用历史不足或达到明确的安全上限。

规则：

- 坐席浏览器和 `/groups/:groupId/messages` API 只读本地 `raw.sqlite`；滚动历史不得直接拉 WA。
- 回补批次不可下载历史媒体，以免一次历史校准耗尽网络或磁盘；媒体仍走专门的可观测补偿链路。
- 每批成功后只发送一次会话刷新事件；不得为每条历史消息造成 SSE 风暴。
- `WORKBENCH_WA_HISTORY_SYNC_CHAT_LIMIT`、`..._BATCH_SIZE`、`..._MAX_MESSAGES` 是容量边界，任何调大必须先做单账号灰度并观察 Chromium 内存、WA 限流和 SQLite 写入耗时。

### 6.1 工作台状态与 WA 原生状态必须分开

- `conversation_reads` 表示“该坐席已在工作台看过”，不会向客户发送已读回执。
- `send_seen` 表示“请求 WA 对该会话发送已读”。它必须由坐席显式点击、账号 worker 实际执行并回写结果。
- 工作台查看/输入协作状态属于 `conversation_presence`；WA 输入中属于临时原生动作，二者不可混用。

### 6.2 原生动作的唯一链路

除“发送新消息”外，所有会改变 WA 原生状态的动作都使用 `channel_action_tasks`：

```text
坐席 UI / API
→ workbench.sqlite.channel_action_tasks(status=pending, client_action_id 幂等)
→ action-worker-{platform}-{account} 门铃
→ 账号 runtime worker（唯一 session 持有者）
→ WA Web 动作
→ completed / failed + 结构化错误 + 会话事件
```

允许的已审计动作：显式 WA 已读、输入中/停止输入、消息回应、归档/取消归档、会话置顶/取消置顶、静音/取消静音、标记未读，以及仅限本账号已确认外发消息的编辑、撤回和消息置顶。

规则：

- 浏览器、API 请求线程和测试脚本不得直接调用 `sendSeen`、`sendReaction`、`archive`、`edit`、`delete` 或任何 WA client 方法。
- 每个任务必须包含 `platform + account + group_id`；需要目标消息时必须保存并验证 `native_message_id`。
- 原生引用、回应、编辑、撤回、置顶绝不能使用工作台自增 ID、UI 短 ID 或 `raw_id`。原生 ID 无法验证时返回明确错误，禁止降级为普通消息或对错误消息操作。
- 会话归档、置顶、静音和标记未读要求会话管理权限；对外可见的已读、输入中、回应、编辑和撤回要求回复权限。
- 任务成功仅表示 worker 已得到 WA 方法成功返回；UI 仍应通过后续事件/快照更新展示最终原生状态。群聊不能伪造逐成员已读。
- 输入中任务必须带短有效期，过期后不得补发；停输、切换会话、发送成功和页面卸载时必须清除。

不在本次范围：通话、投票、计划活动（scheduled events）。以后新增 WA 事件时，必须先明确其事件签名、原始 ID 关联方式、幂等入库方式、UI 最小展示和 Web 版本降级策略。

## 7. 变更实施清单（强制）

任何 WA 相关改动开始前：

- [ ] 阅读本规范、`AGENTS.md`、`DEVELOPMENT_GUIDE.md`。
- [ ] 明确变更位于 adapter/runtime、supervisor、数据层、API 或 UI 的哪一层。
- [ ] 列出上游依赖：`whatsapp-web.js` 版本、WA Web 版本、Chromium 版本、session 状态。
- [ ] 明确不会由 API/浏览器直接操作 WA session，不会跨账号读取文件或 DB。
- [ ] 若变更涉及原生动作，明确 `channel_action_tasks` 的幂等键、目标原生 ID、权限、过期/重试边界与最终状态。
- [ ] 为失败路径定义结构化错误、重试边界和最终降级状态。

代码完成后：

- [ ] `node --check` 覆盖变更的 CommonJS 文件。
- [ ] 运行相关单元/接口测试；媒体变更必须覆盖图片和至少一种非图片文件。
- [ ] 验证 worker 在超过 discovery 周期后仍持续运行。
- [ ] 验证 `starting → ready`、认证失败、断连、重启恢复。
- [ ] 验证消息 ID 缺失时的重建和不可重建时的安全降级。
- [ ] 验证同一入站消息同时触发 `message_create` 与 `message` 时，只发生一次聊天/联系人/媒体处理；验证 ready 或重连后的历史校准可跨 worker 重启续跑，且浏览器历史分页仍只读本地库。
- [ ] 验证原生引用、回应、编辑/撤回或会话动作在 worker 未 ready、原生 ID 缺失、任务重复和 worker 重启时不会产生伪成功或跨会话操作。
- [ ] 涉及提及时，验证群成员快照、API 会话范围校验、`mentions_json` 记账和 worker 联系人解析；缺失/过期/跨群成员必须拒绝而不是降级为普通消息。
- [ ] 验证媒体“收到 → raw 占位 → 落盘 → 鉴权下载 API → UI 预览/下载”全链路。
- [ ] 运行前端构建；生产发布前运行 `npm run predeploy:check -- --skip-install`。

## 8. 生产发布与灰度

- 依赖升级与业务功能变更分开提交、分开发布；`package-lock.json` 是唯一版本事实。
- 新 `whatsapp-web.js`、WA Web 缓存策略、Chromium 参数或下载兼容逻辑，先在单个低风险测试账号灰度。
- 灰度验收必须使用真实入站图片和 PDF/Office 文件；不允许使用生产账号发送测试外发。
- 观察 worker ready 耗时、媒体成功率、`media_path` 缺失积压量、重启次数和错误分类后再扩大范围。
- 保留上一版镜像与部署提交；出现媒体成功率显著下降、worker 无法 ready 或重复重启时立即回滚，不尝试在线修改 session 或生产 DB。

## 9. 必须观测与告警

至少按 `platform + account` 记录和告警：

- worker 当前状态、`starting → ready` 耗时、断连次数、重启次数；
- 编辑、撤回、回应、联系人映射和会话快照事件的接收/关联失败数；
- 原生动作按 `action_type + status` 的排队、完成、失败、重试、过期数和最长等待时间；
- 当前 WA Web、`whatsapp-web.js`、Chromium 版本；
- 入站媒体下载尝试数、成功数、失败数、按 MIME 分类成功率；
- `media_path IS NULL` 的近期积压量和最长等待时间；
- 消息 ID 重建次数与失败次数；
- `mediaStage`、HTTP 状态或兼容下载错误类型；
- API 读取媒体的 404、403、413 比例。

告警应指向链路阶段，例如“worker 未 ready”“媒体下载失败”“媒体文件缺失”“授权拒绝”，不能只报“图片未显示”。

## 10. 排障顺序

遇到图片不预览、文件不能下载或消息不同步时，严格按以下顺序检查：

1. 账号是否在独立工作台目录、是否由唯一 worker 持有 session；
2. worker 是否持续运行，是否已 ready，是否被 supervisor 停止；
3. WA Web、Chromium、`whatsapp-web.js` 版本及最近错误；
4. 原始消息是否存在，身份字段是否足以重建序列化 ID；
5. 媒体是否处于可下载阶段，下载/解密是否成功；
6. `media_path`、文件大小、哈希与账号目录内的实体文件是否存在；
7. 鉴权媒体 API 是否返回正确 MIME 与 Content-Disposition；
8. 最后才检查前端是否拿到 `media_url` 并正确渲染。

每一步必须保留可验证证据。禁止跳到 UI 层“补一个按钮”或只增加无限重试来掩盖上游故障。
