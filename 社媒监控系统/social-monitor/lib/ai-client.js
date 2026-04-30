/**
 * lib/ai-client.js
 * AI 调用封装层（支持 OpenAI 兼容接口 / one-api 中转）
 *
 * 优先级：OpenAI 兼容接口（OPENAI_BASE_URL + OPENAI_API_KEY）→ Gemini → 纯关键词降级
 *
 * 关键环境变量：
 *   OPENAI_API_KEY    — API 密钥
 *   OPENAI_BASE_URL   — 接口地址，默认 https://api.openai.com/v1（支持 one-api 中转）
 *   OPENAI_MODEL      — 模型名称，默认 gpt-4o-mini（one-api 可填 openai/gpt-5.2 等）
 *   GEMINI_API_KEY    — Google Gemini 备用（若已配置则在 OpenAI 不可用时使用）
 *
 * 降级策略：
 *   供应商告警：AI 不可用时 P0/P1 仍按关键词推送，score 返回固定值
 *   每日日报：  AI 不可用时返回原始消息条数，不生成摘要
 */

'use strict';

require('dotenv').config();
const axios = require('axios');
const dingtalk = require('./dingtalk');

// ─── 读取配置 ────────────────────────────────────────────────────
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const MAX_MSGS_PER_CALL = 20;
const CIRCUIT_RESET_MS = 30 * 60 * 1000; // 30分钟后自动恢复

// Prompt 版本（修改 Prompt 时递增，写入 daily_digests.prompt_version）
const PROMPT_VERSIONS = {
  supplierAlert: 'v1.1',
  dailyDigest: 'v1.2',
  weeklyReliability: 'v1.0',
};

// ─── 熔断器 ──────────────────────────────────────────────────────
let circuitOpen = false;
let circuitOpenAt = 0;
let degradeNotified = false;

function isCircuitOpen() {
  if (!circuitOpen) return false;
  if (Date.now() - circuitOpenAt > CIRCUIT_RESET_MS) {
    circuitOpen = false;
    degradeNotified = false;
    console.log('[AI] 熔断器自动重置，恢复 AI 调用');
    return false;
  }
  return true;
}

async function openCircuit(reason) {
  circuitOpen = true;
  circuitOpenAt = Date.now();
  console.warn('[AI] 熔断器开启 →', reason);
  if (!degradeNotified) {
    degradeNotified = true;
    await dingtalk.sendAlert({
      title: '[系统] AI 调用降级通知',
      content: [
        '### ⚠️ AI 调用降级通知',
        '',
        `**原因：** ${reason}`,
        `**当前模式：** 纯关键词匹配（降级）`,
        `**自动恢复：** 30分钟后重试`,
        `**时间：** ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
      ].join('\n'),
    }).catch(() => { });   // 降级通知本身失败不抛出
  }
}

// ─── OpenAI 兼容接口调用（支持 one-api / 自建中转）───────────────
async function callOpenAICompat(prompt) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 未配置');

  const url = `${OPENAI_BASE_URL}/chat/completions`;
  const res = await axios.post(
    url,
    {
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 600,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 25000,
    }
  );

  return res.data.choices[0].message.content.trim();
}

// ─── Gemini 直连（可选备用）──────────────────────────────────────
async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 未配置');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await axios.post(
    url,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
  );

  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// ─── 统一调用入口 ─────────────────────────────────────────────────
/**
 * 调用 AI：OpenAI兼容接口 → Gemini → 降级
 * @param {string} prompt
 * @returns {Promise<string>}
 * @throws {'AI_DEGRADED'} 当熔断器开启或均不可用时
 */
async function callAI(prompt) {
  if (isCircuitOpen()) throw new Error('AI_DEGRADED');

  // ① 尝试 OpenAI 兼容接口
  if (OPENAI_API_KEY) {
    try {
      const text = await callOpenAICompat(prompt);
      return text;
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 || status === 402 || status === 503) {
        await openCircuit(`OpenAI 兼容接口 HTTP ${status}`);
        throw new Error('AI_DEGRADED');
      }
      console.warn(`[AI] OpenAI 兼容接口失败 (${status || err.code || err.message})，尝试 Gemini...`);
    }
  }

  // ② 尝试 Gemini 直连
  if (GEMINI_API_KEY) {
    try {
      return await callGemini(prompt);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 || status === 402) {
        await openCircuit(`Gemini HTTP ${status}`);
        throw new Error('AI_DEGRADED');
      }
      console.warn('[AI] Gemini 也失败:', err.message);
    }
  }

  // ③ 均不可用
  throw new Error('AI_DEGRADED');
}

// ─── JSON 提取 ────────────────────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { } }
  return null;
}

// ─── 供应商告警 Prompt ────────────────────────────────────────────
/**
 * @returns {Promise<{score,title,type,commitment,action}|null>}
 */
async function analyzeAlertMessages(displayName, groupType, msgs, senderNames) {
  const limited = msgs.slice(0, MAX_MSGS_PER_CALL);
  const messagesBlock = limited.map(m => {
    const t = new Date(m.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const prompt =
    `你是ITNIO短信平台的运营风控引擎。以下是【${displayName}】在过去5分钟的消息：

---
${messagesBlock}
---

群类型：${groupType} | 主要外部联系人：${senderNames.join(', ')}

请判断：
1. 是否存在通道故障/成功率跌零/SID配置问题/内容被屏蔽的信号？（0-10分）
2. 若评分 >= 7，输出30字内告警标题（英文内容中文输出）。
3. 问题类型：通道故障/成功率告警/内容过滤/SID变更/无异常（选一）。
4. 供应商是否有明确承诺？提取承诺原文（无则为null）。
5. 下一步建议（1句话）。

严格JSON输出，不含其他文字：
{"score":8,"title":"菲律宾Smart OTP投递率跌零","type":"成功率告警","commitment":"will fix in 30 mins","action":"检查SID 8100385配置，30分钟后确认是否恢复"}`;

  try {
    const text = await callAI(prompt);
    const result = extractJSON(text);
    if (!result) { console.warn('[AI] 无法解析JSON:', text.slice(0, 200)); return null; }
    return result;
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeAlertMessages 出错:', err.message);
    return null;
  }
}

// ─── 日报 Prompt ─────────────────────────────────────────────────
/**
 * @returns {Promise<{keyPoints,followUp,hasAlert}|null>}
 */
async function analyzeDailyDigest(displayName, messagesContent, openIssues = []) {
  const openIssuesList = openIssues.length > 0
    ? openIssues.map(i => {
      const t = new Date(i.opened_at).toLocaleTimeString('zh-CN',
        { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
      return `- ${t} ${i.issue_type}（持续中）${i.commitment_text ? ` | 承诺："${i.commitment_text}"` : ''}`;
    }).join('\n')
    : '（无）';

  const prompt =
    `你是ITNIO短信平台运营助手，生成【${displayName}】昨日汇总。

昨日消息（已过滤内部账号）：
---
${messagesContent.slice(0, 3000)}
---

昨日未关闭问题（若有）：
${openIssuesList}

请输出：
1. 关键讨论（数组，最多5条，每条20字内，只写外部联系人发起的话题）
2. 需关注事项（数组，有问题写问题，无问题写 ["运营正常"]）
3. 是否有未解决的告警信号（true/false）

严格JSON输出，不含其他文字：
{"keyPoints":["Dexter确认Smart OTP通道正常"],"followUp":["有2条投递回执追踪消息，建议确认"],"hasAlert":false}`;

  try {
    const text = await callAI(prompt);
    const result = extractJSON(text);
    return result || null;
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeDailyDigest 出错:', err.message);
    return null;
  }
}

// ─── 供应商周报分析 Prompt ───────────────────────────────────────
/**
 * @param {Array} stats 供应商统计数据数组
 * @param {string} rangeStr 周期字符串
 * @returns {Promise<string|null>} AI生成的周报评语
 */
async function analyzeWeeklyReliability(stats, rangeStr) {
  if (!stats || stats.length === 0) return null;
  
  const statsText = stats.map(s => {
    const cr = s.commitment_rate !== null ? `${Math.round(s.commitment_rate * 100)}%` : '无承诺';
    return `- ${s.region || '未知'}-${s.group_name}: 综合评分 ${s.score}, 告警次数 ${s.total_issues}, 未决问题 ${s.still_open}, 承诺兑现率 ${cr}`;
  }).join('\n');

  const prompt = `你是ITNIO短信平台的资深通道管理专家。请根据以下通道供应商本周（${rangeStr}）的客观统计数据，生成一份简短的高管级分析洞察摘要（150字左右）。

数据列表（包含区域、群组名、综合评分、告警次数、遗留未决问题数、承诺兑现率）：
${statsText}

要求：
1. 请务必使用 **换行、分段或列表（如 1. 2. 3.）** 的形式排版，绝不能输出一整块密集的纯文本！
2. 核心结论：直奔主题指出整体盘面情况，点名表现最好和表现最差（跌破80分/频繁告警）的通道。
3. 运营建议：单独换行，给出1-2个针对性的干预建议（如约谈、停流、观察等），以“💡 建议：”开头。
4. 语气专业客观，不要包裹在 \`\`\`markdown 代码块中，直接输出排版好的文本。`;

  try {
    const text = await callAI(prompt);
    return text ? text.trim() : null;
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeWeeklyReliability 出错:', err.message);
    return null;
  }
}

// ─── 导出 ────────────────────────────────────────────────────────
module.exports = {
  callAI,
  analyzeAlertMessages,
  analyzeDailyDigest,
  analyzeWeeklyReliability,
  extractJSON,
  PROMPT_VERSIONS,
  isCircuitOpen: () => circuitOpen,
  // 运行时可读的配置信息（用于 UI 展示）
  getConfig: () => ({
    baseUrl: OPENAI_BASE_URL,
    model: OPENAI_MODEL,
    hasKey: !!OPENAI_API_KEY,
    hasGemini: !!GEMINI_API_KEY,
  }),
};
