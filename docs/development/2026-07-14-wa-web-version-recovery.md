# WA Web 版本缓存与会话同步恢复

日期：2026-07-14

## 背景

WA runtime worker 在重启后可以进入 `ready`，但 `Client.getChats()` 持续失败。旧实现固定使用全局目录中最新的 WA Web HTML 缓存，并且同步失败后没有推进下一次同步时间，导致 worker 按心跳间隔反复调用 `getChats()`。

该故障不等同于账号 session 失效。恢复时不得先删除 session 或要求账号重新扫码。

## 处理规则

1. WA Web HTML 缓存按服务账号隔离，默认放在该账号目录下的 `.wwebjs_cache/`。
2. 未显式固定版本时，缓存默认有效期为 72 小时。
3. worker 启动时：
   - 缓存仍在有效期内：继续使用该版本；
   - 缓存过期或不存在：不向 `whatsapp-web.js` 指定旧版本，由它获取当前 WA Web，并把新 HTML 写入账号缓存；
   - 旧 HTML 文件保留，用于人工回退和故障比对。
4. `WORKBENCH_WA_WEB_VERSION` 优先级最高，可临时固定到指定版本进行回退。
5. `WORKBENCH_WA_WEB_CACHE_FORCE_LATEST=1` 可在下一次 worker 启动时强制获取当前版本，不删除账号 session。
6. `getChats()` 或标签/文件夹同步主流程失败时，按指数退避安排下一次会话同步，避免每 10 秒重试；成功后恢复正常的低频同步周期。
7. runtime 事件和日志记录当前 WA Web 版本、失败次数和下次重试等待时间，便于区分页面版本不兼容、渠道临时异常和数据异常。

## 默认参数

```text
WORKBENCH_WA_WEB_CACHE_MAX_AGE_HOURS=72
WORKBENCH_CHANNEL_SYNC_RETRY_BASE_MS=30000
WORKBENCH_CHANNEL_SYNC_RETRY_MAX_MS=600000
```

退避序列默认从 30 秒开始，依次为 30 秒、60 秒、120 秒、240 秒、480 秒，之后封顶 10 分钟。正常同步周期仍由 `WORKBENCH_ACCOUNT_WORKER_CHAT_SYNC_MS` 控制。

## 灰度与回退

- 缓存目录按账号隔离，因此测试账号刷新不会覆盖其他 WA 账号的缓存。
- 首次部署只观察测试账号，不发送测试消息，不删除 session。
- 若新版本出现兼容问题，把 `WORKBENCH_WA_WEB_VERSION` 设置为账号缓存中已验证的旧版本并重启该账号 worker。
- 若 `getChats()` 失败但收发链路正常，只降级群列表/标签同步；不得自动退出登录或清理 session。

## 验收信号

- 启动日志显示账号独立的 WA Web 缓存目录。
- 缓存过期时日志显示刷新，而不是继续固定旧版本。
- ready 后日志记录实际 WA Web 版本。
- `getChats()` 失败后重试间隔逐步增加，不再随 10 秒心跳持续刷错。
- 成功日志出现 `WA 群列表已同步`，并且 worker 保持 ready、Pod 无重启。
