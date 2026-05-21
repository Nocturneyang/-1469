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
// 支持 OPENAI_* 和 ANTHROPIC_* 两种命名，OPENAI_* 优先（.env文件配置）
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL || 'gpt-4o-mini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const MAX_MSGS_PER_CALL = 20;
const CIRCUIT_RESET_MS = 30 * 60 * 1000; // 30分钟后自动恢复

// Prompt 版本（修改 Prompt 时递增，写入 daily_digests.prompt_version）
const PROMPT_VERSIONS = {
  supplierAlert: 'v1.1',
  dailyDigest: 'v1.2',
  weeklyReliability: 'v1.0',
  supplierProfile: 'v1.0',
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
async function analyzeAlertMessages(displayName, groupType, msgs, senderNames, contextAnchor) {
  const limited = msgs.slice(0, MAX_MSGS_PER_CALL);
  const messagesBlock = limited.map(m => {
    const t = new Date(m.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const contextBlock = contextAnchor && contextAnchor.length > 0
    ? contextAnchor.map(m => {
        const t = new Date(m.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
        return `[${t}] ${m.sender_name}: ${m.content}`;
      }).join('\n')
    : '（无上文）';

  const prompt =
    `你是ITNIO短信平台的运营风控引擎。以下是【${displayName}】在过去5分钟的消息：

【窗口前文（对话背景）】：
---
${contextBlock}
---

【窗口内消息（需分析）】：
---
${messagesBlock}
---

群类型：${groupType} | 主要外部联系人：${senderNames.join(', ')}

请判断（参照前文，区分新问题与延续讨论）：
1. 是否存在新的通道故障/成功率跌零/SID配置问题/内容被屏蔽的信号？（0-10分）
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
async function analyzeDailyDigest(displayName, messagesContent, openIssues = [], internalContent = '') {
  const openIssuesList = openIssues.length > 0
    ? openIssues.map(i => {
      const t = new Date(i.opened_at).toLocaleTimeString('zh-CN',
        { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
      return `- ${t} ${i.issue_type}（持续中）${i.commitment_text ? ` | 承诺："${i.commitment_text}"` : ''}`;
    }).join('\n')
    : '（无）';

  const internalBlock = internalContent
    ? `\n我方运营回复（内部方案参考，不要作为外部讨论输出）：\n---\n${internalContent.slice(0, 1200)}\n---\n`
    : '';

  const prompt =
    `你是ITNIO短信平台运营助手，生成【${displayName}】昨日汇总。

昨日外部消息（已过滤内部账号）：
---
${messagesContent.slice(0, 3000)}
---
${internalBlock}
昨日未关闭问题（若有）：
${openIssuesList}

请输出：
1. keyPoints: 关键讨论（数组，最多5条，每条20字内，只写外部联系人发起的话题）
2. followUp: 需关注事项（数组，有问题写问题，无问题写 ["运营正常"]）
3. hasAlert: 是否有未解决的告警信号（true/false）
4. solutions: 我方方案摘要（数组，从我方运营回复中提取，每条25字内，无则空数组）

严格JSON输出，不含其他文字：
{"keyPoints":["Dexter确认Smart OTP通道正常"],"followUp":["有2条投递回执追踪消息，建议确认"],"hasAlert":false,"solutions":["建议客户切换至MKT通道测试OTP送达"]}`;

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

// ─── 内容审核判定 Prompt ─────────────────────────────────────────
/**
 * AI 判定供应商对内容审核请求的回复：通过/拒绝/待定
 * @returns {Promise<{approved:boolean|null,confidence:number,reason:string}|null>}
 */
async function analyzeContentReview(submitterName, contentSubmitted, reviewerReply) {
  const prompt =
    `你是ITNIO短信平台的内容审核判定引擎。

ITNIO运营人员（${submitterName}）向供应商发送了内容审核请求：
---
${contentSubmitted.slice(0, 800)}
---

供应商回复：
---
${reviewerReply.slice(0, 500)}
---

请判定供应商对审核请求的态度：
1. approved: 是否批准该内容发送？true=批准, false=拒绝, null=无法判定（回复不明确）
2. confidence: 判定置信度（0.0-1.0）
3. reason: 一句话说明判定依据（中文，≤30字）

注意：
- 明确批准（如"ok""approved""可以发送""no problem"）→ approved=true
- 明确拒绝（如"reject""cannot""不可以""blocked""content not allowed"）→ approved=false
- 要求修改后再发 → approved=false, reason注明需修改
- 模糊回复、仅确认收到、技术询问 → approved=null

严格JSON输出：
{"approved":true,"confidence":0.95,"reason":"供应商明确回复ok确认内容可发送"}`;

  try {
    const text = await callAI(prompt);
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
    const t = new Date(m.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const prompt =
    `你是ITNIO的知识管理引擎。请从以下已闭环的问题对话中提取QA知识。

业务板块：${sector}
群组：${displayName}
闭环方式：${resolutionSummary}

完整对话：
---
${conversation.slice(0, 3500)}
---

请提取：
1. question_type: 问题分类（≤10个字，如"设备无法连接""OTP未送达""503错误""DLR延迟"）
2. question_summary: 问题现象一句话描述（≤30字）
3. question_keywords: 检索关键词（3-5个，逗号分隔，中英文）
4. answer_steps: 标准解决步骤（数组，每步≤30字）
5. answer_category: 解决类型（配置修改/重启/更换硬件/联系运营商/等待恢复/内容调整/其他）

严格JSON输出，不含其他文字：
{"question_type":"设备无法连接","question_summary":"GOIP设备端口断开无法连接","question_keywords":"disconnect,port,无法连接,goip","answer_steps":["检查网络和端口配置","重启设备","Anydesk远程排查"],"answer_category":"重启"}`;

  try {
    const text = await callAI(prompt);
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
    const t = new Date(m.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const prompt =
    `你是ITNIO的设备知识管理引擎。请从以下设备供应商的故障排查对话中提取设备知识。

群组：${displayName}

完整对话：
---
${conversation.slice(0, 3000)}
---

请提取：
1. device_model: 设备型号（如"RFH0606938SM""MP 664U-64N""GOIP-32"等，从对话中识别。若无明确型号，填"未知设备"）
2. device_type: 设备类型（goip / modem / SIM box / gateway / 其他）
3. fault_symptom: 故障现象一句话描述（≤30字）
4. fault_category: 故障分类（配置/硬件/网络/SIM/IMEI/端口/其他）
5. solution_steps: 解决步骤（数组，每步≤30字）

严格JSON输出，不含其他文字：
{"device_model":"RFH0606938SM","device_type":"goip","fault_symptom":"模块4-8不工作，端口无法连接","fault_category":"硬件","solution_steps":["检查模块供电和连接线","拆卸模块重新安装","更换故障模块"]}`;

  try {
    const text = await callAI(prompt);
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
    const t = new Date(m.timestamp).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
    return `[${t}] ${m.sender_name}: ${m.content}`;
  }).join('\n');

  const prompt =
    `你是ITNIO的短信模板管理引擎。请从以下客服审核对话中提取内容模板信息。

群组：${displayName}
审核结果：${reviewVerdict}

完整对话：
---
${conversation.slice(0, 3000)}
---

请提取：
1. customer_name: 客户名称（如"Onbuka""JILI""LAAFFIC"等，从对话中识别）
2. template_content: 模板内容摘要（≤50字，概括短信模板的核心内容）
3. template_type: 模板类型（OTP验证码/Marketing营销/Notification通知/其他）
4. target_region: 目标国家或地区（如"菲律宾""巴西"）
5. target_operator: 目标运营商（如"Globe""Claro""Vivo"，无则填null）
6. review_result: 审核结论（approved/rejected/modified）
7. compliance_notes: 合规备注（≤30字，如"禁止赌博类内容""短链接需更换域名"等）

严格JSON输出，不含其他文字：
{"customer_name":"Onbuka","template_content":"OTP验证码6位数字，有效期5分钟","template_type":"OTP验证码","target_region":"菲律宾","target_operator":"Globe","review_result":"approved","compliance_notes":"需使用直连通道，避免公共通道"}`;

  try {
    const text = await callAI(prompt);
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
  // 构造精简的消息样本（最多20条代表性消息，优先长消息和技术讨论）
  const sample = messages
    .filter(m => m.content && m.content.length > 20)
    .slice(0, 30)
    .map(m => {
      const t = new Date(m.timestamp).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      return `[${t}] ${m.sender_name}: ${m.content.slice(0, 200)}`;
    })
    .join('\n');

  if (!sample.trim()) return null;

  const prompt =
    `你是ITNIO短信平台的供应商关系分析引擎。请根据以下【${groupName}】的消息样本和已有定量指标，生成供应商定性画像。

业务板块：${sector}
已有定量指标：
- 总告警次数：${stats.total_issues || 0}
- 未闭环问题：${stats.open_issues || 0}
- 承诺兑现率：${stats.commitment_rate != null ? Math.round(stats.commitment_rate * 100) + '%' : '无数据'}
- 问题复发率：${stats.recurrence_rate != null ? Math.round(stats.recurrence_rate * 100) + '%' : '无数据'}
- 平均响应：${stats.avg_response_mins != null ? stats.avg_response_mins.toFixed(0) + 'min' : '无数据'}

近30天消息样本：
---
${sample.slice(0, 4000)}
---

请从消息中分析并输出以下维度的定性指标。所有分析仅基于消息样本推断，不确定的项目填合理默认值：

1. **attitude_tags**: 服务态度标签数组（从以下候选标签中选3-6个最匹配的）：
   候选：配合积极 / 敷衍拖沓 / 推诿责任 / 主动预警 / 被动响应 / 传话筒型客服 / 技术兜底强 / 英文主导 / 中文主导 / 周末响应盲区 / 长尾响应慢 / 消极怠工迹象 / 沟通回合长 / 专业高效

2. **insight_tags**: AI洞察标签数组（从以下候选标签中选4-7个最匹配的）：
   候选：周末响应盲区 / 问题易复发 / 沟通回合长 / 故障高频 / 传话筒型客服 / 技术兜底弱 / 技术兜底强 / 南亚通道不稳 / 运行平稳 / 工作日响应极快 / 主动预警意识弱 / 首问解决率高 / 维护规范

3. **insight_summary**: 一段100-150字的中文综合评价，语气专业客观，直接指出该供应商的优缺点和风险点，使用转义引号（如 \\"Checking...\\"）引用典型话术

4. **sub_scores**: 分项评分JSON对象，每项0-100：
   - 主动上报与预警
   - 首问解决率FCR
   - 技术配合态度
   - 计划内变更占比（若无法判断填50）

5. **avg_turns**: 估计每个问题的平均交互回合数（数字，如3.5）

6. **fcr**: 估计首问解决率（0-1之间小数，如0.45）

7. **tech_contact**: 从消息中识别最关键的技术接口人名称（识别模式：频繁发送技术方案、提供配置细节、回复速度快于群内平均的人）。若无法识别填null

8. **tech_reply_rate**: 技术接口人的回复占比（0-1之间小数，估计值）

9. **planned_maintenance_pct**: 计划内维护占比（0-1之间小数，根据"维护通知/计划升级"类消息占比估计，若无法判断填null）

严格JSON输出，不含markdown代码块标记：
{"attitude_tags":["被动响应","英文主导"],"insight_tags":["故障高频","技术兜底弱","周末响应盲区"],"insight_summary":"该供应商工作日基本能响应，但一线客服多为传话筒...","sub_scores":{"主动上报与预警":15,"首问解决率FCR":40,"技术配合态度":70,"计划内变更占比":20},"avg_turns":6.5,"fcr":0.4,"tech_contact":"Alex","tech_reply_rate":0.75,"planned_maintenance_pct":0.15}`;

  try {
    const text = await callAI(prompt);
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
    model: OPENAI_MODEL,
    hasKey: !!OPENAI_API_KEY,
    hasGemini: !!GEMINI_API_KEY,
  }),
};
