/**
 * analyzers/knowledge-extractor.js
 * QA 知识库自动提取 — 阶段B（维度6）
 *
 * 职责：
 *   1. 监听 issue_records 中 status='closed' 且未被提取过的记录
 *   2. 获取该 issue 的完整对话窗口（前 10 条 → 闭环消息）
 *   3. 调用 AI 提取 QA 知识对
 *   4. 去重合并到 qa_knowledge_base（同板块+同分类+关键词相似 → 更新频次）
 *   5. 置信度自动计算：frequency≥5→0.95, ≥3→0.85, ≥2→0.7, 1→0.4
 */

'use strict';

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const aiClient = require('../lib/ai-client');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');

const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

const ANALYZER_NAME = 'knowledge-extractor';

// ─── 游标管理 ────────────────────────────────────────────────────
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

function updateCursor(lastId, lastTs) {
  analyticsDb
    .prepare(`UPDATE analysis_cursor SET last_msg_id = ?, last_ts = ?, updated_at = datetime('now', '+8 hours') WHERE analyzer = ?`)
    .run(lastId, lastTs, ANALYZER_NAME);
}

// ─── 已提取标记（延迟初始化，容错表不存在）───────────────────
let _qaTableReady = true;
function ensureQATable() {
  if (!_qaTableReady) return false;
  try {
    analyticsDb.prepare('SELECT COUNT(*) FROM qa_knowledge_base LIMIT 1').get();
    return true;
  } catch (_) {
    _qaTableReady = false;
    return false;
  }
}

function isAlreadyExtracted(issueId) {
  if (!ensureQATable()) return false;
  const row = analyticsDb
    .prepare('SELECT id FROM qa_knowledge_base WHERE source_issue_id = ? LIMIT 1')
    .get(issueId);
  return !!row;
}

// ─── 简单去重：同板块 + 同分类 + 关键词重叠度 ──────────────────
function findSimilarQA(sector, questionType, keywords) {
  if (!ensureQATable()) return null;
  const candidates = analyticsDb.prepare(`
    SELECT id, question_keywords, frequency, answer_pattern
    FROM qa_knowledge_base
    WHERE business_sector = ? AND question_type = ?
    ORDER BY frequency DESC
  `).all(sector, questionType);

  if (candidates.length === 0) return null;

  const inputKeys = new Set(keywords.split(/[,，]/).map(k => k.trim().toLowerCase()).filter(Boolean));

  for (const c of candidates) {
    const existKeys = new Set((c.question_keywords || '').split(/[,，]/).map(k => k.trim().toLowerCase()).filter(Boolean));
    if (existKeys.size === 0) continue;

    // Jaccard 相似度
    let intersect = 0;
    for (const k of inputKeys) { if (existKeys.has(k)) intersect++; }
    const union = new Set([...inputKeys, ...existKeys]).size;
    const similarity = intersect / union;

    if (similarity >= 0.5) return c; // 视为同一 QA 模式
  }

  return null;
}

// ─── 置信度计算 ──────────────────────────────────────────────────
function calcConfidence(frequency) {
  if (frequency >= 5) return 0.95;
  if (frequency >= 3) return 0.85;
  if (frequency >= 2) return 0.7;
  return 0.4;
}

// ─── 获取对话窗口 ────────────────────────────────────────────────
function getConversationWindow(groupId, groupName, alertTs, closeTs) {
  // 前 10 条（问题触发前的上下文）
  const beforeMsgs = sourceDb.prepare(`
    SELECT sender_name, content, timestamp
    FROM messages
    WHERE (group_id = ? OR group_name = ?)
      AND timestamp < ?
      AND content IS NOT NULL AND content != ''
    ORDER BY timestamp DESC
    LIMIT 10
  `).all(groupId || '', groupName, alertTs).reverse();

  // 从告警到闭环之间的消息（最多50条）
  const afterMsgs = sourceDb.prepare(`
    SELECT sender_name, content, timestamp
    FROM messages
    WHERE (group_id = ? OR group_name = ?)
      AND timestamp >= ?
      AND timestamp <= ?
      AND content IS NOT NULL AND content != ''
    ORDER BY timestamp ASC
    LIMIT 50
  `).all(groupId || '', groupName, alertTs, closeTs);

  return [...beforeMsgs, ...afterMsgs];
}

// ─── 存储 QA ─────────────────────────────────────────────────────
function saveQA(qa, sector, groupName, issueId, msgIds, closeTs) {
  if (!ensureQATable()) { console.warn('[knowledge] qa_knowledge_base 表不存在，跳过存储'); return null; }

  const answerText = Array.isArray(qa.answer_steps)
    ? qa.answer_steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : String(qa.answer_steps || '');

  const similar = findSimilarQA(sector, qa.question_type, qa.question_keywords);

  if (similar) {
    // 已存在相似QA：更新频次 + 置信度
    const newFreq = similar.frequency + 1;
    analyticsDb.prepare(`
      UPDATE qa_knowledge_base
      SET frequency = frequency + 1,
          last_seen_at = ?,
          confidence = ?,
          updated_at = datetime('now', '+8 hours')
      WHERE id = ?
    `).run(closeTs, calcConfidence(newFreq), similar.id);
    console.log(`[knowledge] 🔄 更新已有QA #${similar.id}（频次→${newFreq}）: ${qa.question_type}`);
    return similar.id;
  }

  // 全新QA
  const result = analyticsDb.prepare(`
    INSERT INTO qa_knowledge_base
      (business_sector, question_type, question_summary, question_keywords,
       answer_pattern, answer_category, source_group_name, source_issue_id,
       source_msg_ids, frequency, last_seen_at, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    sector,
    qa.question_type,
    qa.question_summary,
    qa.question_keywords,
    answerText,
    qa.answer_category || '',
    groupName,
    issueId,
    JSON.stringify(msgIds),
    closeTs,
    calcConfidence(1)
  );
  console.log(`[knowledge] ✨ 新增QA #${result.lastInsertRowid}: ${qa.question_type} — ${qa.question_summary}`);
  return result.lastInsertRowid;
}

// ─── 设备知识图谱 ─────────────────────────────────────────────────
let _deviceTableReady = true;
function ensureDeviceTable() {
  if (!_deviceTableReady) return false;
  try {
    analyticsDb.prepare('SELECT COUNT(*) FROM device_knowledge_graph LIMIT 1').get();
    // 补齐可能缺失的 source_issue_id 列（旧表兼容）
    try { analyticsDb.prepare('ALTER TABLE device_knowledge_graph ADD COLUMN source_issue_id INTEGER').run(); } catch (_) {}
    return true;
  } catch (_) {
    _deviceTableReady = false;
    return false;
  }
}

function isDeviceAlreadyExtracted(issueId) {
  if (!ensureDeviceTable()) return false;
  const row = analyticsDb
    .prepare('SELECT id FROM device_knowledge_graph WHERE source_issue_id = ? LIMIT 1')
    .get(issueId);
  return !!row;
}

function isDeviceMsgSetExtracted(msgIds) {
  if (!ensureDeviceTable()) return false;
  const idStr = JSON.stringify(msgIds);
  const row = analyticsDb
    .prepare('SELECT id FROM device_knowledge_graph WHERE source_msg_ids = ? LIMIT 1')
    .get(idStr);
  return !!row;
}

function findSimilarDeviceKnowledge(deviceModel, faultSymptom, faultCategory, groupName) {
  if (!ensureDeviceTable()) return null;
  // 同群 + 同型号首先匹配
  if (groupName) {
    const sameGroup = analyticsDb.prepare(`
      SELECT id, device_model, fault_symptom, frequency, solution_steps
      FROM device_knowledge_graph
      WHERE device_model = ? AND source_group_name = ? AND fault_category = ?
      ORDER BY frequency DESC LIMIT 1
    `).get(deviceModel, groupName, faultCategory);
    if (sameGroup) return sameGroup;
  }
  // 全局型号+分类匹配（低阈值）
  const candidates = analyticsDb.prepare(`
    SELECT id, device_model, fault_symptom, frequency, solution_steps
    FROM device_knowledge_graph
    WHERE device_model = ? AND fault_category = ?
    ORDER BY frequency DESC
  `).all(deviceModel, faultCategory);

  if (candidates.length === 0) return null;

  const inputWords = new Set(faultSymptom.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  for (const c of candidates) {
    const existWords = new Set((c.fault_symptom || '').toLowerCase().split(/\s+/).filter(w => w.length > 1));
    if (existWords.size === 0) continue;
    let intersect = 0;
    for (const w of inputWords) { if (existWords.has(w)) intersect++; }
    const union = new Set([...inputWords, ...existWords]).size;
    if (intersect / union >= 0.3) return c;
  }
  return null;
}

function saveDeviceKnowledge(dk, sector, groupName, issueId, msgIds, closeTs) {
  if (!ensureDeviceTable()) { console.warn('[knowledge] device_knowledge_graph 表不存在，跳过设备知识存储'); return null; }

  const solutionText = Array.isArray(dk.solution_steps)
    ? dk.solution_steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : String(dk.solution_steps || '');

  const similar = findSimilarDeviceKnowledge(dk.device_model, dk.fault_symptom, dk.fault_category, groupName);

  if (similar) {
    const newFreq = similar.frequency + 1;
    analyticsDb.prepare(`
      UPDATE device_knowledge_graph
      SET frequency = frequency + 1,
          solution_effectiveness = solution_effectiveness + 1,
          last_seen_at = ?
      WHERE id = ?
    `).run(closeTs, similar.id);
    console.log(`[knowledge] 🔧 更新设备知识 #${similar.id}（频次→${newFreq}）: ${dk.device_model} — ${dk.fault_symptom}`);
    return similar.id;
  }

  const result = analyticsDb.prepare(`
    INSERT INTO device_knowledge_graph
      (device_model, device_type, fault_symptom, fault_category,
       solution_steps, solution_effectiveness, source_group_name,
       source_msg_ids, source_issue_id, frequency, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?)
  `).run(
    dk.device_model, dk.device_type, dk.fault_symptom, dk.fault_category,
    solutionText, groupName, JSON.stringify(msgIds), issueId, closeTs
  );
  console.log(`[knowledge] 🔧 新增设备知识 #${result.lastInsertRowid}: ${dk.device_model} — ${dk.fault_symptom}`);
  return result.lastInsertRowid;
}

async function extractAndSaveDeviceKnowledge(issue, conversationMsgs) {
  if (conversationMsgs.length < 3) return null;

  const displayName = `${issue.region || '未知'}-${issue.group_name}`;
  try {
    const dk = await aiClient.analyzeDeviceKnowledge(displayName, conversationMsgs);
    if (!dk || !dk.device_model || !dk.fault_symptom || dk.solution_steps.length === 0) {
      console.log(`[knowledge] 🔧 跳过 #${issue.id}（AI未提取到有效设备知识）`);
      return null;
    }
    const msgIds = conversationMsgs.map(m => m.timestamp);
    return saveDeviceKnowledge(dk, issue.business_sector || '设备供应商', issue.group_name, issue.id, msgIds, issue.closed_at);
  } catch (err) {
    console.error(`[knowledge] 设备知识提取 #${issue.id} 失败:`, err.message);
    return null;
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────
async function processNewlyClosedIssues() {
  const cursor = getLastProcessed();

  const newlyClosed = analyticsDb.prepare(`
    SELECT ir.id, ir.alert_id, ir.group_name, ir.group_id, ir.region,
           ir.business_sector, ir.issue_type, ir.opened_at, ir.closed_at,
           ir.commitment_text, ir.closed_by,
           ar.source_msg_ids as alert_msg_ids
    FROM issue_records ir
    LEFT JOIN alert_records ar ON ir.alert_id = ar.id
    WHERE ir.status = 'closed'
      AND (
        ir.closed_at > ?
        OR (ir.closed_at = ? AND ir.id > ?)
      )
      AND ir.closed_at IS NOT NULL
    ORDER BY ir.closed_at ASC, ir.id ASC
    LIMIT 20
  `).all(cursor.last_ts, cursor.last_ts, cursor.last_msg_id);

  if (newlyClosed.length === 0) return;

  for (const issue of newlyClosed) {
    if (isAlreadyExtracted(issue.id)) {
      // 更新游标跳过已处理的
      if (issue.closed_at > cursor.last_ts || (issue.closed_at === cursor.last_ts && issue.id > cursor.last_msg_id)) {
        cursor.last_msg_id = issue.id;
        cursor.last_ts = issue.closed_at;
        updateCursor(cursor.last_msg_id, cursor.last_ts);
      }
      continue;
    }

    const sector = issue.business_sector || '未分类';

    // 获取对话窗口
    const conversationMsgs = getConversationWindow(
      issue.group_id, issue.group_name,
      issue.opened_at, issue.closed_at
    );

    if (conversationMsgs.length < 2) {
      // 对话太少，不适合提取QA
      console.log(`[knowledge] ⏭️ 跳过 #${issue.id}（对话不足2条）`);
      if (issue.closed_at > cursor.last_ts || (issue.closed_at === cursor.last_ts && issue.id > cursor.last_msg_id)) {
        cursor.last_msg_id = issue.id;
        cursor.last_ts = issue.closed_at;
        updateCursor(cursor.last_msg_id, cursor.last_ts);
      }
      continue;
    }

    const msgIds = conversationMsgs.map(m => m.timestamp);
    const displayName = `${issue.region || '未知'}-${issue.group_name}`;
    const resolutionSummary = issue.closed_by
      ? `由 ${issue.closed_by} 确认闭环` + (issue.commitment_text ? `，供应商曾承诺：${issue.commitment_text.slice(0, 50)}` : '')
      : '系统检测到闭环信号';

    try {
      const qa = await aiClient.analyzeIssueToQA(displayName, sector, conversationMsgs, resolutionSummary);
      if (qa && qa.question_type && qa.answer_steps.length > 0) {
        saveQA(qa, sector, issue.group_name, issue.id, msgIds, issue.closed_at);
      } else {
        console.log(`[knowledge] ⏭️ 跳过 #${issue.id}（AI未提取到有效QA）`);
      }

      // 设备供应商板块额外提取设备知识图谱（issue级别 + 消息集级别双重去重）
      if (sector === '设备供应商' && !isDeviceAlreadyExtracted(issue.id) && !isDeviceMsgSetExtracted(msgIds)) {
        await extractAndSaveDeviceKnowledge(issue, conversationMsgs);
      }
    } catch (err) {
      console.error(`[knowledge] 处理 #${issue.id} 失败:`, err.message);
    }

    if (issue.closed_at > cursor.last_ts || (issue.closed_at === cursor.last_ts && issue.id > cursor.last_msg_id)) {
      cursor.last_msg_id = issue.id;
      cursor.last_ts = issue.closed_at;
      updateCursor(cursor.last_msg_id, cursor.last_ts);
    }
  }
}

// ─── 启动轮询 ────────────────────────────────────────────────────
const SCAN_INTERVAL = 60 * 1000; // 每分钟扫描一次

async function tick() {
  try {
    await processNewlyClosedIssues();
  } catch (err) {
    console.error('[knowledge-extractor] tick 出错:', err.message);
  }
  setTimeout(tick, SCAN_INTERVAL);
}

module.exports = {
  processNewlyClosedIssues,
};

if (require.main === module) {
  console.log('[knowledge-extractor] 启动，每60秒扫描新闭环问题');
  tick();

  // 支持手动触发 --now
  if (process.argv.includes('--now')) {
    console.log('[knowledge-extractor] 手动触发一次全量提取...');
    processNewlyClosedIssues().then(() => {
      console.log('[knowledge-extractor] 手动提取完成');
      process.exit(0);
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }

  process.on('SIGINT', () => {
      console.log('[knowledge-extractor] SIGINT 收到，正在优雅关闭...');
      try { sourceDb.close(); } catch (_) {}
      try { analyticsDb.close(); } catch (_) {}
      process.exit(0);
  });
}
