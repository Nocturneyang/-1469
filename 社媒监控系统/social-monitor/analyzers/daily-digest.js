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

const ROOT = path.resolve(__dirname, '..');

// ─── 数据库连接 ──────────────────────────────────────────────────
const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

const upsertDigest = analyticsDb.prepare(`
  INSERT INTO daily_digests (
    digest_date, group_name, group_id, region, receiver_account,
    msg_count, key_points, follow_up, open_issues_cnt, has_alert, prompt_version
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(digest_date, group_name) DO UPDATE SET
    msg_count=excluded.msg_count,
    key_points=excluded.key_points,
    follow_up=excluded.follow_up,
    open_issues_cnt=excluded.open_issues_cnt,
    has_alert=excluded.has_alert,
    prompt_version=excluded.prompt_version
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
  const info = map[`wa-${receiverAccount}`] ||
               map[`tg-${receiverAccount}`] ||
               map[receiverAccount];
  return info || { region: '未知区', platform: 'wa' };
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

// ─── 日报生成主函数 ───────────────────────────────────────────────
async function generateDailyDigest() {
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

  // ── Step 3: 查沉默群组（>24h 无消息，历史消息≥10条）──
  const silentThreshold = range.start; // 昨日开始前
  const silentGroups = sourceDb.prepare(`
    SELECT group_name, receiver_account,
           ROUND((CAST(strftime('%s','now') AS REAL) * 1000 - MAX(timestamp)) / 3600000.0, 1) AS silent_hours
    FROM messages
    GROUP BY group_id
    HAVING MAX(timestamp) < ? AND COUNT(*) >= 10
    ORDER BY silent_hours DESC
  `).all(silentThreshold);

  // ── Step 4: 并发 AI 生成摘要（最多5并发，避免 API 过载）──
  const CONCURRENCY = 5;
  const summariesByPlatform = {};

  async function processGroup(group) {
    const regionInfo = getRegionLabel(group.receiver_account);
    const region = regionInfo.region || '未知区';
    const platform = regionInfo.platform || 'wa';
    const displayName = `${region}-${group.group_name}`;

    const lines = (group.content_blob || '').split('\n---\n');
    const filteredLines = lines.filter((line) => {
      const colon = line.indexOf(':');
      if (colon < 0) return true;
      const sender = line.slice(0, colon).trim();
      return !isInternalSender(sender);
    });
    const filteredContent = filteredLines.join('\n').slice(0, 4000);

    const groupOpenIssues = openIssues.filter((i) => i.group_name === group.group_name);

    const aiResult = await aiClient.analyzeDailyDigest(displayName, filteredContent, groupOpenIssues);

    const keyPoints = aiResult?.keyPoints ?? [];
    const followUp = aiResult?.followUp ?? [];
    const hasAlert = aiResult?.hasAlert ?? false;

    const summary = {
      displayName,
      groupName: group.group_name,
      region,
      msgCount: group.msg_count,
      keyPoints: keyPoints.length > 0 ? keyPoints : [`昨日共${group.msg_count}条消息，AI摘要不可用`],
      followUp,
      openIssues: groupOpenIssues,
      hasAlert,
    };

    if (!summariesByPlatform[platform]) summariesByPlatform[platform] = [];
    summariesByPlatform[platform].push(summary);

    upsertDigest.run(
      range.dateStr, group.group_name, group.group_id, region, group.receiver_account,
      group.msg_count, JSON.stringify(keyPoints), JSON.stringify(followUp),
      groupOpenIssues.length, hasAlert ? 1 : 0, aiClient.PROMPT_VERSIONS.dailyDigest,
    );
  }

  // 按 CONCURRENCY 批量并发执行
  for (let i = 0; i < activeGroups.length; i += CONCURRENCY) {
    const batch = activeGroups.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(processGroup));
  }

  // ── Step 5 & 6: 格式化并在各个平台分别推送 ──
  for (const platform of Object.keys(summariesByPlatform)) {
    const pSummaries = summariesByPlatform[platform];
    const pSilentGroups = silentGroups.filter(
      (g) => (getRegionLabel(g.receiver_account).platform || 'wa') === platform
    );
    const pOpenIssues = openIssues.filter((i) =>
      pSummaries.some((s) => s.groupName === i.group_name)
    );

    // Identify all unique regions in this platform's data
    const allRegions = Array.from(new Set([
      ...pSummaries.map(s => s.region),
      ...pSilentGroups.map(g => getRegionLabel(g.receiver_account).region)
    ]));

    // Check which regions have specific webhooks configured
    const regionsWithHooks = allRegions.filter(r => dingtalk.hasRegionalWebhook('DIGEST', platform, r));

    // 1. Send Regional Digests for regions with specific webhooks
    for (const r of regionsWithHooks) {
      const rSummaries = pSummaries.filter(s => s.region === r);
      const rSilentGroups = pSilentGroups.filter(g => getRegionLabel(g.receiver_account).region === r);
      const rOpenIssues = pOpenIssues.filter(i => rSummaries.some(s => s.groupName === i.group_name));

      const digestText = formatDigest(rSummaries, rSilentGroups, range, rOpenIssues, platform);
      if (digestText) {
        const title = `📋 供应商群 ${range.dateStr} 日报 (${r}专区)`;
        await dingtalk.sendDigest({ title, content: digestText, platform, region: r });
        console.log(`[daily-digest] ✅ 平台 ${platform} | 区域 ${r} 专属日报推送完成`);
      }
    }

    // 2. Send Global/Platform Digest for the remaining regions
    const gSummaries = pSummaries.filter(s => !regionsWithHooks.includes(s.region));
    const gSilentGroups = pSilentGroups.filter(g => !regionsWithHooks.includes(getRegionLabel(g.receiver_account).region));
    const gOpenIssues = pOpenIssues.filter(i => gSummaries.some(s => s.groupName === i.group_name));

    if (gSummaries.length > 0 || gSilentGroups.length > 0) {
      const digestText = formatDigest(gSummaries, gSilentGroups, range, gOpenIssues, platform);
      if (digestText) {
        const title = `📋 供应商群 ${range.dateStr} 日报`;
        await dingtalk.sendDigest({ title, content: digestText, platform });
        console.log(`[daily-digest] ✅ 平台 ${platform} 聚合日报推送完成，覆盖${gSummaries.length}个群`);
      }
    } else {
      console.log(`[daily-digest] 平台 ${platform} 的剩余区域无活跃群，跳过聚合推送`);
    }
  }
}

// ─── 格式化 ───────────────────────────────────────────────────────
function formatDigest(summaries, silentGroups, range, allOpenIssues, platform) {
  if (summaries.length === 0 && silentGroups.length === 0) return null;

  const lines = [];
  const platformName = platform === 'tg' ? 'Telegram' : 'WhatsApp';

  lines.push(`## 📋 ${platformName} 供应商群消息汇总`);
  lines.push(`🕐 时间：${range.dateStr} 09:00 日报`);
  lines.push('');

  // 按区域分组输出
  const byRegion = {};
  for (const s of summaries) {
    if (!byRegion[s.region]) byRegion[s.region] = [];
    byRegion[s.region].push(s);
  }

  for (const [region, groups] of Object.entries(byRegion)) {
    for (const g of groups) {
      lines.push(`---`);
      lines.push(`### 🏢 ${g.displayName}（昨日 ${g.msgCount} 条）\n`);

      lines.push(`**📌 关键讨论**`);
      const keyPoints = Array.isArray(g.keyPoints) ? g.keyPoints : (typeof g.keyPoints === 'string' ? [g.keyPoints] : []);
      if (keyPoints.length > 0) {
        for (const pt of keyPoints) lines.push(`- ${pt}`);
      } else {
        lines.push(`- 无`);
      }
      lines.push('');

      lines.push(`**⚠️ 需关注**`);
      const followUps = Array.isArray(g.followUp) ? g.followUp : (typeof g.followUp === 'string' ? [g.followUp] : []);
      if (followUps.length > 0) {
        for (const f of followUps) lines.push(`- ${f}`);
      } else {
        lines.push(`- 无异常`);
      }
      lines.push('');

      lines.push(`**⏳ 未闭环事项**`);
      if (g.openIssues && g.openIssues.length > 0) {
        for (const issue of g.openIssues) {
          const t = formatTs(issue.opened_at);
          lines.push(`- [${t}] ${issue.issue_type}（持续未闭环）`);
          if (issue.commitment_text) {
            lines.push(`  > 供应商承诺：${issue.commitment_text.slice(0, 80)}`);
          }
        }
      } else {
        lines.push(`- 无`);
      }
      lines.push('');
    }
  }

  // 总汇统计
  const totalMsgs = summaries.reduce((s, g) => s + g.msgCount, 0);
  const newAlerts = summaries.filter((g) => g.hasAlert).length;
  const openCount = allOpenIssues.length;

  lines.push('---');
  lines.push(`**📊 昨日汇总**`);
  lines.push(`> 活跃群：${summaries.length} 个  \n> 总消息：${totalMsgs} 条  \n> 有告警群：${newAlerts} 个  \n> 未闭环问题：${openCount} 个`);
  lines.push('');

  // 区域分布
  const regionCounts = {};
  for (const s of summaries) {
    if (!regionCounts[s.region]) regionCounts[s.region] = { groups: 0, msgs: 0 };
    regionCounts[s.region].groups++;
    regionCounts[s.region].msgs += s.msgCount;
  }
  if (Object.keys(regionCounts).length > 0) {
    lines.push(`**🌍 区域分布**`);
    Object.entries(regionCounts).forEach(([r, c]) => {
      lines.push(`- **${r}**: ${c.groups} 个活跃群组  |  共 ${c.msgs} 条消息`);
    });
    lines.push('');
  }

  // 沉默群
  if (silentGroups.length > 0) {
    lines.push(`**⚠️ 沉默超 24h 群组**`);
    for (const g of silentGroups.slice(0, 5)) {
      const info = getRegionLabel(g.receiver_account);
      lines.push(`- ${info.region}-${g.group_name}（${g.silent_hours}h）`);
    }
    lines.push('');
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
