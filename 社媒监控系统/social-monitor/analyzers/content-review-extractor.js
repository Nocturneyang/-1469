/**
 * analyzers/content-review-extractor.js
 * 内容审核知识库提取 — 阶段C（维度5）
 *
 * 职责：
 *   1. 识别 ITNIO 运营人员发给供应商的审核请求
 *   2. 监控随后短时间内供应商的回复，提取是否批准及拒绝理由
 *   3. 写入 analytics.sqlite: content_reviews
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');

const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

const CONTENT_CHECK_TRIGGERS = [
  /check this content/i, 
  /can you (?:test|send|check)/i,
  /check the (?:sms|content|message)/i, 
  /is this (?:ok|fine) to send/i,
];

// 内部账号识别 (动态配置)
const { isInternalStaff } = require('../lib/staff-detector');

// ─── 游标管理 ────────────────────────────────────────────────────
const ANALYZER_NAME = 'content-review-extractor';

function getLastProcessed() {
  const row = analyticsDb
    .prepare('SELECT last_msg_id, last_ts FROM analysis_cursor WHERE analyzer = ?')
    .get(ANALYZER_NAME);
  
  if (!row) {
    analyticsDb.prepare(`INSERT INTO analysis_cursor (analyzer, last_msg_id, last_ts) VALUES (?, 0, 0)`).run(ANALYZER_NAME);
    return { last_msg_id: 0, last_ts: 0 };
  }
  return row;
}

function updateCursor(lastMsgId, lastTs) {
  analyticsDb
    .prepare(`
      UPDATE analysis_cursor
      SET last_msg_id = ?, last_ts = ?, updated_at = datetime('now', '+8 hours')
      WHERE analyzer = ?
    `)
    .run(lastMsgId, lastTs, ANALYZER_NAME);
}

// ─── 状态管理 ────────────────────────────────────────────────────
// 缓存等待审核回复的消息 { groupId: { originalMsg, expireAt } }
const pendingReviews = new Map();
const REVIEW_WINDOW_MS = 30 * 60 * 1000; // 30 分钟窗口等待 ITNIO 回复

// ─── 处理逻辑 ────────────────────────────────────────────────────
async function processMessages() {
  const cursor = getLastProcessed();

  const newMsgs = sourceDb
    .prepare(`
      SELECT id, group_id, group_name, sender_name, content, timestamp
      FROM messages
      WHERE id > ?
        AND content IS NOT NULL AND content != ''
      ORDER BY id ASC
      LIMIT 500
    `)
    .all(cursor.last_msg_id);

  if (newMsgs.length === 0) return;

  const now = Date.now();

  for (const msg of newMsgs) {
    const isInternal = isInternalStaff(msg.sender_name);
    const key = msg.group_id || msg.group_name;

    if (isInternal) {
      // 内部人员 (ITNIO) 发言，检测是否包含要求审核内容的请求
      let isReviewRequest = false;
      for (const pattern of CONTENT_CHECK_TRIGGERS) {
        if (pattern.test(msg.content)) {
          isReviewRequest = true;
          break;
        }
      }

      if (isReviewRequest) {
        pendingReviews.set(key, { originalMsg: msg, expireAt: msg.timestamp + REVIEW_WINDOW_MS });
        console.log(`[content-review] 发现内部审核请求: ${msg.group_name} | ${msg.sender_name}`);
      }
    } else {
      // 外部人员 (供应商) 发言，检查是否是针对之前的审核请求的回复
      const pending = pendingReviews.get(key);
      if (pending && msg.timestamp <= pending.expireAt) {
        // 粗略判断通过/拒绝 (可接入AI进行更精准的判断)
        const isApproved = /ok|go ahead|approved|fine|yes/i.test(msg.content) ? 1 : 
                           (/no|reject|cannot|don't|not/i.test(msg.content) ? 0 : null);
                           
        const rejectionReason = isApproved === 0 ? msg.content : null;

        analyticsDb.prepare(`
          INSERT INTO content_reviews 
            (group_name, submitter_name, content_submitted, reviewer_reply, approved, rejection_reason, source_msg_id, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pending.originalMsg.group_name,
          pending.originalMsg.sender_name,
          pending.originalMsg.content,
          msg.content,
          isApproved,
          rejectionReason,
          pending.originalMsg.id,
          pending.originalMsg.timestamp
        );
        
        console.log(`[content-review] 记录审核回复: ${msg.group_name} | Approved: ${isApproved}`);
        
        // 清除 pending
        pendingReviews.delete(key);
      }
    }
  }

  // 清理过期 pending
  for (const [key, pending] of pendingReviews.entries()) {
    if (now > pending.expireAt) {
      pendingReviews.delete(key);
    }
  }

  // 更新游标
  const maxId = Math.max(...newMsgs.map((m) => m.id));
  const maxTs = Math.max(...newMsgs.map((m) => m.timestamp));
  updateCursor(maxId, maxTs);
}

// ─── 启动轮询 ────────────────────────────────────────────────────
function tick() {
  try {
    processMessages();
  } catch (err) {
    console.error('[content-review-extractor] tick 出错:', err.message);
  }
  setTimeout(tick, 60000); // 1分钟轮询一次
}

console.log('[content-review-extractor] 启动，轮询间隔: 60s');
tick();
