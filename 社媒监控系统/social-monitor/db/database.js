const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.sqlite');
const mediaDir = path.join(__dirname, '..', 'media');

// Ensure media directory exists
if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better concurrency performance
db.pragma('journal_mode = WAL');

// Initialize schema
function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL, -- 'whatsapp', 'telegram'
            receiver_account TEXT, -- 负责采集该条消息的系统内账号ID
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
            is_synced INTEGER DEFAULT 0, -- 0: 未同步, 1: 已同步
            created_at DATETIME DEFAULT (datetime('now', 'localtime')),
            UNIQUE(platform, message_id)
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            status TEXT NOT NULL,
            pushname TEXT,
            qr_code TEXT,
            updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
        );
    `);

    // Migration: Add is_synced column if it doesn't exist (for existing databases)
    try {
        const tableInfo = db.prepare("PRAGMA table_info(messages)").all();
        const columnExists = tableInfo.some(col => col.name === 'is_synced');
        if (!columnExists) {
            db.exec("ALTER TABLE messages ADD COLUMN is_synced INTEGER DEFAULT 0");
            console.log('Migrated database: added is_synced column and index');
        }
        db.exec("CREATE INDEX IF NOT EXISTS idx_messages_is_synced ON messages(is_synced)");
    } catch (err) {
        console.error('Migration error:', err.message);
    }
}

initSchema();

// Insert message with duplicate handling
function saveMessage(data) {
    try {
        const stmt = db.prepare(`
            INSERT INTO messages (
                platform, receiver_account, message_id, group_id, group_name, sender_id, sender_name,
                content, has_media, media_path, timestamp, raw_data, created_at
            ) VALUES (
                @platform, @receiver_account, @message_id, @group_id, @group_name, @sender_id, @sender_name,
                @content, @has_media, @media_path, @timestamp, @raw_data, datetime('now', 'localtime')
            )
            ON CONFLICT(platform, message_id) DO NOTHING
        `);
        return stmt.run({ receiver_account: 'default', ...data });
    } catch (err) {
        console.error('Error saving message:', err.message);
        return null;
    }
}

function updateAccountStatus(id, platform, status, pushname = null, qrCode = null) {
    try {
        const stmt = db.prepare(`
            INSERT INTO accounts (id, platform, status, pushname, qr_code, updated_at) 
            VALUES (@id, @platform, @status, @pushname, @qr_code, datetime('now', 'localtime'))
            ON CONFLICT(id) DO UPDATE SET 
              status=excluded.status, 
              pushname=COALESCE(excluded.pushname, pushname), 
              qr_code=excluded.qr_code, 
              updated_at=datetime('now', 'localtime')
        `);
        stmt.run({ id, platform, status, pushname, qr_code: qrCode });
    } catch (err) {
        console.error('Error saving account status:', err.message);
    }
}

module.exports = {
    db,
    saveMessage,
    updateAccountStatus
};
