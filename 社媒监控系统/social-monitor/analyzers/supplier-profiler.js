/**
 * analyzers/supplier-profiler.js
 * 供应商画像计算引擎 — 阶段C（维度7）
 *
 * 职责：
 *   1. 每日 03:00 (Asia/Shanghai) 自动触发
 *   2. 从 issue_records 汇总计算响应速度/承诺兑现率/复发率
 *   3. 从 messages 提取通道质量数值指标（DLR/ASR/点击率）
 *   4. 计算可靠性评分并写入 supplier_profiles
 *   5. 写入 channel_quality_metrics
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const aiClient = require('../lib/ai-client');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');

const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─── 区域配置 ────────────────────────────────────────────────────
const accountConfig = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'account-regions.json'), 'utf8')
);
const REGION_MAP = Object.fromEntries(
  accountConfig.accounts.map((a) => [a.account, a])
);

function getRegionInfo(receiverAccount) {
  return REGION_MAP[receiverAccount] || { region: '未知区', business_sector: null, platform: 'wa' };
}

// ─── 表就绪检查 ──────────────────────────────────────────────────
function ensureTable(tableName) {
  try {
    analyticsDb.prepare(`SELECT COUNT(*) FROM ${tableName} LIMIT 1`).get();
    return true;
  } catch (_) {
    return false;
  }
}

// ─── 通道质量指标提取正则 ──────────────────────────────────────
const METRIC_PATTERNS = [
  { type: 'dlr_rate',    regex: /(?:DLR|delivery\s+rate|success\s+rate)\s*(?:is\s+|of\s+|at\s+)?(\d{1,3}(?:\.\d)?)\s*%/i, scale: 100 },
  { type: 'click_rate',  regex: /(?:click\s+(?:ratio|rate)|CTR)\s*(?:is\s+|of\s+|at\s+)?(\d{1,3}(?:\.\d)?)\s*%/i, scale: 100 },
  { type: 'block_rate',  regex: /(?:block\s+(?:ratio|rate)|拦截率)\s*(?:is\s+|of\s+|at\s+)?(\d{1,3}(?:\.\d)?)\s*%/i, scale: 100 },
  { type: 'asr',         regex: /(?:ASR|answer\s+(?:seizure\s+)?ratio)\s*(?:is\s+|of\s+|at\s+)?(\d{1,3}(?:\.\d)?)\s*%/i, scale: 100 },
  { type: 'concurrent',  regex: /(?:concurrent|capacity|ports?)\s*(?:is\s+|of\s+|at\s+|around\s+)?(\d{2,})\s*(?:ports?|channels?|calls?)?/i, scale: 1 },
];

function extractMetrics(content, groupName, msgId, dateStr) {
  if (!content) return;
  for (const mp of METRIC_PATTERNS) {
    const m = content.match(mp.regex);
    if (m) {
      const rawValue = parseFloat(m[1]);
      if (isNaN(rawValue)) continue;
      const value = mp.scale === 100 ? rawValue / 100 : rawValue;
      // 幂等写入：INSERT OR IGNORE
      try {
        analyticsDb.prepare(`
          INSERT OR IGNORE INTO channel_quality_metrics
            (group_name, metric_date, metric_type, metric_value, metric_raw_text, source_msg_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(groupName, dateStr, mp.type, value, content.slice(0, 300), msgId);
      } catch (_) {}
    }
  }
}

// ─── 评分公式 ────────────────────────────────────────────────────
function calcProfileScore(prof) {
  let score = 100;
  // 告警频次扣分：每次告警扣 10 分
  score -= (prof.total_issues || 0) * 10;
  // 未闭环扣分：每个未闭环问题扣 20 分
  score -= (prof.open_issues || 0) * 20;
  // 承诺兑现扣分：未兑现比例 * 30
  if (prof.commitment_rate !== null && prof.commitment_rate < 1) {
    score -= (1 - prof.commitment_rate) * 30;
  }
  // 响应慢扣分：P95 > 60分钟扣 10 分
  if (prof.p95_response_mins && prof.p95_response_mins > 60) {
    score -= Math.min(15, (prof.p95_response_mins - 60) / 10);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── 活跃时段统计 ───────────────────────────────────────────────
function calcActiveHours(groupId, groupName) {
  const buckets = { '00-06': 0, '06-12': 0, '12-18': 0, '18-24': 0 };
  try {
    const rows = sourceDb.prepare(`
      SELECT timestamp FROM messages
      WHERE (group_id = ? OR group_name = ?)
        AND timestamp > ?
      ORDER BY timestamp ASC
      LIMIT 5000
    `).all(groupId || '', groupName, Date.now() - 30 * 24 * 3600 * 1000);

    for (const r of rows) {
      const h = new Date(r.timestamp + 8 * 3600 * 1000).getUTCHours();
      if (h < 6) buckets['00-06']++;
      else if (h < 12) buckets['06-12']++;
      else if (h < 18) buckets['12-18']++;
      else buckets['18-24']++;
    }
  } catch (_) {}
  return JSON.stringify(buckets);
}

// ─── 主计算流程 ──────────────────────────────────────────────────
async function generateProfiles() {
  if (!ensureTable('supplier_profiles')) {
    console.warn('[supplier-profiler] supplier_profiles 表不存在，请先执行 init-analytics-db');
    return;
  }

  console.log('[supplier-profiler] 开始计算供应商画像...');
  const now = Date.now();
  const today = new Date(now + 8 * 3600 * 1000).toISOString().split('T')[0];

  // 获取所有有过 issue 的群组
  const groups = analyticsDb.prepare(`
    SELECT DISTINCT ir.group_name, ir.group_id, ir.region,
           MAX(ar.receiver_account) as receiver_account
    FROM issue_records ir
    LEFT JOIN alert_records ar ON ir.alert_id = ar.id
    GROUP BY ir.group_name
  `).all();

  const upsertProfile = analyticsDb.prepare(`
    INSERT INTO supplier_profiles (
      group_name, group_id, business_sector, region, platform,
      avg_response_mins, p50_response_mins, p95_response_mins,
      total_issues, open_issues, avg_resolution_mins, recurrence_rate,
      total_commitments, commitments_met, commitment_rate,
      reliability_score, score_updated_at,
      active_hours, top_issue_types, last_alert_at, total_messages,
      ai_attitude_tags, ai_insight_tags, ai_insight_summary, ai_sub_scores,
      ai_avg_turns, ai_fcr, ai_tech_contact, ai_tech_reply_rate,
      ai_planned_maintenance_pct, ai_profile_version,
      profile_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','+8 hours'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','+8 hours'))
    ON CONFLICT(group_name) DO UPDATE SET
      avg_response_mins=excluded.avg_response_mins,
      p50_response_mins=excluded.p50_response_mins,
      p95_response_mins=excluded.p95_response_mins,
      total_issues=excluded.total_issues,
      open_issues=excluded.open_issues,
      avg_resolution_mins=excluded.avg_resolution_mins,
      recurrence_rate=excluded.recurrence_rate,
      total_commitments=excluded.total_commitments,
      commitments_met=excluded.commitments_met,
      commitment_rate=excluded.commitment_rate,
      reliability_score=excluded.reliability_score,
      score_updated_at=datetime('now','+8 hours'),
      active_hours=excluded.active_hours,
      top_issue_types=excluded.top_issue_types,
      last_alert_at=excluded.last_alert_at,
      total_messages=excluded.total_messages,
      profile_updated_at=datetime('now','+8 hours')
  `);

  for (const g of groups) {
    const regionInfo = getRegionInfo(g.receiver_account);
    const sector = regionInfo.business_sector || '未分类';
    const platform = regionInfo.platform || 'wa';

    // ── 问题统计 ──
    const issueStats = analyticsDb.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN status IN ('open','escalated') THEN 1 END) AS open_cnt,
        AVG(CASE WHEN duration_mins IS NOT NULL THEN duration_mins END) AS avg_dur,
        COUNT(CASE WHEN commitment_text IS NOT NULL THEN 1 END) AS total_commit,
        SUM(CASE WHEN commitment_met = 1 THEN 1 ELSE 0 END) AS met_commit
      FROM issue_records
      WHERE group_name = ?
    `).get(g.group_name);

    // ── 复发率：同 issue_type 出现 >1 次的比例 ──
    const typeCounts = analyticsDb.prepare(`
      SELECT issue_type, COUNT(*) as cnt
      FROM issue_records
      WHERE group_name = ?
      GROUP BY issue_type
    `).all(g.group_name);
    const recurringTypes = typeCounts.filter(t => t.cnt > 1).length;
    const recurrenceRate = typeCounts.length > 0 ? recurringTypes / typeCounts.length : 0;

    // ── Top 3 问题类型 ──
    const topTypes = typeCounts.sort((a, b) => b.cnt - a.cnt).slice(0, 3).map(t => t.issue_type);

    // ── 响应时间：issue 开启到首个外部回复的时间 ──
    const responseTimes = [];
    const issues = analyticsDb.prepare(`
      SELECT id, opened_at, closed_at, group_id FROM issue_records WHERE group_name = ?
    `).all(g.group_name);

    for (const iss of issues) {
      const firstReply = sourceDb.prepare(`
        SELECT timestamp FROM messages
        WHERE (group_id = ? OR group_name = ?)
          AND timestamp > ? AND timestamp < ?
          AND content IS NOT NULL AND content != ''
        ORDER BY timestamp ASC LIMIT 1
      `).get(iss.group_id || '', g.group_name, iss.opened_at, iss.closed_at || now);
      if (firstReply) {
        responseTimes.push((firstReply.timestamp - iss.opened_at) / 60000);
      }
    }
    responseTimes.sort((a, b) => a - b);
    const avgResp = responseTimes.length > 0 ? responseTimes.reduce((s, v) => s + v, 0) / responseTimes.length : null;
    const p50Resp = responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length * 0.5)] : null;
    const p95Resp = responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length * 0.95)] : null;

    // ── 最后告警时间 ──
    const lastAlert = analyticsDb.prepare(`
      SELECT MAX(created_at) as last_at FROM alert_records WHERE group_name = ?
    `).get(g.group_name);

    // ── 活跃时段 ──
    const activeHours = calcActiveHours(g.group_id, g.group_name);

    // ── 消息总数 ──
    const msgCount = sourceDb.prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE group_name = ? OR group_id = ?'
    ).get(g.group_name, g.group_id || '');

    // ── 承诺兑现率 ──
    const commitRate = issueStats.total_commit > 0
      ? (issueStats.met_commit || 0) / issueStats.total_commit
      : null;

    // ── 构建画像 ──
    const profile = {
      total_issues: issueStats.total,
      open_issues: issueStats.open_cnt,
      avg_resolution_mins: issueStats.avg_dur,
      total_commitments: issueStats.total_commit,
      commitments_met: issueStats.met_commit || 0,
      commitment_rate: commitRate,
      avg_response_mins: avgResp,
      p50_response_mins: p50Resp,
      p95_response_mins: p95Resp,
      recurrence_rate: recurrenceRate,
    };

    const score = calcProfileScore(profile);

    upsertProfile.run(
      g.group_name, g.group_id, sector, g.region || regionInfo.region, platform,
      avgResp, p50Resp, p95Resp,
      issueStats.total, issueStats.open_cnt, issueStats.avg_dur, recurrenceRate,
      issueStats.total_commit, issueStats.met_commit || 0, commitRate,
      score,
      activeHours, JSON.stringify(topTypes),
      lastAlert?.last_at || null, (msgCount?.cnt || 0),
      // AI fields initially NULL, filled by second pass
      null, null, null, null, null, null, null, null, null, null
    );

    console.log(`[supplier-profiler] ${g.group_name}: 评分=${score} | 问题=${issueStats.total} | 响应P50=${p50Resp?.toFixed(1) || 'N/A'}min`);
  }

  // ── 通道质量指标提取（从近期消息中）──
  if (ensureTable('channel_quality_metrics')) {
    const recentMsgs = sourceDb.prepare(`
      SELECT id, group_name, content, timestamp
      FROM messages
      WHERE timestamp > ? AND content IS NOT NULL AND content != ''
      ORDER BY id DESC LIMIT 2000
    `).all(Date.now() - 7 * 24 * 3600 * 1000);

    for (const msg of recentMsgs) {
      const msgDate = new Date(msg.timestamp + 8 * 3600 * 1000).toISOString().split('T')[0];
      extractMetrics(msg.content, msg.group_name, msg.id, msgDate);
    }
    console.log('[supplier-profiler] 通道质量指标提取完成');
  }

  // ── AI 画像分析（NLP，并发控制）──
  const AI_CONCURRENCY = envNumber('SUPPLIER_PROFILE_AI_CONCURRENCY', 1);
  const needAI = groups.filter(g => {
    // 只对有足够问题记录或消息量的群组做AI分析
    const stats = analyticsDb.prepare(
      'SELECT total_issues, total_messages FROM supplier_profiles WHERE group_name = ?'
    ).get(g.group_name);
    return stats && (stats.total_issues > 0 || stats.total_messages > 10);
  });

  if (needAI.length > 0) {
    console.log(`[supplier-profiler] 开始AI画像分析，共 ${needAI.length} 个供应商...`);

    const aiUpsert = analyticsDb.prepare(`
      UPDATE supplier_profiles SET
        ai_attitude_tags = ?, ai_insight_tags = ?, ai_insight_summary = ?,
        ai_sub_scores = ?, ai_avg_turns = ?, ai_fcr = ?,
        ai_tech_contact = ?, ai_tech_reply_rate = ?,
        ai_planned_maintenance_pct = ?, ai_profile_version = ?,
        profile_updated_at = datetime('now','+8 hours')
      WHERE group_name = ?
    `);

    async function analyzeOneGroup(g) {
      try {
        const regionInfo = getRegionInfo(g.receiver_account);
        const sector = regionInfo.business_sector || '未分类';

        // 取近30天消息样本
        const recentMsgs = sourceDb.prepare(`
          SELECT sender_name, content, timestamp
          FROM messages
          WHERE (group_id = ? OR group_name = ?)
            AND timestamp > ? AND content IS NOT NULL AND content != ''
          ORDER BY timestamp DESC LIMIT 100
        `).all(g.group_id || '', g.group_name, Date.now() - 30 * 24 * 3600 * 1000);

        // 已有定量指标
        const stats = analyticsDb.prepare(`
          SELECT total_issues, open_issues, commitment_rate, recurrence_rate, avg_response_mins
          FROM supplier_profiles WHERE group_name = ?
        `).get(g.group_name);

        const aiResult = await aiClient.analyzeSupplierProfile(
          g.group_name, sector, recentMsgs, stats || {}
        );

        if (aiResult) {
          aiUpsert.run(
            JSON.stringify(aiResult.attitude_tags || []),
            JSON.stringify(aiResult.insight_tags || []),
            aiResult.insight_summary || '',
            aiResult.sub_scores ? JSON.stringify(aiResult.sub_scores) : null,
            aiResult.avg_turns,
            aiResult.fcr,
            aiResult.tech_contact,
            aiResult.tech_reply_rate,
            aiResult.planned_maintenance_pct,
            aiClient.PROMPT_VERSIONS.supplierProfile,
            g.group_name
          );
          console.log(`[supplier-profiler] AI分析完成: ${g.group_name} | 标签=${aiResult.attitude_tags?.length || 0}个`);
        } else {
          console.log(`[supplier-profiler] AI分析跳过(无结果): ${g.group_name}`);
        }
      } catch (err) {
        console.error(`[supplier-profiler] AI分析失败 ${g.group_name}:`, err.message);
      }
    }

    for (let i = 0; i < needAI.length; i += AI_CONCURRENCY) {
      const batch = needAI.slice(i, i + AI_CONCURRENCY);
      await Promise.allSettled(batch.map(analyzeOneGroup));
    }
    console.log('[supplier-profiler] AI画像分析完成');
  }

  console.log(`[supplier-profiler] 画像计算完成，共 ${groups.length} 个供应商`);
}

module.exports = {
  generateProfiles,
};

if (require.main === module) {
  // ─── Cron 调度 ────────────────────────────────────────────────────
  // 每天凌晨 03:00 Asia/Shanghai 触发
  cron.schedule('0 3 * * *', async () => {
    try {
      await generateProfiles();
    } catch (err) {
      console.error('[supplier-profiler] 生成失败:', err.message);
    }
  }, { timezone: 'Asia/Shanghai' });

  console.log('[supplier-profiler] 已启动，定时任务：每天 03:00 (Asia/Shanghai) 触发');

  // 支持手动触发 --now
  if (process.argv.includes('--now')) {
    console.log('[supplier-profiler] 手动触发...');
    generateProfiles().then(() => {
      console.log('[supplier-profiler] 手动计算完成');
      process.exit(0);
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }

  process.on('SIGINT', () => {
    console.log('[supplier-profiler] SIGINT 收到，正在优雅关闭...');
    try { sourceDb.close(); } catch (_) {}
    try { analyticsDb.close(); } catch (_) {}
    process.exit(0);
  });
}
