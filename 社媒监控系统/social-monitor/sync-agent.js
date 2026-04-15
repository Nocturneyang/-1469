require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { db } = require('./db/database');

// Configuration
const SYNC_URL = process.env.SYNC_URL || "https://nwp-service.tyhsys.com/api/v1/social-monitor/messages/sync";
// Default token provided in the integration guide
const DEFAULT_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImQyZWE2YjdiNzc4OWNhZjFiNzJjZmVjZGVlMDNjMWQyYWZmNWMwYzUwMDdlOTk1YjU0N2NmYzdkMTlkMTgxMThhNWQyZTJiZWFkNWIxOTIwIn0.eyJhdWQiOiIxIiwianRpIjoiZDJlYTZiN2I3Nzg5Y2FmMWI3MmNmZWNkZWUwM2MxZDJhZmY1YzBjNTAwN2U5OTViNTQ3Y2ZjN2QxOWQxODExOGE1ZDJlMmJlYWQ1YjE5MjAiLCJpYXQiOjE3NzYxNTQ1MjQsIm5iZiI6MTc3NjE1NDUyNCwiZXhwIjoxODA3NjkwNTI0LCJzdWIiOiIxIiwic2NvcGVzIjpbXX0.MWCHHUwXh1BHiNofA6YkyK2aBRI0_Ej5Q7-AS1qQ8kEa-0vSDjB6MKX7kvgOKqzISOrb0wISHXRp48BzmHwO__PKQmfpUgnSTDg9ONRb4C8CZCN4sSH8HG7Y-eRvDGiwJXgkQmfrh9ungBDnrQUf0Tng4ud2Mx9jgVpx74mAVEHdz9sz1CPhzHZmTgSHaAPtQHwqiFQoQjfzXOATc0JsOvAjrLTTrpu5EagIAJrXqIgLuN7TjdTbEqj-HBuEK84VyvYbDZdG00mnO1nXsVH5EzJgFenZjeXmC6N0czWa9ZJR7OC9_CGaGzJzyLMvITTflBYIgZrk7YfEzrS7Epn2zWcDxXrYt6IJS-vyQp_TD5mQYc4SpvWHLUKp0Po-VPYFRBj8zabpH80KOnI8Y8i4DNDnaafBuJoWVzTyMCG3AdtC5t5J-IWksz6a47EPJBmc_u6NPvDaHFwycbFP1JzjFkLKkziXTUGDw6sV9uVz5AXe2h-58MiWu8MECA-lt6MIfilCUeh85TqEphBS3yK9sh-VVDEqgLhTVu0hL6L-ILZses2dioDBLsd8Td6aOpHUsAo-xkHGIjpeK8t6O2p8pfhLtzBsEU2wDg9y22sqrDP654yCkRC-A3YAyc7rZui_mjH45MMJLmcfPlbsW3lXSK85CzREIrILk_G5EgpDTEk";
const SYNC_TOKEN = process.env.SYNC_TOKEN || DEFAULT_TOKEN;
// Base64 传输会显著膨胀请求体积，限制每批 50 条防止网络包过大
const BATCH_SIZE = 50;

let isSyncing = false;

async function syncMessagesToCenter() {
    if (isSyncing) return;
    isSyncing = true;

    try {
        // 1. 获取一批未同步的数据
        const rows = db.prepare(`SELECT * FROM messages WHERE is_synced = 0 LIMIT ?`).all(BATCH_SIZE);

        if (rows.length === 0) {
            isSyncing = false;
            return;
        }

        console.log(`[Sync Agent] ${new Date().toISOString()} - Found ${rows.length} unsynced messages. Starting sync...`);

        // 2. 构造 Payload（含 Base64 媒体文件读取）
        const messagesPayload = rows.map(row => {
            let mediaBase64 = null;
            let mediaExt = null;

            // 遇到含媒体的消息，读取本地物理文件并转 Base64
            // media_path 存储的是相对于 social-monitor 目录的路径（如 media/xxxx.jpg）
            if (row.has_media && row.media_path) {
                const absPath = path.join(__dirname, row.media_path);
                if (fs.existsSync(absPath)) {
                    try {
                        mediaBase64 = fs.readFileSync(absPath).toString('base64');
                        mediaExt = path.extname(absPath).replace('.', '').toLowerCase();
                    } catch (readErr) {
                        console.warn(`[Sync Agent] 读取媒体文件失败 (${absPath}): ${readErr.message}`);
                    }
                } else {
                    console.warn(`[Sync Agent] 媒体文件不存在，跳过: ${absPath}`);
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
                media_base64: mediaBase64,   // 图片 Base64 字符串，无媒体时为 null
                media_ext: mediaExt,         // 扩展名如 'jpg'、'png'，无媒体时为 null
                media_url: null,             // 已废止，对方服务器无法访问 localhost 地址
                message_timestamp: Math.floor(row.timestamp / 1000), // API 要求秒级时间戳
                raw_data: row.raw_data
            };
        });

        // 3. 发送 HTTP 请求（Base64 传输需留足超时时间）
        const response = await axios.post(SYNC_URL, {
            batch_id: `batch_${Date.now()}`,
            messages: messagesPayload
        }, {
            headers: {
                'Authorization': `Bearer ${SYNC_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000 // 15秒超时，适配含 Base64 的大请求包
        });

        // 4. 处理响应，反写 is_synced 标记
        if (response.status === 200 || (response.data && response.data.code === 200)) {
            const ids = rows.map(r => r.id);
            const updateStmt = db.prepare(`UPDATE messages SET is_synced = 1 WHERE id = ?`);
            const transaction = db.transaction((messageIds) => {
                for (const id of messageIds) {
                    updateStmt.run(id);
                }
            });
            transaction(ids);
            console.log(`[Sync Agent] Successfully synced ${rows.length} messages.`);
        } else {
            console.error(`[Sync Agent] Center server returned non-200 status:`, response.status, response.data);
        }

    } catch (error) {
        // 静默处理网络错误，仅打印日志，等待下次重试
        if (error.response) {
            console.error(`[Sync Agent] Server responded with error: ${error.response.status}`, error.response.data);
        } else if (error.request) {
            console.error(`[Sync Agent] No response received (Timeout/Network issue): ${error.message}`);
        } else {
            console.error(`[Sync Agent] Error setting up request: ${error.message}`);
        }
    } finally {
        isSyncing = false;
    }
}

// 每 10 秒尝试同步一次
setInterval(syncMessagesToCenter, 10000);

console.log(`[Sync Agent] Service started (Base64 media mode).`);
console.log(`[Sync Agent] Target URL: ${SYNC_URL}`);
console.log(`[Sync Agent] Batch size: ${BATCH_SIZE}`);

// 初次启动立即跑一次
syncMessagesToCenter();

