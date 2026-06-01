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
            user_id TEXT,
            email TEXT,
            display_name TEXT,
            avatar_url TEXT,
            tenant_id TEXT,
            health_status TEXT,
            chrome_rss_mb INTEGER DEFAULT 0,
            chrome_process_count INTEGER DEFAULT 0,
            chrome_version TEXT,
            runtime_provider TEXT DEFAULT 'pm2',
            pm2_status TEXT,
            pm2_mode TEXT,
            pm2_pid INTEGER,
            pm2_restart_count INTEGER DEFAULT 0,
            pm2_uptime_seconds INTEGER DEFAULT 0,
            orchestrator_state TEXT,
            collector_phase TEXT,
            collector_run_id TEXT,
            collector_heartbeat_age_seconds INTEGER,
            last_runtime_event_at DATETIME,
            last_restart_reason TEXT,
            last_supervisor_check_at DATETIME,
            updated_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS collector_heartbeats (
            account_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            collector_id TEXT NOT NULL,
            run_id TEXT,
            process_pid INTEGER,
            status TEXT,
            phase TEXT,
            health_status TEXT,
            chrome_rss_mb INTEGER DEFAULT 0,
            chrome_process_count INTEGER DEFAULT 0,
            chrome_version TEXT,
            last_error TEXT,
            last_ready_at DATETIME,
            last_message_at DATETIME,
            started_at DATETIME,
            updated_at DATETIME DEFAULT (datetime('now')),
            PRIMARY KEY (account_id, collector_id)
        );

        CREATE TABLE IF NOT EXISTS wa_runtime_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            platform TEXT NOT NULL DEFAULT 'whatsapp',
            source TEXT NOT NULL DEFAULT 'worker',
            event_type TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'info',
            run_id TEXT,
            message TEXT,
            data_json TEXT,
            created_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sso_admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            identity TEXT NOT NULL UNIQUE,
            display_name TEXT,
            note TEXT,
            created_by TEXT,
            created_at DATETIME DEFAULT (datetime('now')),
            updated_at DATETIME DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_collector_heartbeats_platform ON collector_heartbeats(platform, updated_at);
        CREATE INDEX IF NOT EXISTS idx_wa_runtime_events_account_time ON wa_runtime_events(account_id, created_at);

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

    // Migration: Add Teams user info columns to accounts table
    try {
        const accountsTableInfo = db.prepare("PRAGMA table_info(accounts)").all();
        
        const columnsToAdd = {
            user_id: 'TEXT',
            email: 'TEXT',
            display_name: 'TEXT',
            avatar_url: 'TEXT',
            tenant_id: 'TEXT',
            health_status: 'TEXT',
            chrome_rss_mb: 'INTEGER DEFAULT 0',
            chrome_process_count: 'INTEGER DEFAULT 0',
            chrome_version: 'TEXT',
            runtime_provider: "TEXT DEFAULT 'pm2'",
            pm2_status: 'TEXT',
            pm2_mode: 'TEXT',
            pm2_pid: 'INTEGER',
            pm2_restart_count: 'INTEGER DEFAULT 0',
            pm2_uptime_seconds: 'INTEGER DEFAULT 0',
            orchestrator_state: 'TEXT',
            collector_phase: 'TEXT',
            collector_run_id: 'TEXT',
            collector_heartbeat_age_seconds: 'INTEGER',
            last_runtime_event_at: 'DATETIME',
            last_restart_reason: 'TEXT',
            last_supervisor_check_at: 'DATETIME'
        };
        Object.entries(columnsToAdd).forEach(([col, type]) => {
            const exists = accountsTableInfo.some(c => c.name === col);
            if (!exists) {
                db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${type}`);
                console.log(`Migrated database: added ${col} column to accounts table`);
            }
        });
    } catch (err) {
        console.error('Migration error for accounts table:', err.message);
    }

    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS collector_heartbeats (
                account_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                collector_id TEXT NOT NULL,
                run_id TEXT,
                process_pid INTEGER,
                status TEXT,
                phase TEXT,
                health_status TEXT,
                chrome_rss_mb INTEGER DEFAULT 0,
                chrome_process_count INTEGER DEFAULT 0,
                chrome_version TEXT,
                last_error TEXT,
                last_ready_at DATETIME,
                last_message_at DATETIME,
                started_at DATETIME,
                updated_at DATETIME DEFAULT (datetime('now')),
                PRIMARY KEY (account_id, collector_id)
            );

            CREATE TABLE IF NOT EXISTS wa_runtime_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT 'whatsapp',
                source TEXT NOT NULL DEFAULT 'worker',
                event_type TEXT NOT NULL,
                severity TEXT NOT NULL DEFAULT 'info',
                run_id TEXT,
                message TEXT,
                data_json TEXT,
                created_at DATETIME DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_collector_heartbeats_platform ON collector_heartbeats(platform, updated_at);
            CREATE INDEX IF NOT EXISTS idx_wa_runtime_events_account_time ON wa_runtime_events(account_id, created_at);

            CREATE TABLE IF NOT EXISTS sso_admins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identity TEXT NOT NULL UNIQUE,
                display_name TEXT,
                note TEXT,
                created_by TEXT,
                created_at DATETIME DEFAULT (datetime('now')),
                updated_at DATETIME DEFAULT (datetime('now'))
            );
        `);
    } catch (err) {
        console.error('Migration error for collector runtime tables:', err.message);
    }

    try {
        const seedAdmins = String(process.env.SSO_BOOTSTRAP_ADMINS || process.env.SSO_ADMIN_USERS || '1469,杨杰')
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
        const stmt = db.prepare(`
            INSERT INTO sso_admins (identity, display_name, note, created_by)
            VALUES (?, ?, 'bootstrap', 'system')
            ON CONFLICT(identity) DO NOTHING
        `);
        for (const identity of seedAdmins) {
            stmt.run(identity, identity);
        }
    } catch (err) {
        console.error('Migration error for sso_admins seed:', err.message);
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

        return stmt.run({ receiver_account: data.receiver_account, business_sector: bs, ...data });
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

function toDateTime(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') return new Date(value).toISOString();
    return value;
}

function upsertCollectorHeartbeat(data) {
    try {
        const stmt = db.prepare(`
            INSERT INTO collector_heartbeats (
                account_id, platform, collector_id, run_id, process_pid, status, phase, health_status,
                chrome_rss_mb, chrome_process_count, chrome_version, last_error,
                last_ready_at, last_message_at, started_at, updated_at
            ) VALUES (
                @account_id, @platform, @collector_id, @run_id, @process_pid, @status, @phase, @health_status,
                @chrome_rss_mb, @chrome_process_count, @chrome_version, @last_error,
                @last_ready_at, @last_message_at, @started_at, datetime('now')
            )
            ON CONFLICT(account_id, collector_id) DO UPDATE SET
                run_id = excluded.run_id,
                process_pid = excluded.process_pid,
                status = excluded.status,
                phase = excluded.phase,
                health_status = excluded.health_status,
                chrome_rss_mb = COALESCE(excluded.chrome_rss_mb, chrome_rss_mb),
                chrome_process_count = COALESCE(excluded.chrome_process_count, chrome_process_count),
                chrome_version = COALESCE(excluded.chrome_version, chrome_version),
                last_error = excluded.last_error,
                last_ready_at = COALESCE(excluded.last_ready_at, last_ready_at),
                last_message_at = COALESCE(excluded.last_message_at, last_message_at),
                started_at = COALESCE(excluded.started_at, started_at),
                updated_at = datetime('now')
        `);

        stmt.run({
            account_id: data.accountId,
            platform: data.platform || 'whatsapp',
            collector_id: data.collectorId || data.accountId,
            run_id: data.runId || null,
            process_pid: data.pid || null,
            status: data.status || null,
            phase: data.phase || null,
            health_status: data.healthStatus || data.phase || null,
            chrome_rss_mb: data.chromeRssMb ?? null,
            chrome_process_count: data.chromeProcessCount ?? null,
            chrome_version: data.chromeVersion || null,
            last_error: data.lastError || null,
            last_ready_at: toDateTime(data.lastReadyAt),
            last_message_at: toDateTime(data.lastMessageAt),
            started_at: toDateTime(data.startedAt)
        });
    } catch (err) {
        console.error('Error saving collector heartbeat:', err.message);
    }
}

function recordRuntimeEvent(data) {
    try {
        db.prepare(`
            INSERT INTO wa_runtime_events (
                account_id, platform, source, event_type, severity, run_id, message, data_json
            ) VALUES (
                @account_id, @platform, @source, @event_type, @severity, @run_id, @message, @data_json
            )
        `).run({
            account_id: data.accountId,
            platform: data.platform || 'whatsapp',
            source: data.source || 'worker',
            event_type: data.eventType,
            severity: data.severity || 'info',
            run_id: data.runId || null,
            message: data.message || null,
            data_json: data.data ? JSON.stringify(data.data) : null
        });
    } catch (err) {
        console.error('Error saving runtime event:', err.message);
    }
}

module.exports = {
    db,
    saveMessage,
    updateAccountStatus,
    upsertCollectorHeartbeat,
    recordRuntimeEvent
};
