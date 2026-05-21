const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const dbPath = path.join(DATA_DIR, 'db', 'database.sqlite');
const mediaDir = path.join(DATA_DIR, 'media');
const REGION_CONFIG_PATH = path.join(DATA_DIR, 'config', 'account-regions.json');

// Ensure media directory exists
if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better concurrency performance
db.pragma('journal_mode = WAL');

// ... [schema setup] ...

// Helper function to read business_sector from JSON
let _cachedRegions = null;
let _lastCacheTime = 0;
function getBusinessSector(receiverAccount) {
    try {
        const now = Date.now();
        if (!_cachedRegions || now - _lastCacheTime > 60000) {
            const config = JSON.parse(fs.readFileSync(REGION_CONFIG_PATH, 'utf8'));
            _cachedRegions = Object.fromEntries(config.accounts.map(a => [a.account, a]));
            _lastCacheTime = now;
        }
        
        const info = _cachedRegions[receiverAccount];
                     
        return info ? (info.business_sector || null) : null;
    } catch (e) {
        return null;
    }
}

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
            created_at DATETIME DEFAULT (datetime('now')),
            UNIQUE(platform, message_id)
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            status TEXT NOT NULL,
            pushname TEXT,
            qr_code TEXT,
            updated_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'viewer',
            created_at DATETIME DEFAULT (datetime('now')),
            last_login DATETIME
        );
    `);

    // Migration: Add last_login to users if missing
    try {
        const tableInfo = db.prepare("PRAGMA table_info(users)").all();
        const colExists = tableInfo.some(col => col.name === 'last_login');
        if (!colExists) {
            db.exec("ALTER TABLE users ADD COLUMN last_login DATETIME");
        }
    } catch (e) {
        console.error('Migration error for users table:', e.message);
    }

    // Setup initial admin and view users if users table is empty
    try {
        const count = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
        if (count === 0) {
            const bcrypt = require('bcryptjs');
            // 'admin123' as default password for admin
            const salt = bcrypt.genSaltSync(10);
            const adminHash = bcrypt.hashSync('admin123', salt);
            db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('admin', adminHash, 'admin');
            
            // 'view' as default password for view user
            const viewHash = bcrypt.hashSync('view', salt);
            db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('view', viewHash, 'view');
            
            console.log('Migrated database: created default admin user (admin / admin123) and view user (view / view)');
        } else {
            // Check if view user exists, if not create it
            const viewUser = db.prepare("SELECT id FROM users WHERE username = ?").get('view');
            if (!viewUser) {
                const bcrypt = require('bcryptjs');
                const salt = bcrypt.genSaltSync(10);
                const viewHash = bcrypt.hashSync('view', salt);
                db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run('view', viewHash, 'view');
                console.log('Migrated database: created default view user (view / view)');
            }
        }
    } catch (err) {
        console.error('Error auto-provisioning users:', err.message);
    }

    // Migration: Add is_synced column if it doesn't exist (for existing databases)
    try {
        const tableInfo = db.prepare("PRAGMA table_info(messages)").all();
        
        const columnExists = tableInfo.some(col => col.name === 'is_synced');
        if (!columnExists) {
            db.exec("ALTER TABLE messages ADD COLUMN is_synced INTEGER DEFAULT 0");
            console.log('Migrated database: added is_synced column and index');
        }

        const businessSectorExists = tableInfo.some(col => col.name === 'business_sector');
        if (!businessSectorExists) {
            db.exec("ALTER TABLE messages ADD COLUMN business_sector TEXT");
            console.log('Migrated database: added business_sector column');
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
                platform, receiver_account, business_sector, message_id, group_id, group_name, sender_id, sender_name,
                content, has_media, media_path, timestamp, raw_data, created_at
            ) VALUES (
                @platform, @receiver_account, @business_sector, @message_id, @group_id, @group_name, @sender_id, @sender_name,
                @content, @has_media, @media_path, @timestamp, @raw_data, datetime('now')
            )
            ON CONFLICT(platform, message_id) DO NOTHING
        `);

        // dynamically look up business_sector if not provided directly
        const bs = data.business_sector !== undefined ? data.business_sector : getBusinessSector(data.receiver_account);

        return stmt.run({ receiver_account: 'default', business_sector: bs, ...data });
    } catch (err) {
        console.error('Error saving message:', err.message);
        return null;
    }
}

function updateAccountStatus(id, platform, status, pushname = null, qrCode = null) {
    try {
        const stmt = db.prepare(`
            INSERT INTO accounts (id, platform, status, pushname, qr_code, updated_at)
            VALUES (@id, @platform, @status, @pushname, @qr_code, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              status=excluded.status,
              pushname=COALESCE(excluded.pushname, pushname),
              qr_code=excluded.qr_code,
              updated_at=datetime('now')
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
