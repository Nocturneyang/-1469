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
const { formatShanghai } = require('./time');

// ─── 读取配置 ────────────────────────────────────────────────────
// 支持 OPENAI_* 和 ANTHROPIC_* 两种命名，OPENAI_* 优先（.env文件配置）
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

// 分层模型配置（按场景选择最佳性价比模型）
//   FAST    — 高频轻量（供应商告警 / 内容审核 / 模板提取），追求低成本和低延迟
//   DEFAULT — 中等任务（QA 提取 / 设备知识 / 上下文校验），中文业务判断稳定
//   PRO     — 低频高质量长文默认档；具体日报/周报/画像可用场景变量覆盖
const OPENAI_MODEL_DEFAULT =
  process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro';
const OPENAI_MODEL_FAST =
  process.env.OPENAI_MODEL_FAST || 'deepseek-v4-flash';
const OPENAI_MODEL_PRO =
  process.env.OPENAI_MODEL_PRO || 'claude-sonnet-4.5';

// 场景级默认模型。未配置时使用当前 OneAPI 定价页中更适合该任务的模型。
const ALERT_AI_MODEL =
  process.env.ALERT_AI_MODEL || 'deepseek-v4-flash';
const EXTRACTION_AI_MODEL =
  process.env.EXTRACTION_AI_MODEL || 'deepseek-v4-flash';
const KNOWLEDGE_AI_MODEL =
  process.env.KNOWLEDGE_AI_MODEL || OPENAI_MODEL_DEFAULT;
const DAILY_DIGEST_AI_MODEL =
  process.env.DAILY_DIGEST_AI_MODEL || OPENAI_MODEL_DEFAULT;
const WEEKLY_RELIABILITY_AI_MODEL =
  process.env.WEEKLY_RELIABILITY_AI_MODEL || 'claude-sonnet-4.5';
const SUPPLIER_PROFILE_AI_MODEL =
  process.env.SUPPLIER_PROFILE_AI_MODEL || OPENAI_MODEL_DEFAULT;
const DOMAIN_INTELLIGENCE_AI_MODEL =
  process.env.DOMAIN_INTELLIGENCE_AI_MODEL || EXTRACTION_AI_MODEL;
// 兼容旧引用
const OPENAI_MODEL = OPENAI_MODEL_DEFAULT;

function pickModel(tier) {
  if (tier === 'fast') return OPENAI_MODEL_FAST;
  if (tier === 'pro') return OPENAI_MODEL_PRO;
  return OPENAI_MODEL_DEFAULT;
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const MAX_MSGS_PER_CALL = 20;
const CIRCUIT_RESET_MS = 30 * 60 * 1000; // 30分钟后自动恢复

// Prompt 版本（修改 Prompt 时递增，写入 daily_digests.prompt_version）
const PROMPT_VERSIONS = {
  supplierAlert: 'v1.1',
  dailyDigest: 'v1.2',
  weeklyReliability: 'v1.0',
  supplierProfile: 'v1.1',
  domainIntelligence: 'v1.0',
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
        `**时间：** ${formatShanghai()}`,
      ].join('\n'),
    }).catch(() => { });   // 降级通知本身失败不抛出
  }
}

// ─── OpenAI 兼容接口调用（支持 one-api / 自建中转）───────────────
async function callOpenAICompat(prompt, model, maxTokens = 16384, systemMessage = null, timeoutMs = 25000) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 未配置');

  const url = `${OPENAI_BASE_URL}/chat/completions`;
  const messages = systemMessage
    ? [{ role: 'system', content: systemMessage }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];

  const res = await axios.post(
    url,
    {
      model: model || OPENAI_MODEL_DEFAULT,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    }
  );

  if (!res.data?.choices?.[0]?.message?.content) {
    throw new Error('Invalid API response: missing choices or content');
  }

  return res.data.choices[0].message.content.trim();
}

// ─── Gemini 通过 one-api 中转（备用）────────────────────────────────
async function callGemini(prompt, timeoutMs = 25000) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 未配置');

  const url = `${OPENAI_BASE_URL}/chat/completions`;
  const res = await axios.post(
    url,
    {
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 16384,
    },
    {
      headers: {
        Authorization: `Bearer ${GEMINI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
    }
  );

  if (!res.data?.choices?.[0]?.message?.content) {
    throw new Error('Invalid Gemini API response: missing choices or content');
  }

  return res.data.choices[0].message.content.trim();
}

// ─── 统一调用入口 ─────────────────────────────────────────────────
/**
 * 调用 AI：OpenAI兼容接口 → Gemini → 降级
 * @param {string} prompt
 * @param {{tier?: 'fast'|'default'|'pro', model?: string}} [options]
 * @returns {Promise<string>}
 * @throws {'AI_DEGRADED'} 当熔断器开启或均不可用时
 */
async function callAI(prompt, options = {}) {
  if (isCircuitOpen()) throw new Error('AI_DEGRADED');

  const model = options.model || pickModel(options.tier);
  const maxTokens = options.maxTokens;
  const systemMessage = options.systemMessage || null;
  const timeoutMs = options.timeoutMs || 25000;

  // ① 尝试 OpenAI 兼容接口
  if (OPENAI_API_KEY) {
    try {
      const text = await callOpenAICompat(prompt, model, maxTokens, systemMessage, timeoutMs);
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

  // ② 尝试 Gemini 直连（不分层，所有 tier 共用同一 Gemini 备份）
  if (GEMINI_API_KEY) {
    try {
      return await callGemini(prompt, timeoutMs);
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
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // 先尝试直接解析
  try { return JSON.parse(raw); } catch { }

  // 使用字符串感知的平衡括号匹配，避免 JSON 字符串内的 { } 干扰
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const jsonStr = raw.slice(start, i + 1);
        try { return JSON.parse(jsonStr); } catch { }
      }
    }
  }

  // 降级：尝试匹配第一个完整的 JSON 对象
  const m = raw.match(/\{[\s\S]*?\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { } }
  return null;
}

function sampleText(text, maxChars) {
  const value = String(text || '').trim();
  if (!value || value.length <= maxChars) return value;
  const chunk = Math.floor((maxChars - 80) / 3);
  if (chunk <= 0) return value.slice(0, maxChars);
  const head = value.slice(0, chunk);
  const midStart = Math.max(0, Math.floor(value.length / 2) - Math.floor(chunk / 2));
  const middle = value.slice(midStart, midStart + chunk);
  const tail = value.slice(-chunk);
  return [
    head,
    '\n...[中段采样]...\n',
    middle,
    '\n...[末段采样]...\n',
    tail
  ].join('').slice(0, maxChars);
}

function sampleArrayEvenly(items, maxItems) {
  if (!Array.isArray(items) || items.length <= maxItems) return items || [];
  if (maxItems <= 1) return items.slice(0, maxItems);
  const result = [];
  const last = items.length - 1;
  for (let i = 0; i < maxItems; i += 1) {
    result.push(items[Math.round((i * last) / (maxItems - 1))]);
  }
  return result;
}

// ─── 供应商告警 Prompt ────────────────────────────────────────────
/**
 * @returns {Promise<{score,title,type,commitment,action}|null>}
 */
async function analyzeAlertMessages(displayName, groupType, msgs, senderNames, contextAnchor) {
  const limited = msgs.slice(0, MAX_MSGS_PER_CALL);
  const messagesBlock = limited.map(m => {
    const t = formatShanghai(m.timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const contextBlock = contextAnchor && contextAnchor.length > 0
    ? contextAnchor.map(m => {
        const t = formatShanghai(m.timestamp, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return `[${t}] ${m.sender_name}: ${m.content}`;
      }).join('\n')
    : '（无上文）';

  const prompt =
    `你是ITNIO短信平台的运营风控引擎。请判断【${displayName}】过去5分钟是否出现新的供应商告警。

【窗口前文（对话背景）】：
---
${contextBlock}
---

【窗口内消息（需分析）】：
---
${messagesBlock}
---

群类型：${groupType} | 主要外部联系人：${senderNames.join(', ')}

判定规则：
- 只判断“窗口内新出现或明显升级”的问题；前文已存在且无升级则降分。
- 告警信号包括：通道故障、成功率/投递率跌零、SID配置异常、内容被屏蔽、供应商承诺修复。
- score 为 0-10；score < 7 时 type 必须为"无异常"，title/action 为空字符串，commitment 为 null。
- type 只能是：通道故障/成功率告警/内容过滤/SID变更/无异常。
- title ≤ 30字，action ≤ 35字；commitment 只提取供应商原文承诺，无则 null。

只输出以下 JSON，不要输出解释、markdown 或额外字段：
{"score":8,"title":"菲律宾Smart OTP投递率跌零","type":"成功率告警","commitment":"will fix in 30 mins","action":"30分钟后复查投递率并确认SID配置"}`;

  try {
    const text = await callAI(prompt, {
      tier: 'fast',
      model: ALERT_AI_MODEL,
      systemMessage: 'You are a JSON-only API. Output ONLY valid JSON, no explanations, no thinking process, no markdown. Start with { and end with }.'
    });
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
async function analyzeDailyDigest(displayName, messagesContent, openIssues = [], internalContent = '') {
  const openIssuesList = openIssues.length > 0
    ? openIssues.map(i => {
      const t = formatShanghai(i.opened_at, { hour: '2-digit', minute: '2-digit' });
      return `- ${t} ${i.issue_type}（持续中）${i.commitment_text ? ` | 承诺："${i.commitment_text}"` : ''}`;
    }).join('\n')
    : '（无）';

  const internalBlock = internalContent
    ? `\n我方运营回复（内部方案参考，不要作为外部讨论输出）：\n---\n${sampleText(internalContent, 1200)}\n---\n`
    : '';

  const prompt =
    `你是ITNIO短信平台运营助手，生成【${displayName}】昨日汇总。

昨日外部消息（已过滤内部账号）：
---
${sampleText(messagesContent, 3000)}
---
${internalBlock}
昨日未关闭问题（若有）：
${openIssuesList}

请输出：
1. keyPoints: 关键讨论（数组，最多5条，每条20字内，只写外部联系人发起的话题）
2. followUp: 需关注事项（数组，有问题写问题，无问题写 ["运营正常"]）
3. hasAlert: 是否有未解决的告警信号（true/false）
4. solutions: 我方方案摘要（数组，从我方运营回复中提取，每条25字内，无则空数组）

【重要】直接输出JSON，不要输出任何思考过程、解释文字或markdown标记。JSON必须完整且格式正确：
{"keyPoints":["Dexter确认Smart OTP通道正常"],"followUp":["有2条投递回执追踪消息，建议确认"],"hasAlert":false,"solutions":["建议客户切换至MKT通道测试OTP送达"]}`;

  try {
    const text = await callAI(prompt, {
      tier: 'pro',
      model: DAILY_DIGEST_AI_MODEL,
      systemMessage: 'You are a JSON-only API. Output ONLY valid JSON, no explanations, no thinking process, no markdown. Start with { and end with }.'
    });
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

  const prompt = `你是ITNIO短信平台的资深通道管理专家。请根据以下通道供应商本周（${rangeStr}）的客观统计数据，生成一份适合管理层阅读的简短周报洞察（150字左右）。

数据列表（包含区域、群组名、综合评分、告警次数、遗留未决问题数、承诺兑现率）：
${statsText}

要求：
1. 使用 2-3 个短段落或编号列表，避免整块长文。
2. 第一段给整体盘面判断，必须点名表现最好和风险最高的通道。
3. 第二段给 1-2 条运营建议，建议要可执行，如约谈、停流、观察、复盘。
4. 只基于数据判断，不编造未提供的供应商背景。
5. 不要输出 markdown 代码块，直接输出排版好的中文文本。`;

  try {
    const text = await callAI(prompt, {
      tier: 'pro',
      model: WEEKLY_RELIABILITY_AI_MODEL,
      maxTokens: envNumber('WEEKLY_RELIABILITY_AI_MAX_TOKENS', 900),
      timeoutMs: envNumber('WEEKLY_RELIABILITY_AI_TIMEOUT_MS', 60000),
    });
    return text ? text.trim() : null;
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeWeeklyReliability 出错:', err.message);
    return null;
  }
}

// ─── 内容审核判定 Prompt ─────────────────────────────────────────
/**
 * AI 判定供应商对内容审核请求的回复：通过/拒绝/待定
 * @returns {Promise<{approved:boolean|null,confidence:number,reason:string}|null>}
 */
async function analyzeContentReview(submitterName, contentSubmitted, reviewerReply) {
  const prompt =
    `你是ITNIO短信平台的内容审核判定引擎。只判断供应商是否批准本次内容发送。

ITNIO运营人员（${submitterName}）向供应商发送了内容审核请求：
---
${contentSubmitted.slice(0, 800)}
---

供应商回复：
---
${reviewerReply.slice(0, 500)}
---

规则：
- 明确同意：ok/approved/可以发送/no problem/pass 等 → approved=true。
- 明确拒绝或要求修改：reject/cannot/blocked/not allowed/需修改 等 → approved=false。
- 仅确认收到、追问技术信息、语义不清 → approved=null。
- confidence 为 0-1；reason ≤ 24字，只写判定依据。

只输出以下 JSON，不要输出解释、markdown 或额外字段：
{"approved":true,"confidence":0.95,"reason":"供应商明确同意发送"}`;

  try {
    const text = await callAI(prompt, {
      tier: 'fast',
      model: EXTRACTION_AI_MODEL,
      systemMessage: 'You are a JSON-only API. Output ONLY valid JSON, no explanations, no thinking process, no markdown. Start with { and end with }.'
    });
    const result = extractJSON(text);
    if (!result) return null;
    return {
      approved: typeof result.approved === 'boolean' ? result.approved : null,
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
      reason: result.reason || '',
    };
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeContentReview 出错:', err.message);
    return null;
  }
}

// ─── QA 知识提取 Prompt ──────────────────────────────────────────
/**
 * 从已闭环的问题对话中提取 QA 知识对
 * @param {string} displayName 群组显示名
 * @param {string} sector 业务板块
 * @param {Array} messages 完整对话窗口消息
 * @param {string} resolutionSummary 闭环方式简述
 * @returns {Promise<{question_type:string,question_summary:string,question_keywords:string,answer_steps:string[],answer_category:string}|null>}
 */
async function analyzeIssueToQA(displayName, sector, messages, resolutionSummary) {
  const conversation = messages.map(m => {
    const t = formatShanghai(m.timestamp, { hour: '2-digit', minute: '2-digit' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const prompt =
    `你是ITNIO的知识管理引擎。请从已闭环对话中提取可复用 QA 知识，只抽取对话中明确出现的信息。

业务板块：${sector}
群组：${displayName}
闭环方式：${resolutionSummary}

完整对话：
---
${sampleText(conversation, 3000)}
---

字段要求：
- question_type ≤ 10字。
- question_summary ≤ 30字，描述问题现象。
- question_keywords 3-5个，逗号分隔，中英文均可。
- answer_steps 1-5步，每步≤28字；不要编造未出现的操作。
- answer_category 只能是：配置修改/重启/更换硬件/联系运营商/等待恢复/内容调整/其他。

只输出以下 JSON，不要输出解释、markdown 或额外字段：
{"question_type":"设备无法连接","question_summary":"GOIP设备端口断开无法连接","question_keywords":"disconnect,port,无法连接,goip","answer_steps":["检查网络和端口配置","重启设备","Anydesk远程排查"],"answer_category":"重启"}`;

  try {
    const text = await callAI(prompt, {
      tier: 'default',
      model: KNOWLEDGE_AI_MODEL,
      systemMessage: 'You are a JSON-only API. Output ONLY valid JSON, no explanations, no thinking process, no markdown. Start with { and end with }.'
    });
    const result = extractJSON(text);
    if (!result) return null;
    return {
      question_type: result.question_type || '',
      question_summary: result.question_summary || '',
      question_keywords: result.question_keywords || '',
      answer_steps: Array.isArray(result.answer_steps) ? result.answer_steps : [],
      answer_category: result.answer_category || '',
    };
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeIssueToQA 出错:', err.message);
    return null;
  }
}

// ─── 设备知识图谱提取 Prompt ─────────────────────────────────────
/**
 * 从设备供应商闭环对话中提取设备故障知识
 * @returns {Promise<{device_model:string,device_type:string,fault_symptom:string,fault_category:string,solution_steps:string[]}|null>}
 */
async function analyzeDeviceKnowledge(displayName, messages) {
  const conversation = messages.map(m => {
    const t = formatShanghai(m.timestamp, { hour: '2-digit', minute: '2-digit' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const prompt =
    `你是ITNIO的设备知识管理引擎。请从设备供应商闭环对话中提取设备故障知识，只抽取明确出现的信息。

群组：${displayName}

完整对话：
---
${sampleText(conversation, 2600)}
---

字段要求：
- device_model 无明确型号填"未知设备"。
- device_type 只能是：goip/modem/SIM box/gateway/其他。
- fault_symptom ≤ 30字。
- fault_category 只能是：配置/硬件/网络/SIM/IMEI/端口/其他。
- solution_steps 1-5步，每步≤28字；不要补充对话外方案。

只输出以下 JSON，不要输出解释、markdown 或额外字段：
{"device_model":"RFH0606938SM","device_type":"goip","fault_symptom":"模块4-8不工作，端口无法连接","fault_category":"硬件","solution_steps":["检查模块供电和连接线","拆卸模块重新安装","更换故障模块"]}`;

  try {
    const text = await callAI(prompt, {
      tier: 'default',
      model: KNOWLEDGE_AI_MODEL,
      systemMessage: 'You are a JSON-only API. Output ONLY valid JSON, no explanations, no thinking process, no markdown. Start with { and end with }.'
    });
    const result = extractJSON(text);
    if (!result) return null;
    return {
      device_model: result.device_model || '未知设备',
      device_type: result.device_type || '',
      fault_symptom: result.fault_symptom || '',
      fault_category: result.fault_category || '',
      solution_steps: Array.isArray(result.solution_steps) ? result.solution_steps : [],
    };
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeDeviceKnowledge 出错:', err.message);
    return null;
  }
}

// ─── 内容模板提取 Prompt ───────────────────────────────────────
/**
 * 从客服群的审核对话中提取短信内容模板
 * @returns {Promise<{customer_name:string,template_content:string,template_type:string,target_region:string,target_operator:string,review_result:string,compliance_notes:string}|null>}
 */
async function analyzeContentTemplate(displayName, messages, reviewVerdict) {
  const conversation = messages.map(m => {
    const t = formatShanghai(m.timestamp, { hour: '2-digit', minute: '2-digit' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const prompt =
    `你是ITNIO的短信模板管理引擎。请从客服审核对话中提取短信模板信息，只抽取明确出现的信息。

群组：${displayName}
审核结果：${reviewVerdict}

完整对话：
---
${sampleText(conversation, 2600)}
---

字段要求：
- customer_name 无明确客户名填空字符串。
- template_content ≤ 45字，概括短信核心内容，不要粘贴长原文。
- template_type 只能是：OTP验证码/Marketing营销/Notification通知/其他。
- target_region 无明确地区填空字符串。
- target_operator 无明确运营商填 null。
- review_result 只能是：approved/rejected/modified。
- compliance_notes ≤ 28字，无明确备注填空字符串。

只输出以下 JSON，不要输出解释、markdown 或额外字段：
{"customer_name":"Onbuka","template_content":"OTP验证码6位数字，有效期5分钟","template_type":"OTP验证码","target_region":"菲律宾","target_operator":"Globe","review_result":"approved","compliance_notes":"需使用直连通道，避免公共通道"}`;

  try {
    const text = await callAI(prompt, {
      tier: 'fast',
      model: EXTRACTION_AI_MODEL,
      systemMessage: 'You are a JSON-only API. Output ONLY valid JSON, no explanations, no thinking process, no markdown. Start with { and end with }.'
    });
    const result = extractJSON(text);
    if (!result) return null;
    return {
      customer_name: result.customer_name || '',
      template_content: result.template_content || '',
      template_type: result.template_type || '',
      target_region: result.target_region || '',
      target_operator: result.target_operator || '',
      review_result: result.review_result || reviewVerdict,
      compliance_notes: result.compliance_notes || '',
    };
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeContentTemplate 出错:', err.message);
    return null;
  }
}

// ─── 供应商画像 NLP 分析 Prompt ──────────────────────────────────
/**
 * 从供应商群近30天消息中提取定性画像指标
 * @param {string} groupName 群名
 * @param {string} sector 业务板块
 * @param {Array} messages 近30天消息摘要（sender+content截断）
 * @param {object} stats 已有定量指标 {total_issues, open_issues, commitment_rate, recurrence_rate, avg_response_mins}
 * @returns {Promise<object|null>}
 */
async function analyzeSupplierProfile(groupName, sector, messages, stats) {
  // 构造首中尾均衡的消息样本，避免活跃群只分析到某一段时间
  const sample = sampleArrayEvenly(
    messages.filter(m => m.content && m.content.length > 20),
    20
  )
    .map(m => {
      const t = formatShanghai(m.timestamp, { year: 'numeric', month: '2-digit', day: '2-digit' });
      return `[${t}] ${m.sender_name}: ${m.content.slice(0, 160)}`;
    })
    .join('\n');

  if (!sample.trim()) return null;

  const prompt =
    `你是ITNIO短信平台的供应商关系分析引擎。请根据【${groupName}】的消息样本和定量指标，生成轻量供应商画像。

业务板块：${sector}
已有定量指标：
- 总告警次数：${stats.total_issues || 0}
- 未闭环问题：${stats.open_issues || 0}
- 承诺兑现率：${stats.commitment_rate != null ? Math.round(stats.commitment_rate * 100) + '%' : '无数据'}
- 问题复发率：${stats.recurrence_rate != null ? Math.round(stats.recurrence_rate * 100) + '%' : '无数据'}
- 平均响应：${stats.avg_response_mins != null ? stats.avg_response_mins.toFixed(0) + 'min' : '无数据'}

近30天消息样本：
---
${sampleText(sample, 2600)}
---

输出规则：
- 只基于样本和定量指标判断；证据不足时填 null 或保守评分，不要编造联系人/比例。
- attitude_tags 选 2-4 个，候选：配合积极/敷衍拖沓/推诿责任/主动预警/被动响应/传话筒型客服/技术兜底强/英文主导/中文主导/周末响应盲区/长尾响应慢/消极怠工迹象/沟通回合长/专业高效。
- insight_tags 选 2-4 个，候选：周末响应盲区/问题易复发/沟通回合长/故障高频/传话筒型客服/技术兜底弱/技术兜底强/南亚通道不稳/运行平稳/工作日响应极快/主动预警意识弱/首问解决率高/维护规范。
- insight_summary ≤ 80字，直接说明优点、风险和建议关注点。
- sub_scores 四项必须完整，0-100整数；无法从样本判断时结合定量指标保守估计。
- avg_turns、fcr、tech_contact、tech_reply_rate、planned_maintenance_pct 只有证据明确时填写，否则填 null。

只输出以下 JSON，不要输出解释、markdown 或额外字段：
{"attitude_tags":["被动响应","英文主导"],"insight_tags":["故障高频","技术兜底弱"],"insight_summary":"该供应商响应偏被动，故障讨论较多，需关注长尾响应和技术兜底质量。","sub_scores":{"主动上报与预警":30,"首问解决率FCR":45,"技术配合态度":60,"计划内变更占比":50},"avg_turns":null,"fcr":null,"tech_contact":null,"tech_reply_rate":null,"planned_maintenance_pct":null}`;

  try {
    const text = await callAI(prompt, {
      tier: process.env.SUPPLIER_PROFILE_AI_TIER || 'default',
      model: SUPPLIER_PROFILE_AI_MODEL,
      maxTokens: envNumber('SUPPLIER_PROFILE_AI_MAX_TOKENS', 1200),
      timeoutMs: envNumber('SUPPLIER_PROFILE_AI_TIMEOUT_MS', 60000),
      systemMessage: 'You are a JSON-only API. Output ONLY valid JSON, no explanations, no thinking process, no markdown. Start with { and end with }.'
    });
    const result = extractJSON(text);
    if (!result) { console.warn('[AI] analyzeSupplierProfile JSON解析失败:', text?.slice(0, 150)); return null; }
    // 规范化：确保数组/对象字段类型正确
    return {
      attitude_tags: Array.isArray(result.attitude_tags) ? result.attitude_tags : [],
      insight_tags: Array.isArray(result.insight_tags) ? result.insight_tags : [],
      insight_summary: typeof result.insight_summary === 'string' ? result.insight_summary : '',
      sub_scores: result.sub_scores && typeof result.sub_scores === 'object' ? {
        '主动上报与预警': result.sub_scores['主动上报与预警'] ?? null,
        '首问解决率FCR': result.sub_scores['首问解决率FCR'] ?? null,
        '技术配合态度': result.sub_scores['技术配合态度'] ?? null,
        '计划内变更占比': result.sub_scores['计划内变更占比'] ?? null,
      } : null,
      avg_turns: typeof result.avg_turns === 'number' ? result.avg_turns : null,
      fcr: typeof result.fcr === 'number' ? result.fcr : null,
      tech_contact: result.tech_contact || null,
      tech_reply_rate: typeof result.tech_reply_rate === 'number' ? result.tech_reply_rate : null,
      planned_maintenance_pct: typeof result.planned_maintenance_pct === 'number' ? result.planned_maintenance_pct : null,
    };
  } catch (err) {
    if (err.message === 'AI_DEGRADED') return null;
    console.error('[AI] analyzeSupplierProfile 出错:', err.message);
    return null;
  }
}

// ─── 导出 ────────────────────────────────────────────────────────
module.exports = {
  callAI,
  analyzeAlertMessages,
  analyzeDailyDigest,
  analyzeWeeklyReliability,
  analyzeContentReview,
  analyzeIssueToQA,
  analyzeDeviceKnowledge,
  analyzeContentTemplate,
  analyzeSupplierProfile,
  extractJSON,
  PROMPT_VERSIONS,
  isCircuitOpen: () => circuitOpen,
  // 运行时可读的配置信息（用于 UI 展示）
  getConfig: () => ({
    baseUrl: OPENAI_BASE_URL,
    model: OPENAI_MODEL_DEFAULT,
    modelFast: OPENAI_MODEL_FAST,
    modelPro: OPENAI_MODEL_PRO,
    alertModel: ALERT_AI_MODEL,
    extractionModel: EXTRACTION_AI_MODEL,
    knowledgeModel: KNOWLEDGE_AI_MODEL,
    dailyDigestModel: DAILY_DIGEST_AI_MODEL,
    weeklyReliabilityModel: WEEKLY_RELIABILITY_AI_MODEL,
    supplierProfileModel: SUPPLIER_PROFILE_AI_MODEL,
    domainIntelligenceModel: DOMAIN_INTELLIGENCE_AI_MODEL,
    hasKey: !!OPENAI_API_KEY,
    hasGemini: !!GEMINI_API_KEY,
  }),
};
