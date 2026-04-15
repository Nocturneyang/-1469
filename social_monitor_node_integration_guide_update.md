# Social Monitor - 后端 API 数据同步开发指南 (更新版)

> **致开发/AI 助手：**
> 当前 Social Monitor (Node.js) 已完成后端的监控收录工作。在此阶段，需要你（Node.js 端）编写一段同步机制，将 SQLite 中采集到的增量聊天数据，通过 HTTP POST 接口批量推送到外部的中心型服务器（PHP / Laravel）。
>
> **【本次改动重点】**: 对方服务器无法直接访问你本地的 `media_url`（如 localhost地址）。请在推送数据时，直接读取你本地物理目录下的图片文件，并将其转化为 **Base64 字符串**，连同文件后缀名一并推送到接口。

---

## 1. 对接 API 规范

*   **接口地址**: `POST https://nwp-service.tyhsys.com/api/v1/social-monitor/messages/sync`
*   **Header 要求**:
    *   `Content-Type: application/json`
    *   `Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImQyZWE2YjdiNzc4OWNhZjFiNzJjZmVjZGVlMDNjMWQyYWZmNWMwYzUwMDdlOTk1YjU0N2NmYzdkMTlkMTgxMThhNWQyZTJiZWFkNWIxOTIwIn0.eyJhdWQiOiIxIiwianRpIjoiZDJlYTZiN2I3Nzg5Y2FmMWI3MmNmZWNkZWUwM2MxZDJhZmY1YzBjNTAwN2U5OTViNTQ3Y2ZjN2QxOWQxODExOGE1ZDJlMmJlYWQ1YjE5MjAiLCJpYXQiOjE3NzYxNTQ1MjQsIm5iZiI6MTc3NjE1NDUyNCwiZXhwIjoxODA3NjkwNTI0LCJzdWIiOiIxIiwic2NvcGVzIjpbXX0.MWCHHUwXh1BHiNofA6YkyK2aBRI0_Ej5Q7-AS1qQ8kEa-0vSDjB6MKX7kvgOKqzISOrb0wISHXRp48BzmHwO__PKQmfpUgnSTDg9ONRb4C8CZCN4sSH8HG7Y-eRvDGiwJXgkQmfrh9ungBDnrQUf0Tng4ud2Mx9jgVpx74mAVEHdz9sz1CPhzHZmTgSHaAPtQHwqiFQoQjfzXOATc0JsOvAjrLTTrpu5EagIAJrXqIgLuN7TjdTbEqj-HBuEK84VyvYbDZdG00mnO1nXsVH5EzJgFenZjeXmC6N0czWa9ZJR7OC9_CGaGzJzyLMvITTflBYIgZrk7YfEzrS7Epn2zWcDxXrYt6IJS-vyQp_TD5mQYc4SpvWHLUKp0Po-VPYFRBj8zabpH80KOnI8Y8i4DNDnaafBuJoWVzTyMCG3AdtC5t5J-IWksz6a47EPJBmc_u6NPvDaHFwycbFP1JzjFkLKkziXTUGDw6sV9uVz5AXe2h-58MiWu8MECA-lt6MIfilCUeh85TqEphBS3yK9sh-VVDEqgLhTVu0hL6L-ILZses2dioDBLsd8Td6aOpHUsAo-xkHGIjpeK8t6O2p8pfhLtzBsEU2wDg9y22sqrDP654yCkRC-A3YAyc7rZui_mjH45MMJLmcfPlbsW3lXSK85CzREIrILk_G5EgpDTEk`
*   **网络规则**:
    *   **控制单批次体积**：由于引入了 Base64 传输，单批次请求体积会膨胀。强烈建议每次推送控制在 **50 条** 以内，防止网络包过大溢出报错。

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
      "media_base64": "R0lGODlhPQBEAPeoeqos... (图片的Base64原始编码)",
      "media_ext": "jpg", 
      "media_url": null, 
      "message_timestamp": 1713065600, 
      "raw_data": "{底层采集的原始JSON字符串，非必须}"
    }
  ]
}
```
*备注：当 `has_media` 为 1 时，必须读取你本地物理硬盘的图片将其转为 Base64 提供在 `media_base64` 节点中，提供准确的扩展名 `media_ext`；原有的 `media_url` 传 null 即可不去理会。*

---

## 2. SQLite 本地数据库改造建议 (保持不变)

为了知道“哪些数据推过了，哪些没推过”，建议你在操作 `db/database.js` 时执行以下升级步骤：

1. **增设投递标记**：在 `messages` 表新增列 `is_synced INTEGER DEFAULT 0` （0 代表未投递，1 代表已推送到中心服务器）。
2. **建索引**：对 `is_synced` 创建索引以加快批量拉取查询。

---

## 3. Node.js 参考实施逻辑 (包含 Base64 转换)

建议新建 `sync-agent.js` 并放入 PM2 内执行。核心的 Base64 文件读取与 Payload 组装逻辑如下：

```javascript
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./db/database'); // 引入你的 better-sqlite3 实例

const SYNC_URL = "https://nwp-service.tyhsys.com/api/v1/social-monitor/messages/sync";
const SYNC_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGci..."; // 填入完整的长 Token
const BATCH_SIZE = 50; // Base64 会撑大体积，每次限批 50 条比较稳妥

async function syncMessagesToCenter() {
    try {
        // 1. 查询未同步数据
        const stmtSelect = db.prepare(`SELECT * FROM messages WHERE is_synced = 0 LIMIT ?`);
        const rows = stmtSelect.all(BATCH_SIZE);
        
        if (rows.length === 0) return;

        // 2. 组装 Payload 及 Base64 媒体数据
        const messagesPayload = rows.map(row => {
            let mediaBase64 = null;
            let mediaExt = null;

            // 遇到含媒体的消息，尝试读本地盘
            if (row.has_media && row.media_path) {
                const absPath = path.join(__dirname, '..', row.media_path);
                if (fs.existsSync(absPath)) {
                    // 读取为 Base64
                    mediaBase64 = fs.readFileSync(absPath).toString('base64');
                    // 提取扩展名如 'jpg', 'png'
                    mediaExt = path.extname(absPath).replace('.', '');
                }
            }

            return {
                platform: row.platform,
                message_id: row.message_id,
                group_id: row.group_id,
                group_name: row.group_name || '',
                sender_id: row.sender_id,
                sender_name: row.sender_name || '',
                content: row.content || '',
                has_media: row.has_media ? 1 : 0,
                media_base64: mediaBase64,
                media_ext: mediaExt,
                media_url: null, // 置空废止
                message_timestamp: row.timestamp,
                raw_data: row.raw_data
            };
        });

        // 3. HTTP 批量投递
        const response = await axios.post(SYNC_URL, {
            batch_id: 'batch_' + Date.now(),
            messages: messagesPayload
        }, {
            headers: {
                'Authorization': `Bearer ${SYNC_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000 // 传输大请求包需要留足15秒超时设置
        });

        // 4. 反写回本地 SQLite
        if (response.data && response.data.code === 200) {
            const ids = rows.map(r => r.id);
            const updateStmt = db.prepare(`UPDATE messages SET is_synced = 1 WHERE id IN (${ids.join(',')})`);
            updateStmt.run();
            console.log(`[Sync Agent] 成功推送并完阵 ${rows.length} 条数据`);
        } else {
            console.error(`[Sync Agent] 对方服务器异常返回:`, response.data);
        }

    } catch (e) {
        console.error("[Sync Agent] 同步出错停摆，等待下次重试:", e.message);
    }
}

// 每隔 5 秒执行一次轮询（请加上 isSyncing 并发锁处理机制防止重叠跑）
setInterval(syncMessagesToCenter, 5000);
```
