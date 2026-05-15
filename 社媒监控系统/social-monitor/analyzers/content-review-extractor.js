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

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');

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

// ─── 内容模板库 ──────────────────────────────────────────────────
let _templateTableReady = true;
function ensureTemplateTable() {
  if (!_templateTableReady) return false;
  try {
    analyticsDb.prepare('SELECT COUNT(*) FROM content_template_lib LIMIT 1').get();
    try { analyticsDb.prepare('ALTER TABLE content_template_lib ADD COLUMN source_issue_id INTEGER').run(); } catch (_) {}
    return true;
  } catch (_) {
    _templateTableReady = false;
    return false;
  }
}

function isTemplateExtracted(sourceMsgId) {
  if (!ensureTemplateTable()) return true; // table missing, skip
  const row = analyticsDb
    .prepare('SELECT id FROM content_template_lib WHERE source_msg_ids LIKE ? LIMIT 1')
    .get(`%${sourceMsgId}%`);
  return !!row;
}

function saveTemplate(tmpl, groupName, msgIds) {
  if (!ensureTemplateTable()) return null;
  const result = analyticsDb.prepare(`
    INSERT INTO content_template_lib
      (customer_name, template_content, template_type, target_region, target_operator,
       review_result, compliance_notes, source_group_name, source_msg_ids, frequency, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    tmpl.customer_name, tmpl.template_content, tmpl.template_type,
    tmpl.target_region, tmpl.target_operator, tmpl.review_result,
    tmpl.compliance_notes, groupName, JSON.stringify(msgIds), Date.now()
  );
  console.log(`[content-review] 📝 新增模板 #${result.lastInsertRowid}: ${tmpl.customer_name} — ${tmpl.template_type}`);
  return result.lastInsertRowid;
}

async function extractAndSaveTemplate(groupName, pendingMsg, replyMsg, sectorName, reviewVerdict) {
  // 从所有板块的审核对话中提取内容模板
  if (isTemplateExtracted(pendingMsg.id)) return;

  const aiClient = require('../lib/ai-client');
  const conversationMsgs = [pendingMsg, replyMsg];
  try {
    const tmpl = await aiClient.analyzeContentTemplate(groupName, conversationMsgs, reviewVerdict);
    if (!tmpl || !tmpl.customer_name || !tmpl.template_content) {
      console.log(`[content-review] 📝 跳过模板提取（AI未识别出有效模板）`);
      return;
    }
    saveTemplate(tmpl, groupName, [pendingMsg.id, replyMsg.id]);
  } catch (err) {
    console.error(`[content-review] 模板提取失败:`, err.message);
  }
}

// ─── 处理逻辑 ────────────────────────────────────────────────────
async function processMessages() {
  const cursor = getLastProcessed();

  const newMsgs = sourceDb
    .prepare(`
      SELECT id, group_id, group_name, receiver_account, sender_name, content, timestamp
      FROM messages
      WHERE id > ?
        AND content IS NOT NULL AND content != ''
      ORDER BY id ASC
      LIMIT 500
    `)
    .all(cursor.last_msg_id);

  if (newMsgs.length === 0) return;

  let currentBatchTime = Date.now();
  if (newMsgs.length > 0) {
    currentBatchTime = newMsgs[newMsgs.length - 1].timestamp;
  }

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
        const aiClient = require('../lib/ai-client');
        const aiResult = await aiClient.analyzeContentReview(
          pending.originalMsg.sender_name,
          pending.originalMsg.content,
          msg.content
        );

        let isApproved = null;
        let rejectionReason = null;
        let aiConfidence = null;

        if (aiResult) {
          isApproved = aiResult.approved === true ? 1 : (aiResult.approved === false ? 0 : null);
          rejectionReason = aiResult.approved === false ? (aiResult.reason || msg.content) : null;
          aiConfidence = aiResult.confidence;
        } else {
          // AI 不可用：回退到关键词判定
          if (/ok|go ahead|approved|fine|yes|可以|没问题|没问题|通过/i.test(msg.content)) {
            isApproved = 1;
            aiConfidence = 0.3;
          } else if (/no|reject|cannot|don't|not|不行|不可以|拒绝|blocked/i.test(msg.content)) {
            isApproved = 0;
            rejectionReason = msg.content.slice(0, 200);
            aiConfidence = 0.3;
          }
        }

        const verdictText = isApproved === 1 ? 'approved' : (isApproved === 0 ? 'rejected' : 'pending');
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

        console.log(`[content-review] 记录审核回复: ${msg.group_name} | Approved: ${isApproved}${aiConfidence !== null ? ` | AI置信度: ${aiConfidence.toFixed(2)}` : ''}`);

        // 提取内容模板（所有板块 + 所有判定结果，AI 自行判断是否可提取）
        try {
          const regionCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'account-regions.json'), 'utf8'));
          const acctInfo = (regionCfg.accounts || []).find(a => a.account === msg.receiver_account);
          const sector = acctInfo?.business_sector || '';
          extractAndSaveTemplate(msg.group_name, pending.originalMsg, msg, sector, verdictText);
        } catch (err) {
          console.error(`[content-review] 模板提取异常: ${msg.group_name}`, err.message);
        }

        // 清除 pending
        pendingReviews.delete(key);
      }
    }
  }

  // 清理过期 pending (基于当前处理的消息时间而非系统时间)
  for (const [key, pending] of pendingReviews.entries()) {
    if (currentBatchTime > pending.expireAt) {
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

module.exports = {
  processMessages,
};

if (require.main === module) {
  console.log('[content-review-extractor] 启动，轮询间隔: 60s');
  tick();

  process.on('SIGINT', () => {
      console.log('[content-review-extractor] SIGINT 收到，正在优雅关闭...');
      try { sourceDb.close(); } catch (_) {}
      try { analyticsDb.close(); } catch (_) {}
      process.exit(0);
  });
}
