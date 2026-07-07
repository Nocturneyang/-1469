const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const outputPath = process.argv[2] || '/private/tmp/workbench-demo-raw.sqlite';
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.rmSync(outputPath, { force: true });

const db = new Database(outputPath);
db.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    receiver_account TEXT,
    message_id TEXT NOT NULL,
    group_id TEXT,
    group_name TEXT,
    sender_id TEXT,
    sender_name TEXT,
    content TEXT,
    has_media BOOLEAN DEFAULT 0,
    media_path TEXT,
    timestamp INTEGER,
    raw_data TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, message_id)
  );
`);

const baseSeconds = Math.floor(Date.now() / 1000) - 3600;
const rows = [
  ['whatsapp', 'nanya_wa', 'wa-1', 'vip-support', 'VIP 支持交流群', 'customer-a', '客户', '我的订单还没发货，能帮我看一下是什么情况吗？', 0],
  ['whatsapp', 'nanya_wa', 'wa-2', 'vip-support', 'VIP 支持交流群', 'agent-demo', 'nanya_wa', '您好，我马上为您查询订单，请稍等。', 1],
  ['whatsapp', 'nanya_wa', 'wa-3', 'vip-support', 'VIP 支持交流群', 'customer-a', '客户', '好的，谢谢！', 6],
  ['telegram', 'jason_tg', 'tg-1', 'sea-seller', '跨境电商卖家交流群（东南亚）', 'dewi', 'Dewi', 'Thanks, I will try it and update here.', 12],
  ['telegram', 'jason_tg', 'tg-2', 'promo', '优惠活动通知群', 'rose', 'Rose', '什么时候开始？', 18],
  ['teams', 'lily_teams', 'teams-1', 'product-feedback', '产品使用反馈群', 'mike', 'Mike', '我遇到同样的问题，需要同步给技术同事。', 24],
  ['whatsapp', 'nanya_wa', 'wa-4', 'logistics-eu', '售后服务群 - 欧洲区', 'anna', 'Anna', 'OK, got it.', 30],
  ['whatsapp', 'nanya_wa', 'wa-5', 'packing-issue', '物流问题沟通群', 'customer-b', '客户', '包装一直显示在清关，怎么办？', 36],
];

const insert = db.prepare(`
  INSERT INTO messages (
    platform, receiver_account, message_id, group_id, group_name,
    sender_id, sender_name, content, has_media, timestamp, raw_data
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

rows.forEach((row, index) => {
  const [platform, account, messageId, groupId, groupName, senderId, senderName, content, minuteOffset] = row;
  insert.run(
    platform,
    account,
    messageId,
    groupId,
    groupName,
    senderId,
    senderName,
    content,
    0,
    baseSeconds + minuteOffset * 60,
    JSON.stringify({ fromMe: senderId.includes('agent') || senderId.includes('nanya_wa') }),
  );
});

db.close();
console.log(`[workbench] demo raw messages DB written to ${outputPath}`);
