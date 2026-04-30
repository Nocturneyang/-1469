/**
 * analyzers/supplier-analyzer.js
 * 供应商告警引擎 — 阶段A核心模块
 *
 * 职责：
 *   1. 分时轮询采集库新消息（15s/30s/60s 按业务峰谷自动切换）
 *   2. P0 组合词命中 → 立即路由推送钉钉，创建 issue_records
 *   3. P1 词命中 → 5分钟窗口聚合 → AI评分 → ≥7分推送 + 创建 issue
 *   4. 无响应检测：外部问题 15分钟内 ITNIO 未回 → P2告警
 *   5. SID 变更检测 → 写入 sid_change_records + 推送通知
 *   6. 承诺提取 → 写入 issue_records.commitment_text/commitment_due
 *
 * 关键约束：
 *   - database.sqlite 只读打开
 *   - 所有写操作只写 analytics.sqlite
 *   - 每条消息只处理一次（通过 analysis_cursor 游标记录）
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const dingtalk = require('../lib/dingtalk');
const aiClient = require('../lib/ai-client');

const ROOT = path.resolve(__dirname, '..');

// ─── 数据库连接 ──────────────────────────────────────────────────
const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

// ─── 区域配置（热加载，60秒缓存）──────────────────────────────
const REGION_CONFIG_PATH = path.join(ROOT, 'config', 'account-regions.json');
let _regionMap = null;
let _regionMapLoadedAt = 0;

function getRegionMap() {
  const now = Date.now();
  if (_regionMap && now - _regionMapLoadedAt < 60 * 1000) return _regionMap;
  try {
    const cfg = JSON.parse(fs.readFileSync(REGION_CONFIG_PATH, 'utf8'));
    _regionMap = Object.fromEntries(cfg.accounts.map((a) => [a.account, a]));
    _regionMapLoadedAt = now;
  } catch (e) {
    console.error('[supplier-analyzer] 重载 account-regions.json 失败:', e.message);
    if (!_regionMap) _regionMap = {};
  }
  return _regionMap;
}

// 保持向后兼容的常量引用（实际通过 getRegionMap() 获取最新值）
const REGION_MAP = new Proxy({}, { get: (_, k) => getRegionMap()[k] });

// ─── 关键词规则库（基于实测数据）────────────────────────────────

// 🔴 P0：组合词，极低误报，直接触发
const P0_PATTERNS = [
  /send\s+failed/i,
  /0%\s+deliver(?:y|ed)/i,
  /0%\s+success/i,
  /not\s+working/i,
  /bind\s+is\s+down/i,
  /route\s+down/i,
  /service\s+down/i,
  /completely\s+down/i,
  /failed\s+to\s+deliver/i,
  /delivery\s+rate\s+(?:is\s+)?0%/i,
];

// 🟠 P1：单词，需5分钟聚合+AI判断
const P1_KEYWORDS = [
  'down', 'fail', 'failed', 'failure', 'error', 'issue',
  'offline', 'blocked', 'suspended', 'rejected', 'undelivered',
  'timeout', 'disconnected', 'pending', 'not receiving',
];

// ✅ 闭环词（用于 issue-lifecycle-tracker，此处仅用于SID检测）
const CLOSE_PATTERNS = [
  /\b(?:resolved|fixed|back\s+to\s+normal|working\s+now|recovered|all\s+good|done|updated|back\s+up)\b/i,
];

// 🔧 SID 变更检测
const SID_PATTERN = /\bSID\s+\d{4,}/gi;
const SID_BATCH_THRESHOLD = 3; // 3个以上SID条目认为是批量更新

// 📝 承诺词
const COMMITMENT_PATTERNS = [
  /will\s+(?:fix|update|route|check|resolve|get\s+back)\s*(?:in|by|within|shortly)?/i,
  /(?:give|update)\s+(?:you|us)\s+(?:in\s+)?\d+\s*(?:min|mins|hour|hr|hours)/i,
  /by\s+(?:eod|end\s+of\s+day|tonight|tomorrow)/i,
  /checking\s+now[,.]?\s+will\s+update/i,
  /will\s+get\s+back\s+(?:to\s+you)?/i,
];

// 👥 内部账号识别
const { isInternalStaff } = require('../lib/staff-detector');

// ─── 关键词匹配 ──────────────────────────────────────────────────
function matchP0(content) {
  if (!content) return null;
  for (const pattern of P0_PATTERNS) {
    const m = content.match(pattern);
    if (m) return m[0];
  }
  return null;
}

function matchP1Keywords(content) {
  if (!content) return [];
  const lower = content.toLowerCase();
  return P1_KEYWORDS.filter((kw) => lower.includes(kw));
}

function extractCommitment(content) {
  if (!content) return null;
  for (const pattern of COMMITMENT_PATTERNS) {
    if (pattern.test(content)) return content.slice(0, 200);
  }
  return null;
}

function parseCommitmentDeadline(content) {
  if (!content) return null;
  const minMatch = content.match(/(\d+)\s*min(?:ute)?s?/i);
  if (minMatch) return Date.now() + parseInt(minMatch[1]) * 60 * 1000;
  const hrMatch = content.match(/(\d+)\s*h(?:ou)?r?s?/i);
  if (hrMatch) return Date.now() + parseInt(hrMatch[1]) * 60 * 60 * 1000;
  if (/eod|end\s+of\s+day/i.test(content)) {
    const eod = new Date();
    eod.setHours(18, 0, 0, 0);
    return eod.getTime();
  }
  return null;
}

function detectSidChange(content) {
  if (!content) return [];
  const matches = content.match(SID_PATTERN) || [];
  return [...new Set(matches)];
}

// ─── 游标管理 ────────────────────────────────────────────────────
const ANALYZER_NAME = 'supplier-analyzer';

function getLastProcessed() {
  const row = analyticsDb
    .prepare('SELECT last_msg_id, last_ts FROM analysis_cursor WHERE analyzer = ?')
    .get(ANALYZER_NAME);
  return row || { last_msg_id: 0, last_ts: 0 };
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

// ─── 告警记录写入 ─────────────────────────────────────────────────
const insertAlert = analyticsDb.prepare(`
  INSERT INTO alert_records
    (source_msg_ids, group_name, group_id, region, receiver_account,
     alert_level, trigger_type, trigger_keywords, ai_score, ai_title,
     ai_type, ai_action, ai_commitment, is_pushed, push_channel)
  VALUES
    (@source_msg_ids, @group_name, @group_id, @region, @receiver_account,
     @alert_level, @trigger_type, @trigger_keywords, @ai_score, @ai_title,
     @ai_type, @ai_action, @ai_commitment, @is_pushed, @push_channel)
`);

// P0 去重：检查某条消息 ID 是否已经触发过告警
const checkMsgAlerted = analyticsDb.prepare(`
  SELECT id FROM alert_records
  WHERE alert_level = 'p0' AND source_msg_ids LIKE ?
  LIMIT 1
`);

const insertIssue = analyticsDb.prepare(`
  INSERT INTO issue_records
    (alert_id, group_name, group_id, region, issue_type, status,
     opened_at, commitment_text, commitment_due, recurrence_count)
  VALUES
    (@alert_id, @group_name, @group_id, @region, @issue_type, 'open',
     @opened_at, @commitment_text, @commitment_due, @recurrence_count)
`);

function getRecurrenceCount(groupName, issueType) {
  const row = analyticsDb
    .prepare('SELECT COUNT(*) AS cnt FROM issue_records WHERE group_name = ? AND issue_type = ?')
    .get(groupName, issueType);
  return (row?.cnt || 0) + 1;
}

// ─── 区域路由 ────────────────────────────────────────────────────
function getRegionInfo(receiverAccount) {
  return REGION_MAP[`wa-${receiverAccount}`] ||
         REGION_MAP[`tg-${receiverAccount}`] ||
         REGION_MAP[receiverAccount] ||
         { region: '未知区', owner: null, owner_dingtalk_id: '', platform: 'wa' };
}

// ─── 告警消息格式化 ───────────────────────────────────────────────
function buildP0AlertContent(msg, keyword, regionInfo) {
  const dt = new Date(msg.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return [
    `### 🔴 [P0告警] ${regionInfo.region} | ${msg.group_name}`,
    '',
    `- **触发词：** \`${keyword}\``,
    `- **发言人：** ${msg.sender_name}`,
    `- **内容：** ${msg.content.slice(0, 200)}`,
    `- **时间：** ${dt}`,
    '',
    `> 请 ${regionInfo.owner || '运营'} 立即确认通道状态`,
  ].join('\n');
}

function buildP1AlertContent(groupName, regionInfo, aiResult, msgCount) {
  const lines = [
    `### 🟠 [P1聚合告警] ${regionInfo.region} | ${groupName}`,
    '',
    `- **AI评分：** ${aiResult.score}/10`,
    `- **告警摘要：** ${aiResult.title}`,
    `- **问题类型：** ${aiResult.type}`,
    `- **聚合消息数：** ${msgCount} 条`,
  ];
  if (aiResult.commitment) {
    lines.push(`- **供应商承诺：** "${aiResult.commitment}"`);
  }
  if (aiResult.action) {
    lines.push(`- **建议操作：** ${aiResult.action}`);
  }
  return lines.join('\n');
}

function buildNoResponseContent(msg, regionInfo, minutesElapsed) {
  const dt = new Date(msg.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return [
    `### 🟡 [P2无响应告警] ${regionInfo.region} | ${msg.group_name}`,
    '',
    `- **外部发言人：** ${msg.sender_name}`,
    `- **发问时间：** ${dt}`,
    `- **已等待：** ${minutesElapsed} 分钟`,
    `- **内容片段：** ${msg.content.slice(0, 150)}`,
    '',
    `> ITNIO 运营尚未回复，请关注。`,
  ].join('\n');
}

// ─── P1 窗口分组 ─────────────────────────────────────────────────
// 内存缓存：{ groupId: [{ msg, keywords, ts }] }
const p1Windows = new Map();
const WINDOW_MS = 5 * 60 * 1000;

function flushExpiredWindows() {
  const now = Date.now();
  for (const [key, items] of p1Windows) {
    if (items.length > 0 && now - items[0].ts > WINDOW_MS * 2) {
      p1Windows.delete(key);
    }
  }
}

// ─── 无响应检测状态 ──────────────────────────────────────────────
// { groupId: { firstExternalTs, alerted } }
const noResponseState = new Map();
const NO_RESPONSE_MS = 15 * 60 * 1000;

// ─── 主处理函数 ───────────────────────────────────────────────────
async function processNewMessages() {
  const cursor = getLastProcessed();

  const newMsgs = sourceDb
    .prepare(`
      SELECT id, platform, message_id, group_id, group_name,
             sender_id, sender_name, content, has_media,
             receiver_account, timestamp
      FROM messages
      WHERE id > ?
        AND content IS NOT NULL AND content != ''
      ORDER BY id ASC
      LIMIT 500
    `)
    .all(cursor.last_msg_id);

  if (newMsgs.length === 0) return;

  const externalMsgs = newMsgs.filter((m) => !isInternalStaff(m.sender_name));
  const internalMsgs = newMsgs.filter((m) => isInternalStaff(m.sender_name));

  // ── Step 1: P0 直接推送 ──
  for (const msg of externalMsgs) {
    const keyword = matchP0(msg.content);
    if (!keyword) continue;

    // 去重：同一条消息已触发过 P0 告警则跳过
    const alreadyAlerted = checkMsgAlerted.get(`%${msg.id}%`);
    if (alreadyAlerted) continue;

    const regionInfo = getRegionInfo(msg.receiver_account);
    const commitment = extractCommitment(msg.content);

    // 写告警记录
    const alertInfo = insertAlert.run({
      source_msg_ids: JSON.stringify([msg.id]),
      group_name: msg.group_name,
      group_id: msg.group_id,
      region: regionInfo.region,
      receiver_account: msg.receiver_account,
      alert_level: 'p0',
      trigger_type: 'keyword',
      trigger_keywords: keyword,
      ai_score: null,
      ai_title: `P0告警：${keyword}`,
      ai_type: '通道故障',
      ai_action: null,
      ai_commitment: commitment,
      is_pushed: 0,
      push_channel: 'dingtalk_alert',
    });

    const recurrence = getRecurrenceCount(msg.group_name, '通道故障');
    insertIssue.run({
      alert_id: alertInfo.lastInsertRowid,
      group_name: msg.group_name,
      group_id: msg.group_id,
      region: regionInfo.region,
      issue_type: '通道故障',
      opened_at: msg.timestamp,
      commitment_text: commitment,
      commitment_due: commitment ? parseCommitmentDeadline(commitment) : null,
      recurrence_count: recurrence,
    });

    // 推送
    const content = buildP0AlertContent(msg, keyword, regionInfo);
    await dingtalk.sendAlert({ title: `🔴 P0告警 ${regionInfo.region}-${msg.group_name}`, content, platform: regionInfo.platform, region: regionInfo.region, alertType: 'P0' });

    // 标记已推送
    analyticsDb
      .prepare('UPDATE alert_records SET is_pushed = 1 WHERE id = ?')
      .run(alertInfo.lastInsertRowid);

    console.log(`[P0] ${regionInfo.region}-${msg.group_name} | ${keyword}`);
  }

  // ── Step 2: P1 窗口聚合 ──
  for (const msg of externalMsgs) {
    const kws = matchP1Keywords(msg.content);
    if (kws.length === 0) continue;

    const key = msg.group_id || msg.group_name;
    if (!p1Windows.has(key)) p1Windows.set(key, []);
    p1Windows.get(key).push({ msg, keywords: kws, ts: Date.now() });
  }

  // 检查超过5分钟的窗口，进行AI分析
  const now = Date.now();
  for (const [key, items] of p1Windows) {
    if (items.length === 0) continue;
    const windowAge = now - items[0].ts;
    if (windowAge < WINDOW_MS) continue; // 窗口还未到期

    const msgs = items.map((i) => i.msg);
    p1Windows.delete(key);

    if (msgs.length === 0) continue;

    const firstMsg = msgs[0];
    const regionInfo = getRegionInfo(firstMsg.receiver_account);
    const displayName = `${regionInfo.region}-${firstMsg.group_name}`;
    const senderNames = [...new Set(msgs.map((m) => m.sender_name))];

    // 确定群类型
    const groupType = detectGroupType(firstMsg.group_name);
    const aiResult = await aiClient.analyzeAlertMessages(displayName, groupType, msgs, senderNames);

    const finalScore = aiResult?.score ?? 6; // 降级时默认6
    if (finalScore < 7) continue;

    const commitment = aiResult?.commitment || msgs.map((m) => extractCommitment(m.content)).find(Boolean) || null;
    const issueType = aiResult?.type || 'P1告警';

    const alertInfo = insertAlert.run({
      source_msg_ids: JSON.stringify(msgs.map((m) => m.id)),
      group_name: firstMsg.group_name,
      group_id: firstMsg.group_id,
      region: regionInfo.region,
      receiver_account: firstMsg.receiver_account,
      alert_level: 'p1',
      trigger_type: aiResult ? 'ai' : 'keyword',
      trigger_keywords: items.flatMap((i) => i.keywords).join(','),
      ai_score: aiResult?.score ?? null,
      ai_title: aiResult?.title ?? 'P1聚合告警',
      ai_type: issueType,
      ai_action: aiResult?.action ?? null,
      ai_commitment: commitment,
      is_pushed: 0,
      push_channel: 'dingtalk_alert',
    });

    const recurrence = getRecurrenceCount(firstMsg.group_name, issueType);
    insertIssue.run({
      alert_id: alertInfo.lastInsertRowid,
      group_name: firstMsg.group_name,
      group_id: firstMsg.group_id,
      region: regionInfo.region,
      issue_type: issueType,
      opened_at: firstMsg.timestamp,
      commitment_text: commitment,
      commitment_due: commitment ? parseCommitmentDeadline(commitment) : null,
      recurrence_count: recurrence,
    });

    const content = buildP1AlertContent(firstMsg.group_name, regionInfo, aiResult || { score: finalScore, title: 'P1聚合告警', type: issueType, commitment, action: null }, msgs.length);
    await dingtalk.sendAlert({ title: `🟠 P1告警 ${displayName}`, content, platform: regionInfo.platform, region: regionInfo.region, alertType: 'P1' });
    analyticsDb.prepare('UPDATE alert_records SET is_pushed = 1 WHERE id = ?').run(alertInfo.lastInsertRowid);
    console.log(`[P1] ${displayName} | score=${finalScore} | ${msgs.length}条消息`);
  }

  // ── Step 3: 无响应检测 ──
  for (const msg of externalMsgs) {
    const key = msg.group_id || msg.group_name;
    if (!noResponseState.has(key)) {
      noResponseState.set(key, { firstExternalTs: now, firstMsg: msg, alerted: false });
    }
  }

  for (const msg of internalMsgs) {
    const key = msg.group_id || msg.group_name;
    if (noResponseState.has(key)) {
      noResponseState.delete(key); // ITNIO 已回复，清除状态
    }
  }

  for (const [key, state] of noResponseState) {
    if (state.alerted) continue;
    const elapsed = now - state.firstExternalTs;
    if (elapsed >= NO_RESPONSE_MS) {
      const msg = state.firstMsg;
      const regionInfo = getRegionInfo(msg.receiver_account);
      const minutesElapsed = Math.round(elapsed / 60000);
      const content = buildNoResponseContent(msg, regionInfo, minutesElapsed);
      await dingtalk.sendAlert({ title: `🟡 无响应告警 ${regionInfo.region}-${msg.group_name}`, content, platform: regionInfo.platform, region: regionInfo.region, alertType: 'P2' });
      state.alerted = true;
      console.log(`[P2-NoResponse] ${regionInfo.region}-${msg.group_name} | ${minutesElapsed}分钟未回复`);
    }
  }

  // ── Step 4: SID 变更检测 ──
  for (const msg of newMsgs) {
    const sids = detectSidChange(msg.content);
    if (sids.length < SID_BATCH_THRESHOLD) continue;

    const regionInfo = getRegionInfo(msg.receiver_account);
    analyticsDb.prepare(`
      INSERT INTO sid_change_records (group_name, group_id, region, sender_name, sid_list, raw_content, source_msg_id, is_pushed)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(msg.group_name, msg.group_id, regionInfo.region, msg.sender_name, JSON.stringify(sids), msg.content.slice(0, 500), msg.id);

    await dingtalk.sendSidChangeAlert({
      groupName: msg.group_name,
      region: regionInfo.region,
      senderName: msg.sender_name,
      sidList: sids,
      platform: regionInfo.platform,
      alertType: 'SID'
    });

    analyticsDb.prepare('UPDATE sid_change_records SET is_pushed = 1 WHERE source_msg_id = ?').run(msg.id);
    console.log(`[SID] ${regionInfo.region}-${msg.group_name} | ${sids.length}个SID变更`);
  }

  // ── 更新游标 ──
  const maxId = Math.max(...newMsgs.map((m) => m.id));
  const maxTs = Math.max(...newMsgs.map((m) => m.timestamp));
  updateCursor(maxId, maxTs);

  flushExpiredWindows();
}

function detectGroupType(groupName) {
  if (!groupName) return 'C';
  const lower = groupName.toLowerCase();
  if (/mbb|itnio.*mbb|mcm/i.test(lower)) return 'A';
  if (/agil|gazeti|chinasky|content/i.test(lower)) return 'B';
  return 'C';
}

// ─── 分时轮询调度 ─────────────────────────────────────────────────
function getPollingInterval() {
  const hour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false });
  const h = parseInt(hour, 10);
  if (h >= 14 && h < 20) return 15 * 1000; // 高峰：15秒
  if (h >= 6 && h < 9) return 60 * 1000;   // 低谷：60秒
  return 30 * 1000;                          // 默认：30秒
}

async function tick() {
  try {
    await processNewMessages();
  } catch (err) {
    console.error('[supplier-analyzer] tick 出错:', err.message);
  }
  setTimeout(tick, getPollingInterval());
}

// ─── 启动 ────────────────────────────────────────────────────────
console.log('[supplier-analyzer] 启动，分时轮询：高峰15s / 普通30s / 低谷60s');
tick();
