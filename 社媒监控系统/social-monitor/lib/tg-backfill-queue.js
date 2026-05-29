/**
 * tg-backfill-queue.js
 * Telegram 历史消息回溯队列
 * - 持久化到 analytics.sqlite（tg_backfill_tasks 表）
 * - 串行单线程：同一时刻只拉取一个群的一批消息
 * - 断点续传：通过 offset_id 游标持久化
 * - 日配额控制：达到 daily_limit 后自动暂停到次日
 * - 严格遵守 FloodWait 退避
 */
const path = require('path');
const Database = require('better-sqlite3');
const { saveMessage } = require('../db/database');

const analyticsDbPath = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'db', 'analytics.sqlite');

let analyticsDb = null;

function getDb() {
    if (!analyticsDb) {
        analyticsDb = new Database(analyticsDbPath);
        analyticsDb.pragma('journal_mode = WAL');
        initSchema();
    }
    return analyticsDb;
}

function initSchema() {
    analyticsDb.exec(`
        CREATE TABLE IF NOT EXISTS tg_backfill_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_name TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            chat_title TEXT,
            offset_id INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',   -- pending / running / paused / completed / error
            today_count INTEGER DEFAULT 0,
            total_count INTEGER DEFAULT 0,
            last_reset_date TEXT,
            created_at DATETIME DEFAULT (datetime('now')),
            updated_at DATETIME DEFAULT (datetime('now')),
            UNIQUE(account_name, chat_id)
        );
    `);
}

// ─── 辅助：随机睡眠 ──────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomSleep(minMs, maxMs) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return sleep(ms);
}

// ─── 今日计数重置检测 ─────────────────────────────────────────────────────────
function todayDateStr() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function resetDailyCountIfNeeded(db, taskId, lastResetDate) {
    const today = todayDateStr();
    if (lastResetDate !== today) {
        db.prepare(`
            UPDATE tg_backfill_tasks
            SET today_count = 0, last_reset_date = ?, updated_at = datetime('now')
            WHERE id = ?
        `).run(today, taskId);
        return true;
    }
    return false;
}

// ─── 公开 API ────────────────────────────────────────────────────────────────

/**
 * 注册回溯任务（若已存在则跳过）
 * @param {string} accountName
 * @param {string|number} chatId
 * @param {string} chatTitle
 */
function registerTask(accountName, chatId, chatTitle = '') {
    const db = getDb();
    db.prepare(`
        INSERT OR IGNORE INTO tg_backfill_tasks (account_name, chat_id, chat_title, last_reset_date)
        VALUES (?, ?, ?, ?)
    `).run(accountName, String(chatId), chatTitle, todayDateStr());
}

/**
 * 获取某账号的所有回溯任务
 * @param {string} accountName
 * @returns {Array}
 */
function getTasks(accountName) {
    const db = getDb();
    return db.prepare(`
        SELECT * FROM tg_backfill_tasks WHERE account_name = ? ORDER BY id ASC
    `).all(accountName);
}

/**
 * 暂停某账号的所有 running/pending 任务
 * @param {string} accountName
 */
function pauseTasks(accountName) {
    const db = getDb();
    db.prepare(`
        UPDATE tg_backfill_tasks
        SET status = 'paused', updated_at = datetime('now')
        WHERE account_name = ? AND status IN ('pending', 'running')
    `).run(accountName);
}

/**
 * 恢复某账号暂停的任务
 * @param {string} accountName
 */
function resumeTasks(accountName) {
    const db = getDb();
    db.prepare(`
        UPDATE tg_backfill_tasks
        SET status = 'pending', updated_at = datetime('now')
        WHERE account_name = ? AND status = 'paused'
    `).run(accountName);
}

/**
 * 重置某个群的回溯进度（从头开始）
 * @param {string} accountName
 * @param {string} chatId
 */
function resetTask(accountName, chatId) {
    const db = getDb();
    db.prepare(`
        UPDATE tg_backfill_tasks
        SET offset_id = 0, status = 'pending', today_count = 0, total_count = 0,
            updated_at = datetime('now')
        WHERE account_name = ? AND chat_id = ?
    `).run(accountName, String(chatId));
}

/**
 * 核心：启动回溯队列处理循环（后台长期运行，永不退出）
 * @param {object} client          gramjs TelegramClient 实例
 * @param {string} accountName     账号名
 * @param {object} rateLimitCfg    频控参数 { daily_limit, batch_size, sleep_min_ms, sleep_max_ms }
 * @param {Function} onCircuitBreak  熔断回调 (error) => void
 */
async function runBackfillLoop(client, accountName, rateLimitCfg, onCircuitBreak, options = {}) {
    const { Api } = require('telegram');
    const saveMessageFn = options.saveMessageFn || saveMessage;
    const db = getDb();
    const {
        daily_limit = 2000,
        batch_size = 100,
        sleep_min_ms = 3000,
        sleep_max_ms = 8000
    } = rateLimitCfg;

    console.log(`[Backfill] Loop started for account: ${accountName}`);

    while (true) {
        // 取一个待处理的任务
        const task = db.prepare(`
            SELECT * FROM tg_backfill_tasks
            WHERE account_name = ? AND status IN ('pending', 'running')
            ORDER BY id ASC LIMIT 1
        `).get(accountName);

        if (!task) {
            // 没有待处理任务，等 60 秒再检查（可能后续会有新任务注册）
            await sleep(60000);
            continue;
        }

        // 重置今日计数（如跨日）
        resetDailyCountIfNeeded(db, task.id, task.last_reset_date);
        // 重新取最新数据
        const freshTask = db.prepare(`SELECT * FROM tg_backfill_tasks WHERE id = ?`).get(task.id);

        // 达到日配额，等到次日 00:00
        if (freshTask.today_count >= daily_limit) {
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(0, 0, 10, 0); // 次日 00:00:10
            const waitMs = tomorrow - now;
            console.log(`[Backfill] Daily limit reached (${freshTask.today_count}/${daily_limit}). Sleeping until ${tomorrow.toLocaleString()}`);
            await sleep(waitMs);
            continue;
        }

        // 标记为 running
        db.prepare(`
            UPDATE tg_backfill_tasks
            SET status = 'running', updated_at = datetime('now')
            WHERE id = ?
        `).run(task.id);

        try {
            // 拉取一批历史消息
            const result = await client.invoke(
                new Api.messages.GetHistory({
                    peer: await client.getInputEntity(freshTask.chat_id),
                    offsetId: freshTask.offset_id,
                    offsetDate: 0,
                    addOffset: 0,
                    limit: batch_size,
                    maxId: 0,
                    minId: 0,
                    hash: BigInt(0)
                })
            );

            const messages = result.messages || [];

            if (messages.length === 0) {
                // 该群历史已拉完
                db.prepare(`
                    UPDATE tg_backfill_tasks
                    SET status = 'completed', updated_at = datetime('now')
                    WHERE id = ?
                `).run(task.id);
                console.log(`[Backfill] Completed chat: ${freshTask.chat_title || freshTask.chat_id}`);
                continue;
            }

            // 写入 database.sqlite
            let savedCount = 0;
            let minMsgId = Infinity;
            for (const msg of messages) {
                if (!msg.message && !msg.media) continue; // 跳过空消息
                const msgId = Number(msg.id);
                if (msgId < minMsgId) minMsgId = msgId;
                try {
                    const groupIdStr = String(freshTask.chat_id);
                    const groupIdAbs = groupIdStr.replace(/^-100/, '').replace(/^-/, '');
                    const globalMessageId = `${groupIdAbs}_${msgId}`;

                    await saveMessageFn({
                        platform: 'telegram',
                        receiver_account: `tgu-${accountName}`,
                        message_id: globalMessageId,
                        group_id: groupIdStr,
                        group_name: freshTask.chat_title || String(freshTask.chat_id),
                        sender_id: msg.fromId ? String(msg.fromId.userId || msg.fromId.channelId || '') : '',
                        sender_name: '',
                        content: msg.message || '',
                        has_media: msg.media ? 1 : 0,
                        media_path: null,
                        timestamp: msg.date * 1000,
                        raw_data: JSON.stringify({ id: msgId, date: msg.date })
                    });
                    savedCount++;
                } catch (e) {
                    // ON CONFLICT DO NOTHING 已处理重复，忽略其它错误
                }
            }

            // 更新游标
            const newOffsetId = minMsgId === Infinity ? freshTask.offset_id : minMsgId;
            db.prepare(`
                UPDATE tg_backfill_tasks
                SET offset_id = ?,
                    today_count = today_count + ?,
                    total_count = total_count + ?,
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(newOffsetId, savedCount, savedCount, task.id);

            console.log(`[Backfill] ${freshTask.chat_title || freshTask.chat_id}: saved ${savedCount} msgs, offset→${newOffsetId}`);

        } catch (err) {
            const errName = err.constructor?.name || err.errorMessage || '';

            if (errName.includes('FloodWait') || (err.seconds && err.seconds > 0)) {
                // FloodWait：严格按返回的秒数等待
                const waitSec = err.seconds || 60;
                console.warn(`[Backfill] FloodWait ${waitSec}s for ${accountName}, sleeping...`);
                await sleep(waitSec * 1000 + 2000); // 额外 buffer 2s

            } else if (errName.includes('PeerFlood') || errName.includes('UserBannedInChannel')) {
                // 严重封控：熔断
                console.error(`[Backfill] CIRCUIT BREAK: ${errName} for ${accountName}`);
                db.prepare(`
                    UPDATE tg_backfill_tasks
                    SET status = 'paused', updated_at = datetime('now')
                    WHERE account_name = ?
                `).run(accountName);
                if (typeof onCircuitBreak === 'function') onCircuitBreak(err);
                await sleep(24 * 60 * 60 * 1000); // 熔断后等 24 小时

            } else {
                // 其它错误：更新任务状态并等待后重试
                console.error(`[Backfill] Error for ${freshTask.chat_id}:`, err.message || err);
                db.prepare(`
                    UPDATE tg_backfill_tasks
                    SET status = 'pending', updated_at = datetime('now')
                    WHERE id = ?
                `).run(task.id);
                await sleep(30000);
            }
            continue;
        }

        // 每批次之间随机抖动
        await randomSleep(sleep_min_ms, sleep_max_ms);
    }
}

module.exports = {
    registerTask,
    getTasks,
    pauseTasks,
    resumeTasks,
    resetTask,
    runBackfillLoop
};
