const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { shanghaiISOString } = require('../lib/time');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const dbPath = path.join(DATA_DIR, 'db', 'database.sqlite');
const mediaDir = path.join(DATA_DIR, 'media');
const REGION_CONFIG_PATH = path.join(DATA_DIR, 'config', 'account-regions.json');
function envFlagValue(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

const DB_MAINTENANCE_MODE = envFlagValue(process.env.DB_MAINTENANCE_MODE);
const DB_READONLY_MODE = envFlagValue(process.env.DB_READONLY_MODE);
const DB_DEGRADED_BOOT = envFlagValue(process.env.DB_DEGRADED_BOOT) || DB_MAINTENANCE_MODE;
const COLLECTOR_REMOTE_ONLY = envFlagValue(process.env.COLLECTOR_REMOTE_ONLY);
let dbRuntimeDegraded = DB_DEGRADED_BOOT;
let dbRuntimeDegradedReason = DB_DEGRADED_BOOT
    ? (DB_MAINTENANCE_MODE ? 'DB_MAINTENANCE_MODE is enabled' : 'DB_DEGRADED_BOOT is enabled')
    : '';

// Ensure media directory exists
if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
}

function createUnavailableDb(reason = 'database unavailable: DB_DEGRADED_BOOT is enabled') {
    const unavailable = () => {
        throw new Error(reason);
    };
    return {
        prepare: unavailable,
        exec: unavailable,
        pragma: unavailable,
        transaction: () => unavailable,
        close: () => {},
    };
}

let db = createUnavailableDb(dbRuntimeDegradedReason || 'database unavailable');
if (COLLECTOR_REMOTE_ONLY) {
    dbRuntimeDegraded = true;
    dbRuntimeDegradedReason = 'COLLECTOR_REMOTE_ONLY is enabled';
    db = createUnavailableDb(`database unavailable: ${dbRuntimeDegradedReason}`);
} else if (!DB_DEGRADED_BOOT) {
    try {
        db = new Database(dbPath, DB_READONLY_MODE ? { readonly: true, fileMustExist: true } : undefined);
    } catch (err) {
        dbRuntimeDegraded = true;
        dbRuntimeDegradedReason = `failed to open database.sqlite: ${err.message}`;
        db = createUnavailableDb(`database unavailable: ${dbRuntimeDegradedReason}`);
        console.error(`[DB] ${dbRuntimeDegradedReason}`);
    }
}

function safePragma(database, statement, label) {
    try {
        return database.pragma(statement);
    } catch (err) {
        console.warn(`[DB] ${label || statement} failed, continuing in degraded mode: ${err.message}`);
        return null;
    }
}

// Enable WAL mode for better concurrency performance. If the persisted DB is
// already in a bad I/O state, do not crash the UI server before health routes
// can report the problem.
if (COLLECTOR_REMOTE_ONLY) {
    console.warn('[DB] COLLECTOR_REMOTE_ONLY enabled; local SQLite writes are disabled in this collector process');
} else if (dbRuntimeDegraded) {
    console.warn(`[DB] SQLite access is disabled for this process: ${dbRuntimeDegradedReason}`);
} else if (DB_READONLY_MODE) {
    console.warn('[DB] DB_READONLY_MODE enabled; database.sqlite opened read-only and schema migrations are skipped');
    safePragma(db, 'busy_timeout = 5000', 'set busy timeout');
} else {
    safePragma(db, 'journal_mode = WAL', 'enable WAL');
    safePragma(db, 'busy_timeout = 5000', 'set busy timeout');
}

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
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
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
            runtime_desired_state TEXT,
            deployment_name TEXT,
            session_status TEXT,
            last_runtime_event_at DATETIME,
            last_restart_reason TEXT,
            last_supervisor_check_at DATETIME,
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
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
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
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
            created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE TABLE IF NOT EXISTS sso_admins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            identity TEXT NOT NULL UNIQUE,
            display_name TEXT,
            note TEXT,
            created_by TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE TABLE IF NOT EXISTS collector_runtime_specs (
            account_id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            account_name TEXT NOT NULL,
            runtime_provider TEXT NOT NULL DEFAULT 'k8s',
            desired_state TEXT NOT NULL DEFAULT 'running',
            deployment_name TEXT,
            namespace TEXT,
            image TEXT,
            resource_json TEXT,
            session_dir TEXT,
            migration_source TEXT,
            last_applied_at DATETIME,
            last_error TEXT,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        );

        CREATE INDEX IF NOT EXISTS idx_collector_heartbeats_platform ON collector_heartbeats(platform, updated_at);
        CREATE INDEX IF NOT EXISTS idx_wa_runtime_events_account_time ON wa_runtime_events(account_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_collector_runtime_specs_platform ON collector_runtime_specs(platform, desired_state);

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'viewer',
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
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

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_messages_is_synced ON messages(is_synced);
            CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_platform_timestamp ON messages(platform, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_has_media ON messages(has_media);
            CREATE INDEX IF NOT EXISTS idx_messages_group_name ON messages(group_name);
        `);
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
            runtime_desired_state: 'TEXT',
            deployment_name: 'TEXT',
            session_status: 'TEXT',
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
                updated_at DATETIME DEFAULT (datetime('now', '+8 hours')),
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
                created_at DATETIME DEFAULT (datetime('now', '+8 hours'))
            );

            CREATE INDEX IF NOT EXISTS idx_collector_heartbeats_platform ON collector_heartbeats(platform, updated_at);
            CREATE INDEX IF NOT EXISTS idx_wa_runtime_events_account_time ON wa_runtime_events(account_id, created_at);

            CREATE TABLE IF NOT EXISTS collector_runtime_specs (
                account_id TEXT PRIMARY KEY,
                platform TEXT NOT NULL,
                account_name TEXT NOT NULL,
                runtime_provider TEXT NOT NULL DEFAULT 'k8s',
                desired_state TEXT NOT NULL DEFAULT 'running',
                deployment_name TEXT,
                namespace TEXT,
                image TEXT,
                resource_json TEXT,
                session_dir TEXT,
                migration_source TEXT,
                last_applied_at DATETIME,
                last_error TEXT,
                created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
            );

            CREATE INDEX IF NOT EXISTS idx_collector_runtime_specs_platform ON collector_runtime_specs(platform, desired_state);

            CREATE TABLE IF NOT EXISTS sso_admins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identity TEXT NOT NULL UNIQUE,
                display_name TEXT,
                note TEXT,
                created_by TEXT,
                created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
                updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
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

if (!dbRuntimeDegraded && !DB_READONLY_MODE) {
    try {
        initSchema();
    } catch (err) {
        const previousDb = db;
        dbRuntimeDegraded = true;
        dbRuntimeDegradedReason = `failed to initialize database.sqlite: ${err.message}`;
        db = createUnavailableDb(`database unavailable: ${dbRuntimeDegradedReason}`);
        try { previousDb.close(); } catch (_) {}
        console.error(`[DB] ${dbRuntimeDegradedReason}`);
    }
}

function isDbRuntimeDegraded() {
    return dbRuntimeDegraded;
}

function getDbRuntimeDegradedReason() {
    return dbRuntimeDegradedReason;
}

// Insert message with duplicate handling
function saveMessage(data) {
    if (COLLECTOR_REMOTE_ONLY) return { changes: 0, remoteOnly: true };
    try {
        const stmt = db.prepare(`
            INSERT INTO messages (
                platform, receiver_account, business_sector, message_id, group_id, group_name, sender_id, sender_name,
                content, has_media, media_path, timestamp, raw_data, created_at
            ) VALUES (
                @platform, @receiver_account, @business_sector, @message_id, @group_id, @group_name, @sender_id, @sender_name,
                @content, @has_media, @media_path, @timestamp, @raw_data, datetime('now', '+8 hours')
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
    if (COLLECTOR_REMOTE_ONLY) return;
    try {
        const stmt = db.prepare(`
            INSERT INTO accounts (id, platform, status, pushname, qr_code, updated_at)
            VALUES (@id, @platform, @status, @pushname, @qr_code, datetime('now', '+8 hours'))
            ON CONFLICT(id) DO UPDATE SET
              status=excluded.status,
              pushname=COALESCE(excluded.pushname, pushname),
              qr_code=excluded.qr_code,
              updated_at=datetime('now', '+8 hours')
        `);
        stmt.run({ id, platform, status, pushname, qr_code: qrCode });
    } catch (err) {
        console.error('Error saving account status:', err.message);
    }
}

function toDateTime(value) {
    if (!value) return null;
    if (value instanceof Date) return shanghaiISOString(value);
    if (typeof value === 'number') return shanghaiISOString(value);
    return value;
}

function upsertCollectorHeartbeat(data) {
    if (COLLECTOR_REMOTE_ONLY) return;
    try {
        const stmt = db.prepare(`
            INSERT INTO collector_heartbeats (
                account_id, platform, collector_id, run_id, process_pid, status, phase, health_status,
                chrome_rss_mb, chrome_process_count, chrome_version, last_error,
                last_ready_at, last_message_at, started_at, updated_at
            ) VALUES (
                @account_id, @platform, @collector_id, @run_id, @process_pid, @status, @phase, @health_status,
                @chrome_rss_mb, @chrome_process_count, @chrome_version, @last_error,
                @last_ready_at, @last_message_at, @started_at, datetime('now', '+8 hours')
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
                updated_at = datetime('now', '+8 hours')
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
    if (COLLECTOR_REMOTE_ONLY) return;
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

function parseJsonSafe(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function normalizeRuntimeSpec(spec) {
    return {
        account_id: spec.accountId,
        platform: spec.platform,
        account_name: spec.accountName,
        runtime_provider: spec.runtimeProvider || 'k8s',
        desired_state: spec.desiredState || 'running',
        deployment_name: spec.deploymentName || null,
        namespace: spec.namespace || null,
        image: spec.image || null,
        resource_json: spec.resources ? JSON.stringify(spec.resources) : null,
        session_dir: spec.sessionDir || null,
        migration_source: spec.migrationSource || null,
        last_error: spec.lastError || null
    };
}

function hydrateRuntimeSpec(row) {
    if (!row) return null;
    return {
        ...row,
        resources: parseJsonSafe(row.resource_json, null)
    };
}

function upsertCollectorRuntimeSpec(spec) {
    if (COLLECTOR_REMOTE_ONLY) return null;
    const row = normalizeRuntimeSpec(spec);
    db.prepare(`
        INSERT INTO collector_runtime_specs (
            account_id, platform, account_name, runtime_provider, desired_state,
            deployment_name, namespace, image, resource_json, session_dir,
            migration_source, last_applied_at, last_error, updated_at
        ) VALUES (
            @account_id, @platform, @account_name, @runtime_provider, @desired_state,
            @deployment_name, @namespace, @image, @resource_json, @session_dir,
            @migration_source, datetime('now', '+8 hours'), @last_error, datetime('now', '+8 hours')
        )
        ON CONFLICT(account_id) DO UPDATE SET
            platform = excluded.platform,
            account_name = excluded.account_name,
            runtime_provider = excluded.runtime_provider,
            desired_state = excluded.desired_state,
            deployment_name = excluded.deployment_name,
            namespace = excluded.namespace,
            image = excluded.image,
            resource_json = excluded.resource_json,
            session_dir = excluded.session_dir,
            migration_source = COALESCE(excluded.migration_source, migration_source),
            last_applied_at = excluded.last_applied_at,
            last_error = excluded.last_error,
            updated_at = datetime('now', '+8 hours')
    `).run(row);

    db.prepare(`
        UPDATE accounts
        SET runtime_provider = @runtime_provider,
            runtime_desired_state = @desired_state,
            deployment_name = @deployment_name,
            updated_at = datetime('now', '+8 hours')
        WHERE id = @account_id
    `).run(row);

    return getCollectorRuntimeSpec(row.account_id);
}

function getCollectorRuntimeSpec(accountId) {
    if (COLLECTOR_REMOTE_ONLY) return null;
    return hydrateRuntimeSpec(db.prepare('SELECT * FROM collector_runtime_specs WHERE account_id = ?').get(accountId));
}

function listCollectorRuntimeSpecs(filters = {}) {
    if (COLLECTOR_REMOTE_ONLY) return [];
    const clauses = [];
    const params = [];
    if (filters.platform) {
        clauses.push('platform = ?');
        params.push(filters.platform);
    }
    if (filters.desiredState) {
        clauses.push('desired_state = ?');
        params.push(filters.desiredState);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`
        SELECT *
        FROM collector_runtime_specs
        ${where}
        ORDER BY datetime(updated_at) DESC
    `).all(...params).map(hydrateRuntimeSpec);
}

function updateCollectorRuntimeDesiredState(accountId, desiredState, patch = {}) {
    if (COLLECTOR_REMOTE_ONLY) return null;
    db.prepare(`
        UPDATE collector_runtime_specs
        SET desired_state = ?,
            last_error = ?,
            updated_at = datetime('now', '+8 hours')
        WHERE account_id = ?
    `).run(desiredState, patch.lastError || null, accountId);
    db.prepare(`
        UPDATE accounts
        SET runtime_desired_state = ?,
            orchestrator_state = COALESCE(?, orchestrator_state),
            health_status = COALESCE(?, health_status),
            last_supervisor_check_at = datetime('now', '+8 hours'),
            updated_at = datetime('now', '+8 hours')
        WHERE id = ?
    `).run(desiredState, patch.orchestratorState || null, patch.healthStatus || null, accountId);
    return getCollectorRuntimeSpec(accountId);
}

function deleteCollectorRuntimeSpec(accountId) {
    if (COLLECTOR_REMOTE_ONLY) return;
    db.prepare('DELETE FROM collector_runtime_specs WHERE account_id = ?').run(accountId);
    db.prepare(`
        UPDATE accounts
        SET runtime_desired_state = NULL,
            deployment_name = NULL,
            updated_at = datetime('now', '+8 hours')
        WHERE id = ?
    `).run(accountId);
}

module.exports = {
    db,
    isDbRuntimeDegraded,
    getDbRuntimeDegradedReason,
    saveMessage,
    updateAccountStatus,
    upsertCollectorHeartbeat,
    recordRuntimeEvent,
    upsertCollectorRuntimeSpec,
    getCollectorRuntimeSpec,
    listCollectorRuntimeSpecs,
    updateCollectorRuntimeDesiredState,
    deleteCollectorRuntimeSpec
};
