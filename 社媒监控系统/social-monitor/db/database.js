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
            created_at DATETIME DEFAULT (datetime('now', 'localtime')),
            UNIQUE(platform, message_id)
        );
    `);
}

initSchema();

// Insert message with duplicate handling
function saveMessage(data) {
    try {
        const stmt = db.prepare(`
            INSERT INTO messages (
                platform, message_id, group_id, group_name, sender_id, sender_name,
                content, has_media, media_path, timestamp, raw_data, created_at
            ) VALUES (
                @platform, @message_id, @group_id, @group_name, @sender_id, @sender_name,
                @content, @has_media, @media_path, @timestamp, @raw_data, datetime('now', 'localtime')
            )
            ON CONFLICT(platform, message_id) DO NOTHING
        `);
        return stmt.run(data);
    } catch (err) {
        console.error('Error saving message:', err.message);
        return null;
    }
}

module.exports = {
    db,
    saveMessage
};
