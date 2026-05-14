/**
 * analyzers/daily-digest.js
 * 每日群汇总日报 — 阶段A核心模块（维度3）
 *
 * 职责：
 *   1. 每天 09:00 (Asia/Shanghai) 自动触发
 *   2. 查昨日活跃群（≥5条消息），按区域分组
 *   3. 过滤内部账号消息，AI 生成关键摘要
 *   4. 注入未闭环的 issue_records（「⏳ 未闭环事项」模块）
 *   5. 统计沉默超24h群组
 *   6. 格式化后推送至 DINGTALK_DIGEST
 *   7. 结果写入 analytics.sqlite daily_digests 表
 *
 * 依赖：node-cron（需 npm install node-cron）
 */

'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const dingtalk = require('../lib/dingtalk');
const aiClient = require('../lib/ai-client');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');

// ─── 数据库连接 ──────────────────────────────────────────────────
const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

const insertDigestStmt = analyticsDb.prepare(`
  INSERT INTO daily_digests (
    digest_date, group_name, group_id, region, business_sector, receiver_account,
    msg_count, key_points, follow_up, open_issues_cnt, has_alert, prompt_version
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(digest_date, group_name) DO UPDATE SET
    msg_count=excluded.msg_count,
    key_points=excluded.key_points,
    follow_up=excluded.follow_up,
    open_issues_cnt=excluded.open_issues_cnt,
    has_alert=excluded.has_alert,
    prompt_version=excluded.prompt_version,
    business_sector=excluded.business_sector
`);

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
    console.error('[daily-digest] 重载 account-regions.json 失败:', e.message);
    if (!_regionMap) _regionMap = {};
  }
  return _regionMap;
}

function getRegionLabel(receiverAccount) {
  const map = getRegionMap();
  const info = map[receiverAccount];
  return info || { region: '未知区', business_sector: null, platform: 'wa' };
}

function getValueLabel(receiverAccount, groupName) {
  // 群级别覆盖优先（读取完整 JSON 以获取 _group_overrides）
  if (groupName) {
    try {
      const cfg = JSON.parse(fs.readFileSync(REGION_CONFIG_PATH, 'utf8'));
      if (cfg._group_overrides?.[groupName]?.value_label) {
        return cfg._group_overrides[groupName].value_label;
      }
    } catch (_) {}
  }
  // 账号级别
  const map = getRegionMap();
  const info = map[receiverAccount];
  return (info && info.value_label) || 'L1';
}

// ─── 内部账号过滤（动态配置）───────────────────
const { isInternalStaff } = require('../lib/staff-detector');
function isInternalSender(name) {
  if (!name) return true; // 日报中空名字通常是系统消息，过滤掉
  return isInternalStaff(name);
}

// ─── 时间工具 ─────────────────────────────────────────────────────
function getYesterdayRange() {
  const now = new Date();
  const tzOffset = 8 * 60 * 60 * 1000; // UTC+8
  const todayStart = new Date(
    Math.floor((now.getTime() + tzOffset) / 86400000) * 86400000 - tzOffset
  );
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  return {
    start: yesterdayStart.getTime(),
    end: todayStart.getTime() - 1,
    dateStr: yesterdayStart.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-'),
  };
}

function formatTs(ts) {
  return new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit' });
}

// ─── 分板块沉默阈值（小时）────────────────────────────────────
const SILENCE_THRESHOLD_BY_SECTOR = {
  '客服': 4,
  '直连供应商': 12,
  '语音直连供应商': 12,
  '设备供应商': 24,
  '卡线': 24,
};
const DEFAULT_SILENCE_HOURS = 24;

function getSilenceThresholdHours(sector) {
  return SILENCE_THRESHOLD_BY_SECTOR[sector] || DEFAULT_SILENCE_HOURS;
}

// ─── 并发控制 ────────────────────────────────────────────────────
let _digestRunning = false;

// ─── 日报生成主函数 ───────────────────────────────────────────────
async function generateDailyDigest() {
  if (_digestRunning) {
    console.log('[daily-digest] 上一轮日报仍在生成中，跳过本次触发');
    return;
  }
  _digestRunning = true;
  try {
  console.log('[daily-digest] 开始生成日报...');
  const range = getYesterdayRange();

  // ── Step 1: 查询昨日活跃群 ──
  const activeGroups = sourceDb.prepare(`
    SELECT group_name, group_id, receiver_account,
           COUNT(*) AS msg_count,
           GROUP_CONCAT(sender_name || ': ' || content, '\n---\n') AS content_blob
    FROM messages
    WHERE timestamp BETWEEN ? AND ?
      AND content IS NOT NULL AND content != ''
    GROUP BY group_id
    HAVING msg_count >= 5
    ORDER BY receiver_account, msg_count DESC
  `).all(range.start, range.end);

  // ── Step 2: 查昨日未闭环 issue_records ──
  const openIssues = analyticsDb.prepare(`
    SELECT group_name, issue_type, opened_at, commitment_text, status
    FROM issue_records
    WHERE status IN ('open','escalated')
      AND opened_at BETWEEN ? AND ?
    ORDER BY opened_at ASC
  `).all(range.start, range.end);

  // ── Step 3: 历史时间窗口（各 webhook 按区域动态查询趋势）──
  const prevDayStart = range.start - 86400000;
  const prevDayEnd = range.start - 1;
  const lastWeekStart = range.start - 7 * 86400000;
  const lastWeekEnd = range.end - 7 * 86400000;

  // ── Step 4: 查沉默群组（按板块差异化阈值）──
  // 先取所有群组最近消息时间，再按板块阈值过滤
  const allGroupLastMsg = sourceDb.prepare(`
    SELECT group_name, receiver_account,
           MAX(timestamp) AS last_ts,
           COUNT(*) AS total_msgs
    FROM messages
    GROUP BY group_id
    HAVING COUNT(*) >= 10
  `).all();

  const now = Date.now();
  const silentGroups = allGroupLastMsg.filter(g => {
    const info = getRegionLabel(g.receiver_account);
    const sector = info.business_sector || '';
    const thresholdHours = getSilenceThresholdHours(sector);
    const silentHours = (now - g.last_ts) / 3600000;
    return silentHours >= thresholdHours;
  }).map(g => ({
    group_name: g.group_name,
    receiver_account: g.receiver_account,
    silent_hours: parseFloat(((now - g.last_ts) / 3600000).toFixed(1)),
  })).sort((a, b) => b.silent_hours - a.silent_hours);

  // ── Step 4: 并发 AI 生成摘要（最多5并发，避免 API 过载）──
  const CONCURRENCY = 5;
  const summariesByPlatform = {};

  async function processGroup(group) {
    const regionInfo = getRegionLabel(group.receiver_account);
    const region = regionInfo.region || '未知区';
    const sector = regionInfo.business_sector || '';
    const platform = regionInfo.platform || 'wa';

    // 价值标签过滤：L3 不纳入日报；L2 仅纳入沉默列表
    const label = getValueLabel(group.receiver_account, group.group_name);
    if (label === 'L3') return;

    const displayName = `${region}-${group.group_name}`;

    const lines = (group.content_blob || '').split('\n---\n');
    const externalLines = [];
    const internalLines = [];
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon < 0) { externalLines.push(line); continue; }
      const sender = line.slice(0, colon).trim();
      if (isInternalSender(sender)) {
        internalLines.push(line);
      } else {
        externalLines.push(line);
      }
    }
    const filteredContent = externalLines.join('\n').slice(0, 4000);
    const internalContent = internalLines.join('\n').slice(0, 1500);

    const groupOpenIssues = openIssues.filter((i) => i.group_name === group.group_name);

    const aiResult = await aiClient.analyzeDailyDigest(displayName, filteredContent, groupOpenIssues, internalContent);

    const keyPoints = aiResult?.keyPoints ?? [];
    const followUp = aiResult?.followUp ?? [];
    const hasAlert = aiResult?.hasAlert ?? false;
    const solutions = aiResult?.solutions ?? [];

    const summary = {
      displayName,
      groupName: group.group_name,
      receiverAccount: group.receiver_account,
      region,
      businessSector: sector,
      valueLabel: label,
      msgCount: group.msg_count,
      keyPoints: keyPoints.length > 0 ? keyPoints : [`昨日共${group.msg_count}条消息，AI摘要不可用`],
      followUp,
      solutions,
      openIssues: groupOpenIssues,
      hasAlert,
    };

    if (!summariesByPlatform[platform]) summariesByPlatform[platform] = [];
    summariesByPlatform[platform].push(summary);

    insertDigestStmt.run(
      range.dateStr, group.group_name, group.group_id, regionInfo.region, regionInfo.business_sector || null, group.receiver_account,
      group.msg_count, JSON.stringify(keyPoints), JSON.stringify(followUp),
      groupOpenIssues.length, hasAlert ? 1 : 0, aiClient.PROMPT_VERSIONS.dailyDigest,
    );
  }

  // 按 CONCURRENCY 批量并发执行
  for (let i = 0; i < activeGroups.length; i += CONCURRENCY) {
    const batch = activeGroups.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(processGroup));
  }

  // ── Step 5 & 6: 全局 Webhook 路由与合并推送 ──
  // 核心逻辑：不再按平台循环推送，而是将所有平台的 summary 汇总，按 Webhook URL 严格合并
  const allSummaries = [];
  for (const p of Object.keys(summariesByPlatform)) {
    allSummaries.push(...summariesByPlatform[p].map(s => ({ ...s, platform: p })));
  }

  const webhooksConfig = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'webhooks.json'), 'utf8')); } catch (_) { return {}; }
  })();

  function findBestWebhook(type, platform, region, sector) {
    const typeUpper = type.toUpperCase();
    if (sector) {
      const key1 = `${typeUpper}_${platform}_${region}_${sector}`;
      if (webhooksConfig[key1]?.url) return webhooksConfig[key1];
    }
    const key2 = `${typeUpper}_${platform}_${region}`;
    if (webhooksConfig[key2]?.url) return webhooksConfig[key2];
    const key3 = `${typeUpper}_${platform}`;
    if (webhooksConfig[key3]?.url) return webhooksConfig[key3];
    return null;
  }

  const byWebhook = new Map();
  for (const s of allSummaries) {
    const wh = findBestWebhook('DIGEST', s.platform, s.region, s.businessSector);
    const whKey = wh?.url || '__global__';
    if (!byWebhook.has(whKey)) byWebhook.set(whKey, { summaries: [], webhook: wh });
    byWebhook.get(whKey).summaries.push(s);
  }

  for (const [whKey, group] of byWebhook) {
    const summaries = group.summaries;
    // 如果没有实质性的活跃群汇总数据则跳过，避免推送只有标题的空日报
    if (!summaries || summaries.length === 0) continue;

    // 无专属 webhook 且无全局兜底时跳过
    if (!group.webhook && !process.env.DINGTALK_DIGEST) {
      console.log(`[daily-digest] ⏭ 跳过 ${summaries.length}个群（无匹配 webhook）`);
      continue;
    }

    // ── 本区域趋势数据 ──
    const regionAccts = [...new Set(summaries.map(s => s.receiverAccount))];
    const yesterdayTotal = summaries.reduce((s, g) => s + g.msgCount, 0);

    let prevDayCount = 0;
    if (regionAccts.length > 0) {
      const placeholders = regionAccts.map(() => '?').join(',');
      const stmt = sourceDb.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE timestamp BETWEEN ? AND ? AND receiver_account IN (${placeholders}) AND content IS NOT NULL AND content != ''`);
      prevDayCount = stmt.get(prevDayStart, prevDayEnd, ...regionAccts)?.cnt || 0;
    }

    let lastWeekCount = 0;
    if (regionAccts.length > 0) {
      const placeholders = regionAccts.map(() => '?').join(',');
      const stmt = sourceDb.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE timestamp BETWEEN ? AND ? AND receiver_account IN (${placeholders}) AND content IS NOT NULL AND content != ''`);
      lastWeekCount = stmt.get(lastWeekStart, lastWeekEnd, ...regionAccts)?.cnt || 0;
    }

    const trendPrevDay = prevDayCount > 0 ? ((yesterdayTotal - prevDayCount) / prevDayCount * 100).toFixed(0) : null;
    const trendLastWeek = lastWeekCount > 0 ? ((yesterdayTotal - lastWeekCount) / lastWeekCount * 100).toFixed(0) : null;
    const trend = { yesterdayTotal, prevDayCount, lastWeekCount, trendPrevDay, trendLastWeek };

    // 确定该 webhook 覆盖的主要区域和平台（用于标题）
    const platformsInGroup = [...new Set(summaries.map(s => s.platform))];
    const regionsInGroup = [...new Set(summaries.map(s => s.region))];
    const primaryRegion = regionsInGroup.length === 1 ? regionsInGroup[0] : '';

    // 筛选该 webhook 对应的沉默群组和未闭环事项
    const gSilent = silentGroups.filter(g => {
      const info = getRegionLabel(g.receiver_account);
      const wh = findBestWebhook('DIGEST', info.platform, info.region, info.business_sector);
      return (wh?.url || '__global__') === whKey;
    });

    const gOpenIssues = openIssues.filter(i =>
      summaries.some(s => s.groupName === i.group_name)
    );

    const digestText = formatDigest(summaries, gSilent, range, gOpenIssues, trend, primaryRegion);
    if (!digestText) continue;

    const title = `📋 供应商群 ${range.dateStr} 日报${primaryRegion ? ` (${primaryRegion}专区)` : ''}`;

    // 直接调用 _send 以避免 dingtalk.js 中的二次解析逻辑
    const axios = require('axios');
    const crypto = require('crypto');
    function signUrl(webhookUrl, secret) {
      if (!secret) return webhookUrl;
      const timestamp = Date.now();
      const stringToSign = `${timestamp}\n${secret}`;
      const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
      return `${webhookUrl}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    }

    const whUrl = group.webhook?.url || process.env.DINGTALK_DIGEST;
    const whSecret = group.webhook?.secret || process.env.DINGTALK_DIGEST_SECRET || process.env.DINGTALK_SECRET;

    if (whUrl) {
      const url = signUrl(whUrl, whSecret);
      try {
        await axios.post(url, {
          msgtype: 'markdown',
          markdown: { title, text: digestText }
        }, { timeout: 10000 });
        console.log(`[daily-digest] ✅ Webhook ${whKey.slice(0, 40)}... 推送完成 (${summaries.length}个群)`);
      } catch (err) {
        console.error(`[daily-digest] ❌ Webhook 推送失败:`, err.message);
      }
    }
  }
  } finally {
    _digestRunning = false;
  }
}

// ── 格式化（板块优先，平铺群组，区域仅作标签后缀）─────────────
function formatDigest(summaries, silentGroups, range, allOpenIssues, trend, regionLabel) {
  if (summaries.length === 0 && silentGroups.length === 0) return null;

  const lines = [];
  const platformsInGroup = [...new Set(summaries.map(s => s.platform))];
  const platformNames = platformsInGroup.map(p => ({ wa: 'WhatsApp', tg: 'Telegram', tgu: 'Telegram', teams: 'Teams' }[p] || p));
  const platformTitle = [...new Set(platformNames)].join(' & ');

  lines.push(`## ${platformTitle} 供应商群消息汇总`);
  lines.push(`${range.dateStr} 09:00 日报${regionLabel ? ' · ' + regionLabel + '专区' : ''}`);
  lines.push('');

  // ── 趋势速览 ──
  if (trend) {
    const trendIcon = (v) => v > 0 ? '📈' : (v < 0 ? '📉' : '➡️');
    lines.push('**趋势速览**');
    lines.push(`- 昨日消息：${trend.yesterdayTotal} 条`);
    if (trend.trendPrevDay !== null) lines.push(`- 环比前日：${trendIcon(parseInt(trend.trendPrevDay))} ${trend.trendPrevDay > 0 ? '+' : ''}${trend.trendPrevDay}%`);
    if (trend.trendLastWeek !== null) lines.push(`- 同比上周：${trendIcon(parseInt(trend.trendLastWeek))} ${trend.trendLastWeek > 0 ? '+' : ''}${trend.trendLastWeek}%`);
    lines.push('');
  }

  // ── 按板块平铺群组 ──
  const bySector = {};
  for (const s of summaries) {
    const sec = s.businessSector || '未分类';
    if (!bySector[sec]) bySector[sec] = [];
    bySector[sec].push(s);
  }

  const sectorIcons = { '设备供应商': '🏭', '直连供应商': '🔗', '语音直连供应商': '📞', '客服': '💬', '卡线': '📱' };

  for (const [sector, groups] of Object.entries(bySector)) {
    const sectorIcon = sectorIcons[sector] || '📋';
    const sectorMsgs = groups.reduce((s, g) => s + g.msgCount, 0);
    lines.push(`---`);
    lines.push(`### ${sectorIcon} ${sector}（${groups.length}群 / ${sectorMsgs}条）`);
    lines.push('');

    for (const g of groups) {
      lines.push(`### ${g.groupName}  ${g.msgCount}条  ${g.region || ''}`);
      lines.push('');

      // 清理内容，并剔除 AI 可能自带的图标
      const cleanList = (arr) => {
        if (!Array.isArray(arr)) return [];
        return arr.map(s => (s || '').toString().trim())
                  .filter(s => {
                    const cleanStr = s.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
                    return cleanStr && 
                           !['无', '无异常', '运营正常', '—', '-', '空', 'none', 'null'].includes(cleanStr.toLowerCase()) && 
                           !cleanStr.startsWith('昨日共');
                  })
                  .map(s => s.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim()); // 剔除 AI 自带图标
      };

      const validKP = cleanList(g.keyPoints);
      const validFU = cleanList(g.followUp);
      const validSols = cleanList(g.solutions);

      // ① 关键讨论
      lines.push(`**【📌 关键讨论】**`);
      if (validKP.length > 0) {
        for (const pt of validKP.slice(0, 4)) lines.push(`- ${pt}`);
      } else {
        lines.push(`- 昨日运行平稳`);
      }
      lines.push(''); // 模块间留白

      // ②~⑤ 有数据才展示
      if (validFU.length > 0) {
        lines.push(`**【⚠️ 需关注】**`);
        for (const f of validFU.slice(0, 3)) lines.push(`- ${f}`);
        lines.push('');
      }

      // Voice sector ("语音直连供应商") should skip "我方方案" and "告警信号"
      if (sector !== '语音直连供应商') {
        if (validSols.length > 0) {
          lines.push(`**【💡 我方方案】**`);
          for (const sol of validSols.slice(0, 3)) lines.push(`- ${sol}`);
          lines.push('');
        }
      }

      if (g.openIssues && g.openIssues.length > 0) {
        const issues = g.openIssues.slice(0, 3);
        if (issues.length > 0) {
          lines.push(`**【⏳ 未闭环事项】**`);
          for (const issue of issues) {
            const t = formatTs(issue.opened_at);
            lines.push(`- [${t}] ${issue.issue_type}`);
          }
          lines.push('');
        }
      }

      if (sector !== '语音直连供应商' && g.hasAlert) {
        lines.push('🚨 **存在未解决告警信号**');
        lines.push('');
      }

      // 群组间分割线
      lines.push('---');
      lines.push('');
    }

    // 板块沉默统计
    const sectorSilent = silentGroups.filter(g => {
      const info = getRegionLabel(g.receiver_account);
      return (info.business_sector || '') === sector;
    });
    if (sectorSilent.length > 0) {
      const thresholdH = getSilenceThresholdHours(sector);
      lines.push(`**沉默超 ${thresholdH}h 群组**`);
      for (const g of sectorSilent.slice(0, 5)) {
        lines.push(`- ${g.group_name}（${g.silent_hours}h）`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Cron 调度 ────────────────────────────────────────────────────
// 每天 09:00 Asia/Shanghai 触发
cron.schedule('0 9 * * *', async () => {
  try {
    await generateDailyDigest();
  } catch (err) {
    console.error('[daily-digest] 生成失败:', err.message);
  }
}, { timezone: 'Asia/Shanghai' });

console.log('[daily-digest] 已启动，定时任务：每天 09:00 (Asia/Shanghai) 触发');

// 支持命令行手动触发：node analyzers/daily-digest.js --now
if (process.argv.includes('--now')) {
  console.log('[daily-digest] 手动触发...');
  generateDailyDigest().then(() => {
    console.log('[daily-digest] 手动推送完成，关闭临时进程');
    process.exit(0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

process.on('SIGINT', () => {
    console.log('[daily-digest] SIGINT 收到，正在优雅关闭...');
    try { sourceDb.close(); } catch (_) {}
    try { analyticsDb.close(); } catch (_) {}
    process.exit(0);
});
