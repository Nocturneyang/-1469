# Social Monitor - 后端 API 数据同步开发指南

> **致开发/AI 助手：**
> 当前 Social Monitor (Node.js) 已完成后端的监控收录工作。在此阶段，需要你（Node.js 端）编写一段同步机制，将 SQLite 中采集到的增量聊天数据，通过 HTTP POST 接口批量推送到外部的中心型服务器（PHP / Laravel）。
> 请严格按照下方的要求和结构新增功能。

---

## 1. 对接 API 规范

*   **接口地址**: `POST https://nwp-service.tyhsys.com/api/v1/social-monitor/messages/sync`
*   **Header 要求**:
    *   `Content-Type: application/json`
    *   `Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImQyZWE2YjdiNzc4OWNhZjFiNzJjZmVjZGVlMDNjMWQyYWZmNWMwYzUwMDdlOTk1YjU0N2NmYzdkMTlkMTgxMThhNWQyZTJiZWFkNWIxOTIwIn0.eyJhdWQiOiIxIiwianRpIjoiZDJlYTZiN2I3Nzg5Y2FmMWI3MmNmZWNkZWUwM2MxZDJhZmY1YzBjNTAwN2U5OTViNTQ3Y2ZjN2QxOWQxODExOGE1ZDJlMmJlYWQ1YjE5MjAiLCJpYXQiOjE3NzYxNTQ1MjQsIm5iZiI6MTc3NjE1NDUyNCwiZXhwIjoxODA3NjkwNTI0LCJzdWIiOiIxIiwic2NvcGVzIjpbXX0.MWCHHUwXh1BHiNofA6YkyK2aBRI0_Ej5Q7-AS1qQ8kEa-0vSDjB6MKX7kvgOKqzISOrb0wISHXRp48BzmHwO__PKQmfpUgnSTDg9ONRb4C8CZCN4sSH8HG7Y-eRvDGiwJXgkQmfrh9ungBDnrQUf0Tng4ud2Mx9jgVpx74mAVEHdz9sz1CPhzHZmTgSHaAPtQHwqiFQoQjfzXOATc0JsOvAjrLTTrpu5EagIAJrXqIgLuN7TjdTbEqj-HBuEK84VyvYbDZdG00mnO1nXsVH5EzJgFenZjeXmC6N0czWa9ZJR7OC9_CGaGzJzyLMvITTflBYIgZrk7YfEzrS7Epn2zWcDxXrYt6IJS-vyQp_TD5mQYc4SpvWHLUKp0Po-VPYFRBj8zabpH80KOnI8Y8i4DNDnaafBuJoWVzTyMCG3AdtC5t5J-IWksz6a47EPJBmc_u6NPvDaHFwycbFP1JzjFkLKkziXTUGDw6sV9uVz5AXe2h-58MiWu8MECA-lt6MIfilCUeh85TqEphBS3yK9sh-VVDEqgLhTVu0hL6L-ILZses2dioDBLsd8Td6aOpHUsAo-xkHGIjpeK8t6O2p8pfhLtzBsEU2wDg9y22sqrDP654yCkRC-A3YAyc7rZui_mjH45MMJLmcfPlbsW3lXSK85CzREIrILk_G5EgpDTEk`
*   **网络规则**:
    *   **禁止单条高频推送**：每发送一批数据（上限推荐 100-200 条），才能进行下一次请求。若无新数据则不请求。
    *   **本地重试机制**：由于对方服务器可能短暂掉线，推送失败的数据必须具有重入机制，等待下次循环再推。

### 推送的数据对象格式 (JSON Body)

```json
{
  "batch_id": "当前时间戳或随机uuid",
  "messages": [
    {
      "platform": "whatsapp",
      "message_id": "该消息在当前平台的原生ID",
      "group_id": "获取到的群组唯一标识",
      "group_name": "群名",
      "sender_id": "发言人识别号",
      "sender_name": "发言人昵称",
      "content": "具体的聊天文本（哪怕只有表情或为空，传空字符串）",
      "has_media": 1, 
      "media_url": "http://192.168.1.xxx:3000/media/abc.jpg", 
      "message_timestamp": 1713065600, 
      "raw_data": "{底层采集的原始JSON字符串，非必须}"
    }
  ]
}
```
*备注：`has_media` 为 1 时，必须提供一个公网/局域网能访问到的 `media_url`，供中心服务器做后置拉取。*

---

## 2. SQLite 本地数据库改造建议

为了知道“哪些数据推过了，哪些没推过”，建议你在操作 `db/database.js` 时执行以下升级步骤：

1. **增设投递标记**：在 `messages` 表新增列 `is_synced INTEGER DEFAULT 0` （0 代表未投递，1 代表已推送到中心服务器）。
2. **建索引**：对 `is_synced` 创建索引以加快批量拉取查询。

---

## 3. Node.js 参考实施逻辑 (供 AI 参考直接生成)

建议在系统中新建一个专门做数据分发的脱藕脚本，例如可命名为 `sync-agent.js` 并放入 PM2 内执行。核心伪代码 / Node 逻辑如下：

```javascript
const axios = require('axios');
const db = require('./db/database'); // 引入你的 better-sqlite3 实例

const SYNC_URL = "http://{中心服务器IP}/api/v1/social-monitor/messages/sync";
const SYNC_TOKEN = "your_secret_token";
const BATCH_SIZE = 100; // 每次抓取 100 条

async function syncMessagesToCenter() {
    try {
        // 1. 查询出未同步的批量数据
        const stmtSelect = db.prepare(`SELECT * FROM messages WHERE is_synced = 0 LIMIT ?`);
        const rows = stmtSelect.all(BATCH_SIZE);
        
        if (rows.length === 0) return; // 没数据，休息

        // 2. 格式化组装 Payload
        const messagesPayload = rows.map(row => ({
            platform: row.platform,
            message_id: row.message_id,
            group_id: row.group_id,
            group_name: row.group_name || '',
            sender_id: row.sender_id,
            sender_name: row.sender_name || '',
            content: row.content || '',
            has_media: row.has_media ? 1 : 0,
            media_url: row.has_media ? `http://当前本服务器IP:3000/${row.media_path}` : null,
            message_timestamp: row.timestamp,
            raw_data: row.raw_data
        }));

        // 3. HTTP 批量投递
        const response = await axios.post(SYNC_URL, {
            batch_id: 'batch_' + Date.now(),
            messages: messagesPayload
        }, {
            headers: {
                'Authorization': `Bearer ${SYNC_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000 // 10秒超时控制
        });

        // 4. 判断成功，反写回本地 SQLite
        if (response.data && response.data.code === 200) {
            // 拿到所有推过去的自增id列表
            const ids = rows.map(r => r.id);
            // 批量更新 is_synced = 1
            const updateStmt = db.prepare(`UPDATE messages SET is_synced = 1 WHERE id IN (${ids.join(',')})`);
            updateStmt.run();
            console.log(`[Sync Agent] 成功推送并完阵 ${rows.length} 条数据`);
        } else {
            console.error(`[Sync Agent] 对方服务器未返回200,`, response.data);
        }

    } catch (e) {
        // 捕获网络错误，不做更新操作，下次轮询自身具备幂等重试性
        console.error("[Sync Agent] 同步出错，等待下一次重试:", e.message);
    }
}

// 每隔 5 秒执行一次轮询（平滑错峰）
setInterval(syncMessagesToCenter, 5000);
```

### 对接开发要求小结
1. 使用 Axios 作为请求库。
2. 保持独立轮询，发生 `Timeout`、`Connection Refused` 时安静吞除 Error（只打印 log），让其在下一次 `Interval` 重新选取 `is_synced = 0` 的数据再次重推。
3. 对接工作务必把控并发锁（避免当前 Interval 未推完，下一个 Interval 又进来了）。可以使用一个简单的 `isSyncing` 布尔锁解决重叠执行问题。
