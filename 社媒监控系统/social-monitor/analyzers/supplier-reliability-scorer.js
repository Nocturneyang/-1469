/**
 * analyzers/supplier-reliability-scorer.js
 * 供应商可靠性评分周报 — 阶段B（维度4）
 *
 * 职责：
 *   1. 每周一 09:00 (Asia/Shanghai) 自动触发
 *   2. 汇总上周 issue_records 告警数据
 *   3. 剔除平均恢复时长指标，基于告警频次、承诺兑现率进行打分
 *   4. 推送至 DINGTALK_WEEKLY
 *   5. 写入 analytics.sqlite reliability_snapshots
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

const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

const insertSnapshot = analyticsDb.prepare(`
  INSERT INTO reliability_snapshots (
    week_start, group_name, region, business_sector, total_issues,
    commitment_rate, proactive_rate, reliability_score, still_open
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ─── 区域配置 ────────────────────────────────────────────────────
const accountConfig = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'account-regions.json'), 'utf8')
);
const REGION_MAP = Object.fromEntries(
  accountConfig.accounts.map((a) => [a.account, a])
);

function getRegionLabel(receiverAccount) {
  const info = REGION_MAP[receiverAccount];
  return info || { region: '未知区', business_sector: null, platform: 'wa' };
}

function getValueLabel(receiverAccount, groupName) {
  // 群级别覆盖优先
  if (groupName && accountConfig._group_overrides?.[groupName]?.value_label) {
    return accountConfig._group_overrides[groupName].value_label;
  }
  const info = REGION_MAP[receiverAccount];
  return (info && info.value_label) || 'L1';
}

// ─── 时间工具 ─────────────────────────────────────────────────────
function getLastWeekRange() {
  const now = new Date();
  const tzOffset = 8 * 60 * 60 * 1000; // UTC+8
  // 获取当前时间所在周的周一 00:00:00
  const localNow = new Date(now.getTime() + tzOffset);
  const day = localNow.getUTCDay() || 7; 
  const thisMonday = new Date(localNow.getTime() - (day - 1) * 86400000);
  thisMonday.setUTCHours(0, 0, 0, 0);
  
  const lastMonday = new Date(thisMonday.getTime() - 7 * 86400000);
  const lastSundayEnd = new Date(thisMonday.getTime() - 1);
  
  return {
    start: lastMonday.getTime() - tzOffset, // 转换回UTC时间戳
    end: lastSundayEnd.getTime() - tzOffset,
    dateStr: lastMonday.toISOString().split('T')[0], // YYYY-MM-DD
    displayStr: `${lastMonday.toISOString().split('T')[0]} 至 ${new Date(lastSundayEnd.getTime()).toISOString().split('T')[0]}`
  };
}

function calcReliabilityScore(stat) {
  // 基础分 100 分
  // 告警频次 (70%)：每次扣 15 分
  // 承诺兑现率 (30%)：如果不满 100%，扣除差额分 (最大扣30分)
  let score = 100;
  
  score -= (stat.total_issues * 15);
  
  if (stat.commitment_rate !== null) {
    const loss = (1 - stat.commitment_rate) * 30;
    score -= loss;
  }
  
  // 最低0分
  return Math.max(0, Math.round(score));
}

// ─── 核心生成逻辑 ────────────────────────────────────────────────
async function generateWeeklyReliabilityReport() {
  console.log('[supplier-scorer] 开始生成供应商周报...');
  const range = getLastWeekRange();

  const stats = analyticsDb.prepare(`
    SELECT
      ir.group_name,
      ir.region,
      MAX(ar.receiver_account) as receiver_account,
      COUNT(*) AS total_issues,
      SUM(CASE WHEN ir.commitment_met = 1 THEN 1 ELSE 0 END) * 1.0 /
        NULLIF(SUM(CASE WHEN ir.commitment_met IS NOT NULL THEN 1 ELSE 0 END), 0)
        AS commitment_rate,
      COUNT(CASE WHEN ir.status IN ('open', 'escalated') THEN 1 END) AS still_open
    FROM issue_records ir
    LEFT JOIN alert_records ar ON ir.alert_id = ar.id
    WHERE ir.opened_at BETWEEN ? AND ?
    GROUP BY ir.group_name
    ORDER BY total_issues DESC
  `).all(range.start, range.end);

  if (stats.length === 0) {
    console.log('[supplier-scorer] 上周无告警记录，跳过推送');
    return;
  }

  // 计算评分并分组
  const scoredByPlatform = {}; // { platform: [] }
  
  for (const s of stats) {
    const regionInfo = getRegionLabel(s.receiver_account);

    // L3 群不纳入周报评分
    const label = getValueLabel(s.receiver_account, s.group_name);
    if (label === 'L3') continue;

    const platform = regionInfo.platform || 'wa';

    s.score = calcReliabilityScore(s);
    s.proactive_rate = null; // 暂无计算逻辑，留空
    
    if (!scoredByPlatform[platform]) scoredByPlatform[platform] = [];
    scoredByPlatform[platform].push(s);
    
    // 写入快照库
    insertSnapshot.run(
      range.dateStr,
      s.group_name,
      s.region || regionInfo.region || '未知区',
      regionInfo.business_sector || null,
      s.total_issues,
      s.commitment_rate,
      s.proactive_rate,
      s.score,
      s.still_open
    );
  }

  for (const platform of Object.keys(scoredByPlatform)) {
    const pStats = scoredByPlatform[platform];
    
    // Check which regions have specific webhooks configured
    const allRegions = Array.from(new Set(pStats.map(s => s.region || '未知')));
    const regionsWithHooks = allRegions.filter(r => r !== '未知' && dingtalk.hasRegionalWebhook('WEEKLY', platform, r));

    // 1. Regional Weekly Reports
    for (const r of regionsWithHooks) {
      const rStats = pStats.filter(s => s.region === r).sort((a, b) => b.score - a.score);
      console.log(`[supplier-scorer] 正在为平台 ${platform} 区域 ${r} 生成 AI 洞察摘要...`);
      const aiInsight = await aiClient.analyzeWeeklyReliability(rStats, range.displayStr);
      const reportText = formatReport(rStats, range, aiInsight, r);
      await dingtalk.sendWeekly({
        title: `📊 供应商通道可靠性周报 (${r}专区) - ${range.displayStr}`,
        content: reportText,
        platform,
        region: r
      });
      console.log(`[supplier-scorer] ✅ 平台 ${platform} | 区域 ${r} 专属周报推送完成`);
    }

    // 2. Global/Platform Weekly Report for remaining regions
    const gStats = pStats.filter(s => !regionsWithHooks.includes(s.region || '未知')).sort((a, b) => b.score - a.score);
    if (gStats.length > 0) {
      console.log(`[supplier-scorer] 正在为平台 ${platform} 生成聚合 AI 洞察摘要...`);
      const aiInsight = await aiClient.analyzeWeeklyReliability(gStats, range.displayStr);
      const reportText = formatReport(gStats, range, aiInsight);
      await dingtalk.sendWeekly({
        title: `📊 供应商通道可靠性周报（${range.displayStr}）`,
        content: reportText,
        platform
      });
      console.log(`[supplier-scorer] ✅ 平台 ${platform} 聚合周报推送完成`);
    } else {
      console.log(`[supplier-scorer] 平台 ${platform} 的剩余区域无数据，跳过聚合推送`);
    }
  }
}

// ─── 格式化输出 ──────────────────────────────────────────────────
function formatReport(stats, range, aiInsight, regionName = null) {
  const lines = [];
  lines.push(`# 📊 供应商通道可靠性周报${regionName ? ` (${regionName}专区)` : ''}`);
  lines.push(`*统计周期：${range.displayStr}*`);
  lines.push(`---`);
  
  if (aiInsight) {
    lines.push(`**🤖 运营高管洞察 (AI)**`);
    lines.push(`> ${aiInsight.replace(/\n/g, '\n> ')}`);
    lines.push(`---`);
  }
  
  // 拆分为稳定和需关注
  const stable = stats.filter(s => s.score >= 80);
  const attention = stats.filter(s => s.score < 80);
  
  if (stable.length > 0) {
    lines.push('**🏆 优质稳定通道 (Top 5)**');
    stable.slice(0, 5).forEach((s, idx) => {
      const cr = s.commitment_rate !== null ? `${Math.round(s.commitment_rate * 100)}%` : '-';
      lines.push(`${idx + 1}. **${s.region || '未知'} | ${s.group_name}**`);
      lines.push(`   *评分:* <font color="#00a65a">**${s.score}**</font>  |  *告警:* ${s.total_issues}次  |  *兑现:* ${cr}`);
    });
    lines.push('');
  }
  
  if (attention.length > 0) {
    if (stable.length > 0) lines.push(`---`);
    lines.push('**⚠️ 需重点干预通道**');
    attention.forEach((s, idx) => {
      const cr = s.commitment_rate !== null ? `${Math.round(s.commitment_rate * 100)}%` : '-';
      lines.push(`${idx + 1}. **${s.region || '未知'} | ${s.group_name}**`);
      lines.push(`   - 📉 综合评分: <font color="#dd4b39">**${s.score}**</font>`);
      lines.push(`   - 🚨 告警频次: **${s.total_issues}** 次`);
      if (s.still_open > 0) {
        lines.push(`   - ⏳ 遗留未决: <font color="#f39c12">**${s.still_open}**</font> 个问题`);
      }
      if (s.commitment_rate !== null && s.commitment_rate < 1) {
        lines.push(`   - 🤝 承诺兑现: <font color="#dd4b39">**${cr}**</font> (未达标)`);
      }
    });
  }
  
  if (stable.length === 0 && attention.length === 0) {
    lines.push('🎉 本周各项通道运行平稳，无产生告警的通道。');
  }
  
  lines.push('');
  lines.push(`---`);
  lines.push(`**📝 指标说明与扣分规则**`);
  lines.push(`- **基础分**：满分 100 分。`);
  lines.push(`- **综合评分** = 基础分 - 告警频次扣分 - 承诺违约扣分。`);
  lines.push(`- **告警频次 (🚨)**：统计周期内，触发系统 P0/P1 级告警的次数。每发生 1 次扣 15 分。`);
  lines.push(`- **承诺兑现 (🤝)**：发生故障后，供应商给出的恢复承诺（如"will fix in 10 mins"）未按时达成的比例。未达标最高扣 30 分。`);
  lines.push(`- **遗留未决 (⏳)**：指到本周结算时，该通道仍未彻底闭环解决的历史故障告警数量。`);
  
  return lines.join('\n');
}

module.exports = {
  generateWeeklyReliabilityReport,
  formatReport,
};

if (require.main === module) {
  // ─── Cron 调度 ────────────────────────────────────────────────────
  // 每周一 09:00 Asia/Shanghai 触发
  cron.schedule('0 9 * * 1', async () => {
    try {
      await generateWeeklyReliabilityReport();
    } catch (err) {
      console.error('[supplier-scorer] 生成失败:', err.message);
    }
  }, { timezone: 'Asia/Shanghai' });

  console.log('[supplier-scorer] 已启动，定时任务：每周一 09:00 (Asia/Shanghai) 触发');

  // 支持命令行手动触发：node analyzers/supplier-reliability-scorer.js --now
  if (process.argv.includes('--now')) {
    console.log('[supplier-scorer] 手动触发...');
    generateWeeklyReliabilityReport().catch(console.error);
  }

  process.on('SIGINT', () => {
      console.log('[supplier-scorer] SIGINT 收到，正在优雅关闭...');
      try { analyticsDb.close(); } catch (_) {}
      process.exit(0);
  });
}
