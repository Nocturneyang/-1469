/**
 * analyzers/issue-lifecycle-tracker.js
 * 问题生命周期追踪器 — 阶段A核心模块
 *
 * 职责：
 *   1. 每30秒扫描 analytics.sqlite 中 status='open' 的 issue_records
 *   2. 读取 database.sqlite 中同群后续消息，检测闭环词 → 关闭 issue
 *   3. 超时30分钟仍 open → 推送「问题未解决提醒」
 *   4. 超时2小时仍 open → 升级推送，标记 status='escalated'
 *   5. 检测承诺到期且无闭环词 → 推送「承诺未兑现」提醒
 *
 * 关键约束：
 *   - database.sqlite 只读
 *   - 仅写 analytics.sqlite 的 issue_records
 */

'use strict';

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');

// ─── 数据库连接 ──────────────────────────────────────────────────
const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

// ─── 闭环词 ──────────────────────────────────────────────────────
const CLOSE_PATTERNS = [
  /\b(?:resolved|fixed|back\s+to\s+normal|working\s+now|recovered|all\s+good|done)\b/i,
  /\b(?:updated|back\s+up|issue\s+(?:is\s+)?(?:fixed|resolved|closed))\b/i,
  /\bit'?s?\s+(?:working|back|fixed|resolved)\b/i,
  /\bgood\s+(?:now|to\s+go)\b/i,
];

function matchClose(content) {
  if (!content) return null;
  for (const p of CLOSE_PATTERNS) {
    const m = content.match(p);
    if (m) return m[0];
  }
  return null;
}

// ─── 超时阈值 ────────────────────────────────────────────────────
const WARN_MS = 30 * 60 * 1000;         // 30分钟 → 提醒
const ESCALATE_MS = 2 * 60 * 60 * 1000; // 2小时  → 升级
const SCAN_INTERVAL = 30 * 1000;         // 30秒扫一次

// ─── 语句预编译 ───────────────────────────────────────────────────
const selectOpenIssues = analyticsDb.prepare(`
  SELECT id, alert_id, group_name, group_id, region, issue_type,
         status, opened_at, commitment_text, commitment_due,
         escalation_count, last_escalated_at
  FROM issue_records
  WHERE status IN ('open', 'escalated')
  ORDER BY opened_at ASC
`);

const closeIssue = analyticsDb.prepare(`
  UPDATE issue_records
  SET status = 'closed',
      closed_at = ?,
      duration_mins = ?,
      closed_by = ?
  WHERE id = ?
`);

const escalateIssue = analyticsDb.prepare(`
  UPDATE issue_records
  SET status = 'escalated',
      escalation_count = escalation_count + 1,
      last_escalated_at = ?
  WHERE id = ?
`);

const markCommitmentUnmet = analyticsDb.prepare(`
  UPDATE issue_records
  SET commitment_met = 0
  WHERE id = ?
`);

// ─── 主扫描函数 ──────────────────────────────────────────────────
async function scanIssues() {
  const openIssues = selectOpenIssues.all();
  if (openIssues.length === 0) return;

  const now = Date.now();

  for (const issue of openIssues) {
    const elapsedMs = now - issue.opened_at;

    // ── 1. 检查同群后续消息是否有闭环词 ──
    const afterMsgs = sourceDb.prepare(`
      SELECT id, sender_name, content, timestamp
      FROM messages
      WHERE (group_id = ? OR group_name = ?)
        AND timestamp > ?
        AND content IS NOT NULL AND content != ''
      ORDER BY timestamp ASC
      LIMIT 100
    `).all(issue.group_id || '', issue.group_name, issue.opened_at);

    let closed = false;
    for (const msg of afterMsgs) {
      const closeWord = matchClose(msg.content);
      if (closeWord) {
        const durationMins = (msg.timestamp - issue.opened_at) / 60000;
        closeIssue.run(msg.timestamp, parseFloat(durationMins.toFixed(2)), msg.sender_name, issue.id);

        // 检查承诺是否兑现
        if (issue.commitment_due) {
          const commitmentMet = msg.timestamp <= issue.commitment_due ? 1 : 0;
          analyticsDb.prepare('UPDATE issue_records SET commitment_met = ? WHERE id = ?').run(commitmentMet, issue.id);
        }

        console.log(`[lifecycle] ✅ 问题关闭：${issue.group_name} | ${issue.issue_type} | 持续${durationMins.toFixed(1)}分钟 | 闭环词："${closeWord}"`);
        closed = true;
        break;
      }
    }
    if (closed) continue;

    // ── 2. 承诺到期检查（仅标记，不推送）──
    if (issue.commitment_due && now > issue.commitment_due) {
      const dueMsCheck = analyticsDb.prepare('SELECT commitment_met FROM issue_records WHERE id = ?').get(issue.id);
      if (dueMsCheck?.commitment_met === null) {
        markCommitmentUnmet.run(issue.id);
        console.log(`[lifecycle] ⏰ 承诺未兑现（仅记录）：${issue.group_name}`);
      }
    }

    // ── 3. 超时标记（仅升级状态，不推送）──
    if (elapsedMs >= WARN_MS && issue.status === 'open' && (issue.escalation_count || 0) === 0) {
      escalateIssue.run(now, issue.id);
      console.log(`[lifecycle] ⚠️ 30分钟超时（仅标记）：${issue.group_name}`);
    }

    // ── 4. 超时2小时升级（仅标记，不推送）──
    if (elapsedMs >= ESCALATE_MS && (issue.escalation_count || 0) < 2) {
      escalateIssue.run(now, issue.id);
      console.log(`[lifecycle] 🚨 2小时升级（仅标记）：${issue.group_name}`);
    }
  }
}

// ─── 启动 ────────────────────────────────────────────────────────
async function tick() {
  try {
    await scanIssues();
  } catch (err) {
    console.error('[issue-lifecycle-tracker] tick 出错:', err.message);
  }
  setTimeout(tick, SCAN_INTERVAL);
}

console.log('[issue-lifecycle-tracker] 启动，每30秒扫描未闭环问题');
tick();

process.on('SIGINT', () => {
    console.log('[issue-lifecycle-tracker] SIGINT 收到，正在优雅关闭...');
    try { sourceDb.close(); } catch (_) {}
    try { analyticsDb.close(); } catch (_) {}
    process.exit(0);
});
