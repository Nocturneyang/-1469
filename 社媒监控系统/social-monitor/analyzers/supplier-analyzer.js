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
const { getRegionInfo, getValueLabel } = require('../lib/region-config');

// 向后兼容别名
const getRegionLabel = getRegionInfo;

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');

// ─── 数据库连接 ──────────────────────────────────────────────────
const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

// 区域配置由 lib/region-config.js 统一管理

// ─── 关键词规则库（基于实测数据）────────────────────────────────

// 🔴 P0：组合词，极低误报，直接触发
// 通用 P0（所有板块适用）
const P0_COMMON = [
  /send\s+failed/i,
  /0%\s+deliver(?:y|ed)/i,
  /0%\s+success/i,
  /not\s+working/i,
  /bind\s+is\s+down/i,
  /service\s+down/i,
  /completely\s+down/i,
  /failed\s+to\s+deliver/i,
  /delivery\s+rate\s+(?:is\s+)?0%/i,
];

// 按板块专属 P0 规则
const P0_BY_SECTOR = {
  '设备供应商': [
    /(?:device|goip|modem|gateway).*completely\s+down/i,
    /all\s+ports?\s+(?:down|not\s+working|failed)/i,
    /IMEI\s+(?:changed|unknown|blocked)/i,
  ],
  '直连供应商': [
    /0%\s+(?:delivery|success|click)/i,
    /route\s+(?:completely\s+)?(?:down|blocked|suspended)/i,
    /all\s+(?:SMS|messages?)\s+(?:blocked|failed|rejected)/i,
  ],
  '语音直连供应商': [
    /\b503\b.*(?:error|code|SIP)/i,
    /ASR\s+(?:drop|down|zero|0%|below)/i,
    /SIP\s+trunk\s+(?:down|unreachable|failed)/i,
  ],
  '客服': [
    /all\s+OTP.*(?:not\s+received?|failed|undelivered)/i,
    /(?:operator|carrier|telco).*(?:blocked|banned|suspended)/i,
    /(?:multiple|many|several|3\+?)\s+(?:numbers?|users?|players?).*(?:not\s+receiv|can'?t\s+receiv)/i,
    /template\s+(?:rejected|blocked|banned|not\s+approved)/i,
    /channel\s+(?:completely\s+)?(?:down|not\s+working|stopped)/i,
    /content\s+(?:blocked|flagged|rejected)\s+by\s+(?:operator|carrier)/i,
  ],
  '卡线': [
    /all\s+ports?\s+(?:down|not\s+working|failed)/i,
  ],
};

// 🟠 P1：单词，需5分钟聚合+AI判断
const P1_KEYWORDS = [
  'down', 'fail', 'failed', 'failure', 'error', 'issue',
  'offline', 'blocked', 'suspended', 'rejected', 'undelivered',
  'timeout', 'disconnected', 'pending', 'not receiving',
];

// 按板块专属 P1 关键词（在通用 P1 基础上叠加）
const P1_BY_SECTOR = {
  '设备供应商': ['disconnect', 'not responding', 'can\'t access', 'no signal', 'no network', 'stuck', 'freeze', '无法连接', '不工作', '打不开'],
  '直连供应商': ['smsfw', 'spam filter', 'content blocked', 'DLR delay', 'low click', 'quality degrade', 'queue'],
  '语音直连供应商': ['503', '486', '408', 'call failure', 'SBC', 'invite failed', 'no ring', 'one-way audio', 'concurrent exceeded'],
  '客服': ['not receive', 'didn\'t receive', 'not delivered', 'template rejected', 'link blocked', 'channel down', 'did not receive', 'haven\'t received', 'still waiting'],
  '卡线': [],
};

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
function matchP0(content, sector) {
  if (!content) return null;
  // 通用 P0（所有板块）
  for (const pattern of P0_COMMON) {
    const m = content.match(pattern);
    if (m) return m[0];
  }
  // 板块专属 P0
  const sectorPatterns = P0_BY_SECTOR[sector];
  if (sectorPatterns) {
    for (const pattern of sectorPatterns) {
      const m = content.match(pattern);
      if (m) return m[0];
    }
  }
  return null;
}

function matchP1Keywords(content, sector) {
  if (!content) return [];
  const lower = content.toLowerCase();
  const hits = P1_KEYWORDS.filter((kw) => lower.includes(kw));
  // 叠加板块专属 P1 关键词
  if (sector && P1_BY_SECTOR[sector]) {
    for (const kw of P1_BY_SECTOR[sector]) {
      if (lower.includes(kw.toLowerCase()) && !hits.includes(kw)) {
        hits.push(kw);
      }
    }
  }
  return hits;
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
    (source_msg_ids, group_name, group_id, region, business_sector, receiver_account,
     alert_level, trigger_type, trigger_keywords, ai_score, ai_title,
     ai_type, ai_action, ai_commitment, is_pushed, push_channel)
  VALUES
    (@source_msg_ids, @group_name, @group_id, @region, @business_sector, @receiver_account,
     @alert_level, @trigger_type, @trigger_keywords, @ai_score, @ai_title,
     @ai_type, @ai_action, @ai_commitment, @is_pushed, @push_channel)
`);

// P0 去重：检查某条消息 ID 是否已经触发过告警
const checkMsgAlerted = analyticsDb.prepare(`
  SELECT id FROM alert_records
  WHERE alert_level = 'p0' AND source_msg_ids LIKE ?
  LIMIT 1
`);

// 同群同级别时间窗口去重：30分钟内不重复推送
const DEDUP_WINDOW_MS = 30 * 60 * 1000;
const checkRecentAlert = analyticsDb.prepare(`
  SELECT id, source_msg_ids FROM alert_records
  WHERE group_name = ? AND alert_level = ?
    AND created_at > datetime('now', '+8 hours', '-30 minutes')
  ORDER BY created_at DESC LIMIT 1
`);

const markAlertPushed = analyticsDb.prepare('UPDATE alert_records SET is_pushed = 1 WHERE id = ?');
const markSidPushed = analyticsDb.prepare('UPDATE sid_change_records SET is_pushed = 1 WHERE source_msg_id = ?');

const insertIssue = analyticsDb.prepare(`
  INSERT INTO issue_records
    (alert_id, group_name, group_id, region, business_sector, issue_type, status,
     opened_at, commitment_text, commitment_due, recurrence_count)
  VALUES
    (@alert_id, @group_name, @group_id, @region, @business_sector, @issue_type, 'open',
     @opened_at, @commitment_text, @commitment_due, @recurrence_count)
`);

function getRecurrenceCount(groupName, issueType) {
  const row = analyticsDb
    .prepare('SELECT COUNT(*) AS cnt FROM issue_records WHERE group_name = ? AND issue_type = ?')
    .get(groupName, issueType);
  return (row?.cnt || 0) + 1;
}

function mergeMsgIds(existingJson, incomingIds) {
  let existing = [];
  try {
    const parsed = JSON.parse(existingJson || '[]');
    if (Array.isArray(parsed)) existing = parsed;
  } catch (_) {}
  return JSON.stringify([...new Set([...existing, ...incomingIds])]);
}

function markAlertPushResult(alertId, sendResult, logLabel) {
  if (sendResult?.ok) {
    markAlertPushed.run(alertId);
    return true;
  }
  console.warn(`${logLabel}-PUSH-SKIPPED | ${sendResult?.reason || 'unknown'}`);
  return false;
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

function compactContent(content, max = 120) {
  const text = String(content || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '无文本内容';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatCnTime(timestamp) {
  return new Date(timestamp || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function getNoResponseMessages(state) {
  if (Array.isArray(state?.externalMsgs) && state.externalMsgs.length > 0) {
    return state.externalMsgs;
  }
  return state?.firstMsg ? [state.firstMsg] : [];
}

function buildNoResponseInsight(messages, regionInfo, minutesElapsed) {
  const joined = messages.map((m) => m.content || '').join('\n').toLowerCase();
  const sector = regionInfo.business_sector || '未分类';
  const hasIncident = /down|fail|failed|failure|error|issue|blocked|timeout|undelivered|not receiving|not receive|收不到|失败|异常|故障|拦截|延迟|不通|不可用/.test(joined);
  const hasPrice = /price|cost|quote|rate|fee|报价|价格|成本|费用|费率/.test(joined);
  const hasResource = /route|sender|sid|sim|device|goip|port|carrier|operator|线路|通道|设备|端口|运营商|资源|号码|卡/.test(joined);
  const hasUrgency = /urgent|asap|immediately|please|pls|kindly|now|催|急|紧急|马上|尽快|帮忙|麻烦/.test(joined);

  let summary = '外部已有连续消息等待我方确认，需要判断是否为资源、故障或业务需求。';
  let risk = `${sector} 对话已等待 ${minutesElapsed} 分钟，若继续沉默，可能造成客户/供应商对接中断。`;
  let action = '请区域负责人先在群内回复“已跟进/正在确认”，再补充处理结论。';

  if (hasIncident) {
    summary = '外部反馈疑似故障、失败、延迟或不可用问题，尚未看到我方接手。';
    risk = '可能影响发送、送达、设备可用性或客户体验，不能只按普通聊天沉默处理。';
    action = '请先确认问题范围和当前处理人；如属真实故障，升级为 P1/P0 或补建问题单。';
  } else if (hasPrice) {
    summary = '外部在询价、报价或成本变化，尚未看到我方回复。';
    risk = '可能影响资源采购、成本判断或客户报价时效。';
    action = '请确认是否需要商务/资源侧回复，并记录价格、国家、运营商和有效期。';
  } else if (hasResource) {
    summary = '外部提到线路、设备、运营商、Sender ID、SIM 或资源配置，尚未看到我方回复。';
    risk = '可能影响资源可用性、配置变更或后续排障路径。';
    action = '请确认资源对象和负责人，必要时补充到资源/设备知识库或区域情报。';
  } else if (hasUrgency) {
    summary = '外部存在催促或请求确认信号，尚未看到我方响应。';
    risk = '响应延迟本身已经成为服务风险，容易被对方感知为无人跟进。';
    action = '请先做状态回复，再判断是否需要分派到运营、技术或商务。';
  }

  return { summary, risk, action };
}

function buildNoResponseContent(state, regionInfo, minutesElapsed, insight) {
  const messages = getNoResponseMessages(state);
  const firstMsg = messages[0] || state.firstMsg;
  const lastMsg = messages[messages.length - 1] || firstMsg;
  const senders = [...new Set(messages.map((m) => m.sender_name).filter(Boolean))];
  const valueLabel = getValueLabel(firstMsg.receiver_account, firstMsg.group_name);
  const recentLines = messages.slice(-4).map((m) => {
    const t = new Date(m.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `  - ${t} ${m.sender_name || '外部'}：${compactContent(m.content, 90)}`;
  });

  return [
    `### 🟡 [P2响应缺口] ${regionInfo.region} | ${firstMsg.group_name}`,
    '',
    `- **业务上下文：** ${regionInfo.region} / ${regionInfo.business_sector || '未分类'} / ${firstMsg.receiver_account} / ${valueLabel}`,
    `- **判断口径：** 响应缺口 + 诉求/风险归因（${NO_RESPONSE_ALERT_FORMAT}）`,
    `- **等待时长：** ${minutesElapsed} 分钟（${formatCnTime(firstMsg.timestamp)} 发起，最近 ${formatCnTime(lastMsg.timestamp)}）`,
    `- **外部发言人：** ${senders.join('、') || firstMsg.sender_name || '未知'}`,
    `- **外部诉求：** ${insight.summary}`,
    `- **风险/价值：** ${insight.risk}`,
    `- **建议动作：** ${insight.action}`,
    '',
    `**最近外部消息：**`,
    ...recentLines,
    '',
    `> 这是响应缺口告警：请先在群内给出接手状态，再补处理结论。`,
  ].join('\n');
}

// ─── P1 窗口分组 ─────────────────────────────────────────────────
// 内存缓存：{ groupId: [{ msg, keywords, ts }] }
const p1Windows = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_P1_WINDOWS = 200;

function flushExpiredWindows() {
  const now = Date.now();
  for (const [key, items] of p1Windows) {
    if (items.length > 0 && now - items[0].ts > WINDOW_MS * 2) {
      p1Windows.delete(key);
    }
  }
  // LRU 淘汰：超过容量上限时删除最旧的条目
  if (p1Windows.size > MAX_P1_WINDOWS) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, items] of p1Windows) {
      if (items.length > 0 && items[0].ts < oldestTs) {
        oldestTs = items[0].ts;
        oldestKey = key;
      }
    }
    if (oldestKey) p1Windows.delete(oldestKey);
  }
}

// ─── 无响应检测状态 ──────────────────────────────────────────────
// { groupId: { firstExternalTs, firstMsg, externalMsgs, alerted } }
const noResponseState = new Map();
const NO_RESPONSE_MS = 15 * 60 * 1000;
const MAX_NO_RESPONSE_CONTEXT_MSGS = 10;
const NO_RESPONSE_ALERT_FORMAT = 'p2_response_gap_v2';

function appendNoResponseMessage(state, msg) {
  const msgs = getNoResponseMessages(state);
  if (!msgs.some((m) => m.id === msg.id)) {
    msgs.push(msg);
  }
  state.externalMsgs = msgs.length > MAX_NO_RESPONSE_CONTEXT_MSGS
    ? [msgs[0], ...msgs.slice(-(MAX_NO_RESPONSE_CONTEXT_MSGS - 1))]
    : msgs;
  state.lastExternalTs = Date.now();
}

// ─── P0 上下文窗口（查询触发消息前 15 条）───────────────────────────
const getContextWindow = sourceDb.prepare(`
  SELECT id, sender_name, content, timestamp
  FROM messages
  WHERE (group_id = ? OR group_name = ?)
    AND id < ?
    AND content IS NOT NULL AND content != ''
  ORDER BY id DESC
  LIMIT 15
`);

const p0ValidationCache = new Map(); // key: groupId, value: { ts, result }
const P0_CACHE_TTL = 2 * 60 * 1000;

function buildP0ContextPrompt(msg, keyword, contextMsgs) {
  const contextBlock = contextMsgs.map(m => {
    const t = new Date(m.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  return `你是ITNIO告警风控引擎的上下文分析器。

触发关键词："${keyword}"
触发消息：[${msg.sender_name}]: ${msg.content}

该群前15条消息（时间正序）：
---
${contextBlock}
---

请判断：
1. 这是新发生的故障报告，还是对历史问题的讨论/确认？
2. 如果是新故障，严重程度是 p0（全群/全通道故障）还是 p1（局部/单客户）？
3. 如果是对历史问题的讨论，是否表明问题已经恢复？

严格JSON输出：
{"is_genuine_alert":true/false,"reason":"一句话原因","severity":"p0"/"p1"/"false_alarm","affected_scope":"全群"/"单客户"/"未知"}`;
}

async function validateP0WithContext(msg, keyword) {
  const cacheKey = msg.group_id || msg.group_name;
  const cached = p0ValidationCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts < P0_CACHE_TTL)) {
    return cached.result;
  }

  const contextMsgs = getContextWindow.all(
    msg.group_id || '', msg.group_name, msg.id
  ).reverse(); // 转为时间正序

  if (contextMsgs.length === 0) {
    const result = { is_genuine_alert: true, reason: '无上下文，默认放行', severity: 'p0' };
    p0ValidationCache.set(cacheKey, { ts: Date.now(), result });
    return result;
  }

  const prompt = buildP0ContextPrompt(msg, keyword, contextMsgs);
  try {
    const text = await aiClient.callAI(prompt, { tier: 'fast' });
    const result = aiClient.extractJSON(text);
    const final = result || { is_genuine_alert: true, reason: 'AI解析失败，默认放行', severity: 'p0' };
    p0ValidationCache.set(cacheKey, { ts: Date.now(), result: final });
    return final;
  } catch (err) {
    if (err.message === 'AI_DEGRADED') {
      return { is_genuine_alert: true, reason: 'AI降级，关键词放行', severity: 'p0' };
    }
    return { is_genuine_alert: true, reason: 'AI异常，默认放行', severity: 'p0' };
  }
}

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

  // ── Step 1: P0 直接推送（含板块专属规则）──
  for (const msg of externalMsgs) {
    const regionInfo = getRegionInfo(msg.receiver_account);
    // L3 群静默，不触发任何告警
    const label = getValueLabel(msg.receiver_account, msg.group_name);
    if (label === 'L3') continue;

    const keyword = matchP0(msg.content, regionInfo.business_sector);
    if (!keyword) continue;

    // 去重：同一条消息已触发过 P0 告警则跳过
    const alreadyAlerted = checkMsgAlerted.get(`%${msg.id}%`);
    if (alreadyAlerted) continue;

    // P0 上下文AI二次验证（新故障 vs 历史讨论）
    const validation = await validateP0WithContext(msg, keyword);
    if (!validation.is_genuine_alert) {
      console.log(`[P0-SUPPRESSED] ${msg.group_name} | keyword=${keyword} | reason=${validation.reason}`);
      continue;
    }
    const severity = validation.severity === 'p1' ? 'p1' : 'p0';

    const commitment = extractCommitment(msg.content);

    // 同群同级别30分钟去重：已有告警记录则跳过，仅追加消息ID到已有记录
    const recentSame = checkRecentAlert.get(msg.group_name, severity);
    if (recentSame) {
      const mergedIds = mergeMsgIds(recentSame.source_msg_ids, [msg.id]);
      analyticsDb.prepare('UPDATE alert_records SET source_msg_ids = ? WHERE id = ?').run(mergedIds, recentSame.id);
      console.log(`[${severity.toUpperCase()}-DEDUP] ${msg.group_name} | 30分钟内已有同级告警，跳过 | 合并msg ${msg.id}`);
      continue;
    }

    // 写告警记录
    const alertInfo = insertAlert.run({
      source_msg_ids: JSON.stringify([msg.id]),
      group_name: msg.group_name,
      group_id: msg.group_id,
      region: regionInfo.region,
      business_sector: regionInfo.business_sector || null,
      receiver_account: msg.receiver_account,
      alert_level: severity,
      trigger_type: 'keyword',
      trigger_keywords: keyword,
      ai_score: null,
      ai_title: `${severity.toUpperCase()}告警：${keyword}`,
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
      business_sector: regionInfo.business_sector || null,
      issue_type: '通道故障',
      opened_at: msg.timestamp,
      commitment_text: commitment,
      commitment_due: commitment ? parseCommitmentDeadline(commitment) : null,
      recurrence_count: recurrence,
    });

    // 推送
    const content = buildP0AlertContent(msg, keyword, regionInfo);
    const alertIcon = severity === 'p0' ? '🔴' : '🟠';
    const sendResult = await dingtalk.sendAlert({
      title: `${alertIcon} ${severity.toUpperCase()}告警 ${regionInfo.region}-${msg.group_name}`,
      content,
      platform: regionInfo.platform,
      region: regionInfo.region,
      businessSector: regionInfo.business_sector,
      alertType: severity.toUpperCase(),
    });
    markAlertPushResult(alertInfo.lastInsertRowid, sendResult, `[${severity.toUpperCase()}] ${regionInfo.region}-${msg.group_name}`);

    console.log(`[${severity.toUpperCase()}] ${regionInfo.region}-${msg.group_name} | ${keyword}`);
  }

  // ── Step 2: P1 窗口聚合 ──
  for (const msg of externalMsgs) {
    // L2/L3 群不触发 P1 聚合（L2 仅 P0，L3 全静默）
    const label = getValueLabel(msg.receiver_account, msg.group_name);
    if (label === 'L2' || label === 'L3') continue;

    const regionInfoP1 = getRegionLabel(msg.receiver_account);
    const sectorP1 = regionInfoP1.business_sector || '';
    const kws = matchP1Keywords(msg.content, sectorP1);
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

    // P1 上下文锚点：取窗口前 5 条消息作为对话背景
    const contextAnchor = getContextWindow.all(
      firstMsg.group_id || '', firstMsg.group_name, firstMsg.id
    ).reverse();

    // 确定群类型
    const groupType = detectGroupType(firstMsg.group_name);
    const aiResult = await aiClient.analyzeAlertMessages(displayName, groupType, msgs, senderNames, contextAnchor);

    const finalScore = aiResult?.score ?? 6; // 降级时默认6
    if (finalScore < 7) continue;

    const commitment = aiResult?.commitment || msgs.map((m) => extractCommitment(m.content)).find(Boolean) || null;
    const issueType = aiResult?.type || 'P1告警';

    // 同群同级别30分钟去重：已有告警记录则跳过，仅追加窗口消息ID
    const recentP1 = checkRecentAlert.get(firstMsg.group_name, 'p1');
    if (recentP1) {
      const mergedIds = mergeMsgIds(recentP1.source_msg_ids, msgs.map(m => m.id));
      analyticsDb.prepare('UPDATE alert_records SET source_msg_ids = ? WHERE id = ?').run(mergedIds, recentP1.id);
      console.log(`[P1-DEDUP] ${displayName} | 30分钟内已有P1告警，跳过 | 合并${msgs.length}条消息`);
      continue;
    }

    const alertInfo = insertAlert.run({
      source_msg_ids: JSON.stringify(msgs.map((m) => m.id)),
      group_name: firstMsg.group_name,
      group_id: firstMsg.group_id,
      region: regionInfo.region,
      business_sector: regionInfo.business_sector || null,
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
      push_channel: 'dingtalk_alert'
    });

    const recurrence = getRecurrenceCount(firstMsg.group_name, issueType);
    insertIssue.run({
      alert_id: alertInfo.lastInsertRowid,
      group_name: firstMsg.group_name,
      group_id: firstMsg.group_id,
      region: regionInfo.region,
      business_sector: regionInfo.business_sector || null,
      issue_type: issueType,
      opened_at: firstMsg.timestamp,
      commitment_text: commitment,
      commitment_due: commitment ? parseCommitmentDeadline(commitment) : null,
      recurrence_count: recurrence,
    });

    const content = buildP1AlertContent(firstMsg.group_name, regionInfo, aiResult || { score: finalScore, title: 'P1聚合告警', type: issueType, commitment, action: null }, msgs.length);
    const sendResult = await dingtalk.sendAlert({
      title: `🟠 P1告警 ${displayName}`,
      content,
      platform: regionInfo.platform,
      region: regionInfo.region,
      businessSector: regionInfo.business_sector,
      alertType: 'P1',
    });
    markAlertPushResult(alertInfo.lastInsertRowid, sendResult, `[P1] ${displayName}`);
    console.log(`[P1] ${displayName} | score=${finalScore} | ${msgs.length}条消息`);
  }

  // ── Step 3: 无响应检测 ──
  for (const msg of externalMsgs) {
    // L3 群不启动无响应检测
    if (getValueLabel(msg.receiver_account, msg.group_name) === 'L3') continue;

    const key = msg.group_id || msg.group_name;
    if (!noResponseState.has(key)) {
      noResponseState.set(key, { firstExternalTs: now, firstMsg: msg, externalMsgs: [msg], alerted: false, lastExternalTs: now });
    } else {
      const state = noResponseState.get(key);
      if (!state.alerted) appendNoResponseMessage(state, msg);
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
      const noResponseMessages = getNoResponseMessages(state);
      const noResponseMsgIds = noResponseMessages.map((m) => m.id).filter(Number.isFinite);
      const noResponseInsight = buildNoResponseInsight(noResponseMessages, regionInfo, minutesElapsed);

      const recentP2 = checkRecentAlert.get(msg.group_name, 'p2');
      if (recentP2) {
        const mergedIds = mergeMsgIds(recentP2.source_msg_ids, noResponseMsgIds);
        analyticsDb.prepare('UPDATE alert_records SET source_msg_ids = ? WHERE id = ?').run(mergedIds, recentP2.id);
        state.alerted = true;
        console.log(`[P2-DEDUP:${NO_RESPONSE_ALERT_FORMAT}] ${regionInfo.region}-${msg.group_name} | 30分钟内已有响应缺口告警，合并${noResponseMsgIds.length}条消息`);
        continue;
      }

      const alertInfo = insertAlert.run({
        source_msg_ids: JSON.stringify(noResponseMsgIds),
        group_name: msg.group_name,
        group_id: msg.group_id,
        region: regionInfo.region,
        business_sector: regionInfo.business_sector || null,
        receiver_account: msg.receiver_account,
        alert_level: 'p2',
        trigger_type: 'no_response',
        trigger_keywords: null,
        ai_score: null,
        ai_title: `${minutesElapsed}分钟响应缺口：${noResponseInsight.summary}`,
        ai_type: '响应缺口',
        ai_action: noResponseInsight.action,
        ai_commitment: null,
        is_pushed: 0,
        push_channel: 'dingtalk_alert',
      });

      const content = buildNoResponseContent(state, regionInfo, minutesElapsed, noResponseInsight);
      const sendResult = await dingtalk.sendAlert({
        title: `🟡 P2响应缺口 ${regionInfo.region}-${msg.group_name}`,
        content,
        platform: regionInfo.platform,
        region: regionInfo.region,
        businessSector: regionInfo.business_sector,
        alertType: 'P2',
      });
      markAlertPushResult(alertInfo.lastInsertRowid, sendResult, `[P2:${NO_RESPONSE_ALERT_FORMAT}] ${regionInfo.region}-${msg.group_name}`);
      state.alerted = true;
      console.log(`[P2-ResponseGap:${NO_RESPONSE_ALERT_FORMAT}] ${regionInfo.region}-${msg.group_name} | ${minutesElapsed}分钟响应缺口`);
    }
  }

  // ── Step 4: SID 变更检测 ──
  for (const msg of newMsgs) {
    const sids = detectSidChange(msg.content);
    if (sids.length < SID_BATCH_THRESHOLD) continue;

    const regionInfo = getRegionInfo(msg.receiver_account);
    analyticsDb.prepare(`
      INSERT INTO sid_change_records (group_name, group_id, region, business_sector, sender_name, sid_list, raw_content, source_msg_id, is_pushed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(msg.group_name, msg.group_id, regionInfo.region, regionInfo.business_sector || null, msg.sender_name, JSON.stringify(sids), msg.content.slice(0, 500), msg.id);

    const sendResult = await dingtalk.sendSidChangeAlert({
      groupName: msg.group_name,
      region: regionInfo.region,
      senderName: msg.sender_name,
      sidList: sids,
      platform: regionInfo.platform,
      businessSector: regionInfo.business_sector,
      alertType: 'SID'
    });

    if (sendResult?.ok) {
      markSidPushed.run(msg.id);
    } else {
      console.warn(`[SID-PUSH-SKIPPED] ${regionInfo.region}-${msg.group_name} | ${sendResult?.reason || 'unknown'}`);
    }
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

module.exports = {
  processNewMessages,
  getPollingInterval,
};

if (require.main === module) {
  // ─── 启动 ────────────────────────────────────────────────────────
  console.log('[supplier-analyzer] 启动，分时轮询：高峰15s / 普通30s / 低谷60s');
  tick();

  process.on('SIGINT', () => {
      console.log('[supplier-analyzer] SIGINT 收到，正在优雅关闭...');
      try { sourceDb.close(); } catch (_) {}
      try { analyticsDb.close(); } catch (_) {}
      process.exit(0);
  });
}
