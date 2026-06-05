/**
 * analyzers/knowledge-asset-analyzer.js
 * 统一知识资产候选池增量分析器
 *
 * 职责：
 *   1. 按 analysis_cursor 增量消费 messages
 *   2. 实时发现实体关系、运营动作、风险模式、联系人角色、变更事件、媒体证据
 *   3. 增量同步 issue_records 中的 SLA/承诺履约资产
 *   4. 只写 analytics.sqlite 的 knowledge_asset_candidates
 */

'use strict';

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { getRegionInfo, getValueLabel } = require('../lib/region-config');
const {
  hydrateCandidateRow,
  promoteCandidateToAsset,
  targetLibraryForAsset,
  upsertCandidates,
  normalizeSector,
  parseJson,
  stableHash,
} = require('../lib/knowledge-assets');
const { isInternalStaff } = require('../lib/staff-detector');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');
const sourceDb = new Database(path.join(ROOT, 'db', 'database.sqlite'), { readonly: true });
sourceDb.pragma('journal_mode = WAL');
const analyticsDb = new Database(path.join(ROOT, 'db', 'analytics.sqlite'));
analyticsDb.pragma('journal_mode = WAL');

const MESSAGE_ANALYZER = 'knowledge-asset-analyzer';
const COMMITMENT_ANALYZER = 'knowledge-asset-commitments';
const SCAN_INTERVAL = Number(process.env.KNOWLEDGE_ASSET_SCAN_INTERVAL_MS || 60 * 1000);
const BATCH_SIZE = Number(process.env.KNOWLEDGE_ASSET_BATCH_SIZE || 500);
const START_FROM_NOW = String(process.env.KNOWLEDGE_ASSET_START_FROM_NOW || 'true').toLowerCase() !== 'false';
const ACTION_EFFECT_MIN_MS = Number(process.env.KNOWLEDGE_ASSET_ACTION_EFFECT_MIN_MS || 30 * 60 * 1000);
const ACTION_EFFECT_WINDOW_MS = Number(process.env.KNOWLEDGE_ASSET_ACTION_EFFECT_WINDOW_MS || 2 * 60 * 60 * 1000);
const ACTION_EFFECT_BATCH = Number(process.env.KNOWLEDGE_ASSET_ACTION_EFFECT_BATCH || 50);
const AUTO_PROMOTE_BATCH = Number(process.env.KNOWLEDGE_ASSET_AUTO_PROMOTE_BATCH || 100);
const ENRICH_BATCH = Number(process.env.KNOWLEDGE_ASSET_ENRICH_BATCH || 500);
const REGIONAL_INTELLIGENCE_WINDOW_MS = Number(process.env.KNOWLEDGE_ASSET_REGIONAL_WINDOW_MS || 24 * 60 * 60 * 1000);
const MACHINE_ASSESSMENT_VERSION = 'v2';

const COUNTRY_PATTERNS = [
  ['菲律宾', /\b(ph|philippines|philippine)\b|菲律宾/i],
  ['印度', /\b(india|in)\b|印度/i],
  ['巴基斯坦', /\b(pakistan|pk)\b|巴基斯坦/i],
  ['巴西', /\b(brazil|br)\b|巴西/i],
  ['墨西哥', /\b(mexico|mx)\b|墨西哥/i],
  ['印尼', /\b(indonesia|id)\b|印尼|印度尼西亚/i],
  ['越南', /\b(vietnam|vn)\b|越南/i],
  ['泰国', /\b(thailand|thai|th)\b|泰国/i],
  ['马来西亚', /\b(malaysia|my)\b|马来西亚/i],
  ['美国', /\b(usa|us|america)\b|美国/i],
  ['澳大利亚', /\b(australia|au)\b|澳大利亚|澳洲/i],
  ['英国', /\b(uk|britain|england)\b|英国/i],
];

const OPERATOR_PATTERNS = [
  ['Globe', /\bglobe\b/i],
  ['Smart', /\bsmart\b/i],
  ['Airtel', /\bairtel\b/i],
  ['Jio', /\bjio\b/i],
  ['Vodafone', /\bvodafone\b/i],
  ['MTN', /\bmtn\b/i],
  ['Orange', /\borange\b/i],
  ['Telkomsel', /\btelkomsel\b/i],
  ['Viettel', /\bviettel\b/i],
  ['AIS', /\bais\b/i],
  ['Claro', /\bclaro\b/i],
  ['Movistar', /\bmovistar\b/i],
];

const CUSTOMER_PATTERNS = [
  ['Onbuka', /\bonbuka\b/i],
  ['JILI', /\bjili\b/i],
  ['Laffic', /\blaffic\b/i],
  ['ITNIO', /\bitnio\b/i],
  ['Lazada', /\blazada\b/i],
  ['Shopee', /\bshopee\b/i],
  ['TikTok', /\btiktok\b/i],
];

const ACTION_RULES = [
  { key: 'switch_route', label: '切换路由', pattern: /\b(switch|change|move)\s+(?:to\s+)?(?:another\s+)?route\b|切(?:换|到).*路由|换路由/i },
  { key: 'restart', label: '重启设备/服务', pattern: /\b(restart|reboot|power\s*cycle)\b|重启/i },
  { key: 'reset_filter', label: '重置过滤/拦截规则', pattern: /\breset\s+(?:the\s+)?filter\b|重置.*(?:过滤|拦截)/i },
  { key: 'replace_sim', label: '更换SIM/卡', pattern: /\b(replace|change)\s+(?:the\s+)?sim\b|换卡|更换\s*SIM/i },
  { key: 'update_vnl', label: '更新VNL/名单', pattern: /\b(update|refresh|add)\s+vnl\b|更新\s*VNL/i },
  { key: 'contact_operator', label: '联系运营商', pattern: /\b(contact|ask|check\s+with)\s+(?:the\s+)?(?:operator|carrier|telco)\b|联系(?:运营商|电信)/i },
  { key: 'remote_debug', label: '远程排查', pattern: /\b(anydesk|teamviewer|remote)\b|远程|远控/i },
  { key: 'check_config', label: '检查配置', pattern: /\bcheck\s+(?:the\s+)?(?:config|setting|bind|ip|port)\b|检查.*(?:配置|端口|IP|绑定)/i },
  { key: 'update_sid', label: '更新Sender ID', pattern: /\b(update|change|add)\s+(?:the\s+)?sid\b|更新\s*SID/i },
  { key: 'port_adjust', label: '调整端口/并发', pattern: /\b(open|close|adjust|increase|decrease).{0,20}(?:port|channel|concurrent)\b|调整.*(?:端口|并发|通道)/i },
];

const CHANGE_RULES = [
  { key: 'planned_maintenance', label: '计划维护', pattern: /\b(planned\s+maintenance|maintenance\s+window|scheduled\s+maintenance)\b|计划维护|维护窗口/i },
  { key: 'route_update', label: '路由更新', pattern: /\b(route|routing)\s+(?:update|updated|change|changed)\b|路由.*(?:更新|变更|调整)/i },
  { key: 'sid_update', label: 'SID变更', pattern: /\b(?:sid|sender\s*id)\b.{0,30}\b(update|change|changed|added|remove)\b|\bSID\s+\d{4,}/i },
  { key: 'vnl_update', label: 'VNL更新', pattern: /\bvnl\b.{0,30}\b(update|add|remove|refresh)\b|更新\s*VNL/i },
  { key: 'port_adjustment', label: '端口调整', pattern: /\b(port|channel|concurrent)\b.{0,30}\b(adjust|open|close|increase|decrease)\b|端口.*(?:调整|打开|关闭)/i },
  { key: 'system_upgrade', label: '系统升级', pattern: /\b(upgrade|deploy|release|version)\b|升级|发布|版本/i },
];

const RISK_RULES = [
  { key: 'repeated_checking', label: '反复checking/处理中', pattern: /\b(checking|still\s+checking|checking\s+now|under\s+checking)\b|正在查|还在查/i },
  { key: 'delayed_eta', label: '延迟/ETA不明确', pattern: /\b(eta|later|tomorrow|soon|asap|wait)\b|稍后|明天|尽快|等一下/i },
  { key: 'quality_drop', label: '质量下降/成功率异常', pattern: /\b(dlr|success\s+rate|delivery\s+rate|asr|click\s+rate).{0,40}\b(drop|low|down|0%|bad)\b|成功率.*(?:低|下降|异常)/i },
  { key: 'blocked_or_rejected', label: '拦截/拒绝风险', pattern: /\b(blocked|reject(?:ed)?|spam|filter|suspend(?:ed)?)\b|拦截|拒绝|封禁/i },
  { key: 'supplier_silence', label: '追问后无明确答复', pattern: /\b(no\s+reply|any\s+update|still\s+waiting|please\s+update)\b|没人回复|有更新吗|还没回复/i },
  { key: 'routing_instability', label: '路由不稳定', pattern: /\b(route|bind|smpp|traffic)\b.{0,40}\b(down|fail|unstable|disconnect)\b|路由.*(?:失败|不稳定|断开)/i },
];

const CLOSE_PATTERN = /\b(resolved|fixed|back\s+to\s+normal|working\s+now|recovered|all\s+good|done|updated|back\s+up)\b|已恢复|解决了|好了/i;
const COMMITMENT_PATTERN = /\b(will|promise|commit|update\s+you|give\s+you|resolve\s+in|fix\s+in|by\s+eod|tomorrow)\b|承诺|会处理|会更新|稍后更新/i;
const PROBLEM_PATTERN = /\b(error|fail(?:ed)?|down|offline|disconnect(?:ed)?|blocked|reject(?:ed)?|timeout|cannot|can't|not\s+work|low|drop|issue|problem|hangup)\b|失败|异常|离线|断开|不通|收不到|发不出|报错|问题|卡住|掉线|拦截|拒绝|低|下降/i;
const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?<!\d)\+?\d[\d\s().-]{5,}\d(?!\d)/g;

const ENTITY_TYPE_LABELS = {
  country: '国家/地区',
  operator: '运营商',
  customer: '客户/品牌',
  sender_id: 'Sender ID',
  route: '路由/通道',
  device_model: '设备型号',
};

const PROVIDER_SECTORS = new Set(['设备供应商', '直连供应商', '语音直连供应商', '语音供应商', '卡线']);
const USER_SECTORS = new Set(['客服']);

function redact(text, maxLen = 150) {
  return String(text || '')
    .replace(URL_PATTERN, '[url]')
    .replace(EMAIL_PATTERN, '[email]')
    .replace(/(?:密码|password|passwd|pwd|pass)\s*[:：=]?\s*[^\s,，;；]+/gi, '密码 [secret]')
    .replace(/\b(?:root|admin)\s+[A-Za-z0-9@#._-]{4,}\b/gi, '[credential]')
    .replace(PHONE_PATTERN, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function getCursor(name, kind) {
  const row = analyticsDb.prepare('SELECT last_msg_id, last_ts FROM analysis_cursor WHERE analyzer = ?').get(name);
  if (row) {
    if ((row.last_msg_id || 0) === 0 && START_FROM_NOW && !process.argv.includes('--backfill')) {
      const boot = bootstrapCursor(kind);
      updateCursor(name, boot.last_msg_id, boot.last_ts);
      return boot;
    }
    return row;
  }
  let startId = 0;
  let startTs = 0;
  if (START_FROM_NOW && !process.argv.includes('--backfill')) {
    const boot = bootstrapCursor(kind);
    startId = boot.last_msg_id;
    startTs = boot.last_ts;
  }
  analyticsDb.prepare('INSERT OR IGNORE INTO analysis_cursor (analyzer, last_msg_id, last_ts) VALUES (?, ?, ?)').run(name, startId, startTs);
  return { last_msg_id: startId, last_ts: startTs };
}

function bootstrapCursor(kind) {
  if (kind === 'message') {
    const max = sourceDb.prepare('SELECT COALESCE(MAX(id), 0) AS id, COALESCE(MAX(timestamp), 0) AS ts FROM messages').get();
    return { last_msg_id: max.id || 0, last_ts: max.ts || 0 };
  }
  if (kind === 'issue') {
    const max = analyticsDb.prepare('SELECT COALESCE(MAX(id), 0) AS id, COALESCE(MAX(opened_at), 0) AS ts FROM issue_records').get();
    return { last_msg_id: max.id || 0, last_ts: max.ts || 0 };
  }
  return { last_msg_id: 0, last_ts: 0 };
}

function updateCursor(name, lastMsgId, lastTs) {
  analyticsDb.prepare(`
    UPDATE analysis_cursor
    SET last_msg_id = ?, last_ts = ?, updated_at = datetime('now', '+8 hours')
    WHERE analyzer = ?
  `).run(lastMsgId, lastTs || 0, name);
}

function regionContext(msg) {
  const info = getRegionInfo(msg.receiver_account);
  const sector = normalizeSector(msg.business_sector || info.business_sector);
  return {
    collection_region: info.region || '未知区',
    business_region: detectBusinessRegion(msg.content) || info.region || '未知区',
    business_sector: sector,
    value_label: getValueLabel(msg.receiver_account, msg.group_name),
  };
}

function detectBusinessRegion(content) {
  for (const [country, pattern] of COUNTRY_PATTERNS) {
    if (pattern.test(content || '')) return country;
  }
  return '';
}

function matchRules(content, rules) {
  return rules.filter((rule) => rule.pattern.test(content || ''));
}

function senderRole(senderName) {
  return isInternalStaff(senderName) ? 'internal' : 'external';
}

function senderRoleLabel(senderName) {
  return isInternalStaff(senderName) ? '我方' : '外部/供应商';
}

function interactionSideForSector(sector) {
  const normalized = normalizeSector(sector);
  if (USER_SECTORS.has(normalized)) {
    return {
      key: 'resource_user',
      label: '资源使用方交互',
      description: '客服板块，主要是我方与资源使用方/客户侧的需求、问题和反馈交互。',
    };
  }
  if (PROVIDER_SECTORS.has(normalized)) {
    return {
      key: 'resource_provider',
      label: '资源提供方交互',
      description: '设备、直连、语音和卡线板块，主要是我方与资源提供方/供应商侧的排障和履约交互。',
    };
  }
  return {
    key: 'other',
    label: '其他交互',
    description: '未归入资源提供方或资源使用方的补充板块。',
  };
}

function formalAssetOutcome(type, metrics = {}) {
  const map = {
    entity_relationship: '确认后成为实体关系节点，用于按运营商、客户、国家、Route、SID、设备型号下钻共现问题和供应商。',
    operation_action: '确认后成为处理动作资产，用于同类问题出现时推荐排查步骤和验证动作效果。',
    regional_intelligence: '这是区域/板块聚合情报，通常不需要作为单条资产审核，主要用于下钻高价值样本和形成区域打法。',
    risk_pattern: '确认后成为风险预警特征，用于提升告警权重、识别升级前兆和区域风险复盘。',
    sla_commitment: '确认后成为承诺履约资产，用于供应商追责、兑现率评分和问题复盘。',
    contact_role: metrics.is_internal_staff
      ? '确认后成为我方联系人/升级路径资产，用于内部协作和故障升级找人。'
      : '确认后成为外部/供应商联系人资产，用于供应商画像、技术接口人和响应能力分析。',
    change_event: '确认后成为变更维护事件，用于维护日历、故障复盘和变更影响追踪。',
    media_evidence: '确认后成为证据索引资产，用于快速定位截图、报错图、设备照片、配置图和后续 OCR 队列。',
  };
  return map[type] || '确认后进入正式知识资产库，供后续检索、复盘和推荐使用。';
}

function buildMachineAssessment(candidate, insight) {
  const metrics = candidate.metrics || {};
  const confidence = Number(candidate.confidence || 0.5);
  const value = Number(candidate.asset_value_score || 0);
  const frequency = Number(candidate.frequency || metrics.mention_count || metrics.signal_count || metrics.message_count || metrics.total_assets || 1) || 1;
  const interaction = interactionSideForSector(candidate.business_sector);
  let decision = 'needs_human_review';
  let label = '需人工复核';
  let reason = '机器能识别类型和上下文，但证据链仍需人工确认。';
  let review_priority = value >= 75 || confidence >= 0.75 ? 'high' : value >= 55 || confidence >= 0.6 ? 'medium' : 'low';
  let manual_review_required = true;

  if (candidate.asset_type === 'regional_intelligence') {
    decision = 'auto_insight';
    label = '自动情报';
    reason = '区域运营情报是聚合看板入口，不建议按单条资产逐条审核。';
    manual_review_required = false;
  } else if (candidate.asset_type === 'operation_action') {
    const playbook = metrics.action_playbook || {};
    if (playbook.problem_summary && playbook.action_text && playbook.result_signal) {
      decision = 'auto_ready';
      label = '可自动沉淀';
      reason = '已具备问题现象、处理动作和结果信号，可作为处理动作资产候选。';
      manual_review_required = false;
    } else if (playbook.action_text || metrics.action_label) {
      decision = 'auto_index';
      label = '自动索引';
      reason = '已识别处理动作片段，但缺少完整前后闭环，先自动索引到动作资产，后续由效果反馈补强。';
      manual_review_required = false;
    } else if (!playbook.problem_summary) {
      reason = '缺少明确前置问题，必须人工查看上下文后再决定是否沉淀。';
      review_priority = 'medium';
    }
  } else if (candidate.asset_type === 'contact_role') {
    if (metrics.is_internal_staff) {
      decision = 'auto_ready';
      label = '可自动沉淀';
      reason = '联系人命中内部员工白名单，机器可确认是我方人员；角色仍可人工修正。';
      manual_review_required = false;
    } else if (metrics.contact_side === 'external' && frequency >= 3 && confidence >= 0.7) {
      decision = 'auto_ready';
      label = '可自动沉淀';
      reason = '外部联系人多次在同一角色行为中出现，可作为供应商接口人候选。';
      manual_review_required = false;
    } else {
      reason = '未命中内部白名单，需人工判断是供应商联系人、客户联系人还是普通转发人。';
    }
  } else if (candidate.asset_type === 'sla_commitment') {
    if (metrics.commitment_met !== null && metrics.commitment_met !== undefined) {
      decision = 'auto_ready';
      label = '可自动沉淀';
      reason = '承诺文本和履约结果已形成结构化字段，可进入履约资产。';
      manual_review_required = false;
    } else {
      decision = 'auto_index';
      label = '自动索引';
      reason = '承诺文本已结构化但兑现状态未闭环，先进入履约台账等待后续消息自动补齐。';
      manual_review_required = false;
    }
  } else if (candidate.asset_type === 'media_evidence') {
    if (metrics.media_category && metrics.media_category !== '未分类附件') {
      decision = 'auto_index';
      label = '自动索引';
      reason = '附件类型已识别，可先进入证据索引；高价值附件后续再人工补标签。';
      manual_review_required = false;
    } else {
      decision = 'auto_index';
      label = '自动索引';
      reason = '媒体证据先按元数据和上下文自动索引，不再要求人工逐条判断；后续 OCR/视觉分析再补分类。';
      manual_review_required = false;
    }
  } else if (candidate.asset_type === 'entity_relationship') {
    if (metrics.entity_type || frequency >= 2) {
      decision = 'auto_index';
      label = '自动索引';
      reason = '实体类型稳定，可先作为图谱索引；是否升为重点节点再看共现频次。';
      manual_review_required = false;
    } else {
      reason = '单次实体命中可能是误识别，需人工确认是否值得作为图谱节点。';
    }
  } else if (candidate.asset_type === 'risk_pattern') {
    if ((metrics.signals || []).length || frequency >= 2 || confidence >= 0.55) {
      decision = 'auto_ready';
      label = '可自动沉淀';
      reason = '风险信号已结构化，可作为预警特征候选；人工只需抽检高影响误判。';
      manual_review_required = false;
    } else {
      reason = '普通风险语言需要结合后续升级、恢复和追问情况判断。';
    }
  } else if (candidate.asset_type === 'change_event') {
    if (metrics.planned) {
      decision = 'auto_ready';
      label = '可自动沉淀';
      reason = '计划维护/变更特征明确，可进入维护事件库。';
      manual_review_required = false;
    } else if (metrics.change_label || confidence >= 0.6 || frequency >= 2) {
      decision = 'auto_index';
      label = '自动索引';
      reason = '变更事件已有类型或上下文信号，先自动索引到变更台账，人工只复核影响较大的异常变更。';
      manual_review_required = false;
    } else {
      reason = '临时变更需人工确认是否与故障窗口、恢复动作相关。';
    }
  }

  if (decision === 'auto_ready' || decision === 'auto_index' || decision === 'auto_insight') {
    review_priority = 'low';
  }

  return {
    assessment_version: MACHINE_ASSESSMENT_VERSION,
    assessor: 'ai_auto_triage',
    decision,
    label,
    reason,
    manual_review_required,
    review_priority,
    interaction_side: interaction.key,
    interaction_label: interaction.label,
    interaction_description: interaction.description,
    after_confirm: formalAssetOutcome(candidate.asset_type, metrics),
    human_review_when: manual_review_required
      ? '机器无法可靠确认时才需要人工审核；审核重点是修正分类、身份、适用边界或废弃低价值样本。'
      : '机器已有明确结论，人工只需抽检或在发现误判时修正。',
    review_action_label: manual_review_required ? '人工复核' : decision === 'auto_insight' ? '下钻查看' : '抽检确认',
    confidence_hint: confidence >= 0.75 ? '高置信' : confidence >= 0.6 ? '中置信' : '低置信',
    insight_summary: insight?.reusable_summary || candidate.description || '',
  };
}

function extractEntities(content) {
  const entities = [];
  for (const [value, pattern] of COUNTRY_PATTERNS) if (pattern.test(content)) entities.push({ type: 'country', value });
  for (const [value, pattern] of OPERATOR_PATTERNS) if (pattern.test(content)) entities.push({ type: 'operator', value });
  for (const [value, pattern] of CUSTOMER_PATTERNS) if (pattern.test(content)) entities.push({ type: 'customer', value });
  for (const sid of content.match(/\bSID\s+\d{4,}\b/gi) || []) entities.push({ type: 'sender_id', value: sid.toUpperCase() });
  for (const route of content.match(/\b(?:route|routing|bind|smpp)\s*[:#-]?\s*([A-Z0-9_-]{3,20})\b/gi) || []) entities.push({ type: 'route', value: route.replace(/\s+/g, ' ').trim() });
  for (const model of content.match(/\b(?:RFH|MP|GOIP|GSM|SIMBOX|SM|GW)[A-Z0-9_-]{3,24}\b/gi) || []) entities.push({ type: 'device_model', value: model.toUpperCase() });
  const seen = new Set();
  return entities.filter((entity) => {
    const key = `${entity.type}:${entity.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyMedia(msg) {
  const text = `${msg.content || ''} ${msg.media_path || ''}`;
  if (/qr|二维码/i.test(text)) return '二维码/登录凭证';
  if (/error|fail|down|报错|错误/i.test(text)) return '报错截图';
  if (/device|goip|modem|sim|port|设备|端口/i.test(text)) return '设备/端口照片';
  if (/config|setting|bind|ip|配置/i.test(text)) return '配置截图';
  if (/test|dlr|success|asr|result|测试|结果/i.test(text)) return '测试结果截图';
  return '未分类附件';
}

function baseCandidate(msg, ctx, type, key, title) {
  return {
    asset_type: type,
    asset_key: key,
    title,
    collection_region: ctx.collection_region,
    business_region: ctx.business_region,
    business_sector: ctx.business_sector,
    receiver_account: msg.receiver_account,
    value_label: ctx.value_label,
    group_name: msg.group_name,
    source_msg_ids: [msg.id],
    time_range: { start: msg.timestamp, end: msg.timestamp },
    first_seen_at: msg.timestamp,
    last_seen_at: msg.timestamp,
    evidence: msg.content ? [redact(msg.content)] : [],
    extractor: MESSAGE_ANALYZER,
  };
}

function getActionContext(groupName, startTs, beforeMs = 45 * 60 * 1000, afterMs = 2 * 60 * 60 * 1000) {
  if (!groupName || !startTs) return { before: [], after: [] };
  const rows = sourceDb.prepare(`
    SELECT id, sender_name, content, timestamp
    FROM messages
    WHERE group_name = ?
      AND timestamp >= ?
      AND timestamp <= ?
      AND content IS NOT NULL
      AND TRIM(content) != ''
    ORDER BY timestamp ASC
    LIMIT 160
  `).all(groupName, startTs - beforeMs, startTs + afterMs);
  return {
    before: rows.filter((item) => item.timestamp < startTs),
    after: rows.filter((item) => item.timestamp > startTs),
  };
}

function isWeakContextText(text) {
  return /^(ok|okay|done|yes|no|收到|好的|可以了|好了)$/i.test(String(text || '').trim());
}

function usefulEvidenceLine(item) {
  if (!item) return false;
  const text = String(item);
  if (/^问题：\s*/.test(text)) return !isWeakContextText(text.replace(/^问题：\s*/, ''));
  if (/^动作：\s*/.test(text)) return !isWeakContextText(text.replace(/^动作：\s*/, ''));
  return true;
}

function pickProblemMessage(messages) {
  const candidates = [...messages]
    .reverse()
    .filter((item) => PROBLEM_PATTERN.test(item.content || '') && !CLOSE_PATTERN.test(item.content || ''));
  return candidates.find((item) => !isInternalStaff(item.sender_name)) || candidates[0] || null;
}

function pickActionMessage(sourceMsg, context, rule) {
  if (sourceMsg?.content && rule?.pattern?.test(sourceMsg.content || '')) return sourceMsg;
  const around = [...(context?.before || []), ...(context?.after || [])]
    .filter((item) => Math.abs((item.timestamp || 0) - (sourceMsg?.timestamp || item.timestamp || 0)) <= 20 * 60 * 1000);
  return around.find((item) => rule?.pattern?.test(item.content || '')) || null;
}

function buildActionPlaybook({ row, msg, rule, closeMsg = null, context = null }) {
  const metrics = row ? parseJson(row.metrics, {}) : {};
  const start = row ? (parseJson(row.time_range, null)?.start || row.first_seen_at) : msg.timestamp;
  const sourceMsg = msg || null;
  const ctx = context || getActionContext(row?.group_name || msg?.group_name, start);
  const actionMsg = pickActionMessage(sourceMsg, ctx, rule);
  const problemMsg = pickProblemMessage(ctx.before.filter((item) => item.id !== actionMsg?.id));
  const afterSignals = ctx.after
    .filter((item) => CLOSE_PATTERN.test(item.content || '') || PROBLEM_PATTERN.test(item.content || ''))
    .slice(0, 4);
  const actionLabel = rule?.label || metrics.action_label || row?.title?.split(':')?.[0] || '处理动作';
  const actionKey = rule?.key || metrics.action_key || row?.asset_key || '';
  const actorName = actionMsg?.sender_name || sourceMsg?.sender_name || metrics.action_actor || '';
  const effectMsg = closeMsg || afterSignals.find((item) => CLOSE_PATTERN.test(item.content || '')) || null;
  const effectDelay = effectMsg && start ? Number(((effectMsg.timestamp - start) / 60000).toFixed(1)) : null;
  const rowEvidence = row ? parseJson(row.evidence, []) : [];
  const evidenceAction = rowEvidence.find((item) => String(item || '').startsWith('动作：'));
  const actionText = actionMsg?.content || (evidenceAction ? String(evidenceAction).replace(/^动作：\s*/, '') : '') || metrics.action_text || rowEvidence[0] || '';
  const problemText = problemMsg?.content || '';

  return {
    action_key: actionKey,
    action_label: actionLabel,
    action_text: redact(actionText, 180),
    action_actor: actorName,
    action_actor_role: actorName ? senderRole(actorName) : '',
    action_actor_role_label: actorName ? senderRoleLabel(actorName) : '',
    problem_msg_id: problemMsg?.id || null,
    problem_sender: problemMsg?.sender_name || '',
    problem_sender_role: problemMsg ? senderRole(problemMsg.sender_name) : '',
    problem_summary: problemText ? redact(problemText, 180) : '',
    trigger_condition: problemText ? `在出现“${redact(problemText, 80)}”后执行` : '未识别到明确前置问题',
    result_signal: effectMsg ? redact(effectMsg.content, 180) : '',
    result_msg_id: effectMsg?.id || null,
    result_delay_mins: effectDelay,
    reusable_summary: problemText
      ? `当 ${redact(problemText, 80)} 时，${actorName ? `${senderRoleLabel(actorName)} ${actorName} ` : ''}执行「${actionLabel}」，${effectMsg ? `约 ${effectDelay} 分钟后出现恢复信号` : '暂未发现明确恢复信号'}。`
      : `${actorName ? `${senderRoleLabel(actorName)} ${actorName} ` : ''}执行「${actionLabel}」，${effectMsg ? `后续出现恢复信号` : '但缺少明确问题上下文'}。`,
    context_msg_ids: [
      problemMsg?.id,
      actionMsg?.id || sourceMsg?.id,
      effectMsg?.id,
      ...afterSignals.map((item) => item.id),
    ].filter(Boolean),
  };
}

function buildAssetInsight(candidate) {
  const metrics = candidate.metrics || {};
  const collectionRegion = candidate.collection_region || '未知区';
  const businessSector = candidate.business_sector || '未分类';
  const groupName = candidate.group_name || '跨群汇总';
  const frequency = Number(candidate.frequency || metrics.mention_count || metrics.signal_count || metrics.message_count || metrics.total_assets || 1) || 1;
  const base = {
    insight_version: 'v2',
    context: `${collectionRegion} / ${businessSector}`,
    review_focus: '确认来源证据是否能支撑该资产，避免把孤立片段沉淀为正式知识。',
    limitation: frequency <= 1 ? '目前仅有单次证据，适合作为候选索引，确认前不建议直接进入自动推荐。' : '已有多次出现，但仍需结合来源消息确认是否属于同一业务含义。',
  };

  if (candidate.asset_type === 'operation_action') {
    const playbook = metrics.action_playbook || {};
    return {
      ...base,
      primary_use: '沉淀可复用处理步骤，用于同类问题出现时推荐排查动作。',
      review_focus: '重点确认问题现象、处理动作、执行方和恢复信号是否属于同一事件窗口。',
      limitation: playbook.problem_summary ? base.limitation : '缺少明确前置问题，只能作为动作线索，不应直接进入正式处理手册。',
      suggested_next_step: playbook.problem_summary ? '可审核为处理动作资产；若多次有效，可进入标准排障手册。' : '先查看来源消息上下文，补足触发条件后再确认。',
      reusable_summary: playbook.reusable_summary || candidate.description || '处理动作候选，等待补齐问题和结果上下文。',
      value_dimensions: ['触发条件', '处理动作', '执行方', '结果信号'],
    };
  }

  if (candidate.asset_type === 'entity_relationship') {
    const entityLabel = ENTITY_TYPE_LABELS[metrics.entity_type] || metrics.entity_type || '实体';
    const entityValue = metrics.entity_value || candidate.asset_key || candidate.title;
    return {
      ...base,
      primary_use: `把 ${entityLabel}「${entityValue}」作为关系图谱节点，追溯它关联的群、板块、区域、供应商、问题和动作。`,
      review_focus: '确认该实体不是误识别的普通词，并判断它是否值得作为后续检索入口。',
      suggested_next_step: frequency >= 3 ? '建议确认为图谱节点，后续统计共现供应商、风险和处理动作。' : '先保留为索引候选，等待更多共现证据。',
      reusable_summary: `${entityLabel}「${entityValue}」在 ${groupName} 出现，可作为跨消息追溯和共现分析入口。`,
      value_dimensions: ['实体节点', '群关系', '区域/板块共现', '问题/动作关联'],
    };
  }

  if (candidate.asset_type === 'risk_pattern') {
    const signals = Array.isArray(metrics.signals) ? metrics.signals.join('、') : candidate.title;
    const side = metrics.sender_role_label || (metrics.sender_role === 'internal' ? '我方' : metrics.sender_role === 'external' ? '外部/供应商' : '未知发送方');
    return {
      ...base,
      primary_use: '沉淀风险先兆语言和指标异常，后续可升级为预警规则或告警权重。',
      review_focus: '确认该信号是否在问题升级前出现，而不是问题已经结束后的普通描述。',
      limitation: '规则命中的风险词不等于真实风险，需要结合后续是否升级、是否重复、发送方角色一起判断。',
      suggested_next_step: '优先查看来源消息后 1-2 小时内是否出现告警、追问、SLA超时或恢复动作。',
      reusable_summary: `${side}出现「${signals}」信号，可作为 ${collectionRegion} / ${businessSector} 的风险预警候选。`,
      value_dimensions: ['风险信号', '发送方角色', '后续升级', '区域/板块差异'],
    };
  }

  if (candidate.asset_type === 'sla_commitment') {
    const statusText = metrics.commitment_met === 1 ? '已兑现' : metrics.commitment_met === 0 ? '未兑现/待复核' : '未形成明确结果';
    return {
      ...base,
      primary_use: '追踪承诺内容、时限和兑现结果，用于供应商复盘、追责和服务质量评分。',
      review_focus: '确认承诺文本、截止时间和实际闭环时间是否能从来源消息中对应起来。',
      limitation: metrics.commitment_due ? base.limitation : '未识别明确截止时间，只能作为承诺线索，不适合直接计算违约。',
      suggested_next_step: metrics.commitment_met === 0 ? '建议优先审核，并关联供应商画像的履约标签。' : '可用于补充供应商正向/负向履约样本。',
      reusable_summary: `${groupName} 的承诺履约状态为「${statusText}」，可用于 SLA 复盘和供应商履约资产沉淀。`,
      value_dimensions: ['承诺内容', '承诺时限', '闭环时间', '履约状态'],
    };
  }

  if (candidate.asset_type === 'contact_role') {
    const side = metrics.is_internal_staff ? '我方人员' : '外部/供应商联系人候选';
    return {
      ...base,
      primary_use: metrics.is_internal_staff ? '沉淀我方协作角色和升级路径，便于故障时找到内部处理人。' : '识别外部或供应商侧接口人，便于问题升级时找对角色。',
      review_focus: metrics.is_internal_staff ? '确认白名单命中准确，角色是否由该群的行为证据支撑。' : '确认该联系人是否真实代表供应商技术/客服角色。',
      limitation: metrics.is_internal_staff ? '内部白名单只能确认身份，不能单独证明其在该事件中的职责。' : '未命中内部白名单不等于一定是供应商，需要人工结合群身份确认。',
      suggested_next_step: metrics.is_internal_staff ? '确认后进入内部联系人/升级路径资产。' : '确认后进入供应商联系人画像，并与供应商群绑定。',
      reusable_summary: `${candidate.title} 被识别为${side}，推断角色为「${metrics.inferred_role || '未知角色'}」。`,
      value_dimensions: ['身份来源', '群内角色', '响应行为', '升级路径'],
    };
  }

  if (candidate.asset_type === 'change_event') {
    const actor = metrics.change_actor || '';
    const planned = metrics.planned ? '计划内变更' : '临时/故障后变更';
    return {
      ...base,
      primary_use: '沉淀维护、路由、SID、端口、系统升级等变更事件，用于维护日历和故障复盘。',
      review_focus: '确认变更类型、发生时间、影响范围和是否与故障/恢复有关。',
      limitation: '当前只识别变更语言，不代表变更已经完成；需要结合后续结果消息或系统记录确认。',
      suggested_next_step: metrics.planned ? '确认后进入维护日历或变更记录。' : '建议关联前后故障窗口，判断是否为临时修复动作。',
      reusable_summary: `${groupName} 出现「${metrics.change_label || candidate.title}」${planned}${actor ? `，发送方 ${actor}` : ''}。`,
      value_dimensions: ['变更类型', '计划/临时', '影响范围', '变更结果'],
    };
  }

  if (candidate.asset_type === 'media_evidence') {
    return {
      ...base,
      primary_use: '建立截图、报错图、设备照片、配置图、测试结果图的证据索引。',
      review_focus: '人工查看附件是否包含报错、配置、测试结果或设备状态，并补充标签。',
      limitation: 'v1 只沉淀媒体元数据和上下文，不做 OCR/视觉识别，不能替代人工查看图片。',
      suggested_next_step: metrics.media_category === '未分类附件' ? '先人工分类；高价值附件后续进入 OCR/视觉分析队列。' : '确认分类后可作为问题复盘证据或配置知识来源。',
      reusable_summary: `${groupName} 出现「${metrics.media_category || '附件'}」证据，可用于复盘时快速定位原始截图/照片。`,
      value_dimensions: ['附件类型', '上下文消息', '证据链', '后续OCR'],
    };
  }

  if (candidate.asset_type === 'regional_intelligence') {
    const totalAssets = Number(metrics.total_assets || 0);
    const topTypes = Array.isArray(metrics.top_types) ? metrics.top_types.map((item) => item.asset_type).slice(0, 3).join('、') : '';
    return {
      ...base,
      primary_use: '按区域和业务板块汇总近期资产密度，决定优先审核和沉淀方向。',
      review_focus: '查看高价值样本是否集中在风险、动作、承诺或跨区问题上。',
      limitation: '这是聚合情报，不是单条可执行知识；需要下钻到候选资产和来源消息后再确认。',
      suggested_next_step: '优先筛选该区域/板块下的高价值候选，形成区域打法或专项复盘。',
      reusable_summary: totalAssets
        ? `${collectionRegion} / ${businessSector} 近期沉淀 ${totalAssets} 条候选，主要类型 ${topTypes || '待统计'}。`
        : `${collectionRegion} / ${businessSector} 是区域聚合情报入口，需要下钻查看最新候选资产分布。`,
      value_dimensions: ['资产密度', '风险占比', '动作占比', '跨区占比'],
    };
  }

  return {
    ...base,
    primary_use: '作为候选知识资产进入人工审核和后续沉淀。',
    suggested_next_step: '查看来源消息，确认是否具备可复用价值。',
    reusable_summary: candidate.description || candidate.title || '候选知识资产。',
    value_dimensions: ['来源证据', '业务上下文', '复用价值'],
  };
}

function withAssetInsight(candidate) {
  const insight = buildAssetInsight(candidate);
  const targetLibrary = targetLibraryForAsset(candidate);
  const assessment = buildMachineAssessment(candidate, insight);
  assessment.after_confirm = `${assessment.after_confirm} 展示位置：${targetLibrary.label}。`;
  return {
    ...candidate,
    description: insight.reusable_summary || candidate.description,
    metrics: {
      ...(candidate.metrics || {}),
      interaction_side: assessment.interaction_side,
      interaction_label: assessment.interaction_label,
      target_library: targetLibrary.key,
      target_library_label: targetLibrary.label,
      target_library_path: targetLibrary.path,
      target_library_version: 'v2',
      asset_insight: insight,
      machine_assessment: assessment,
    },
  };
}

function candidatesFromMessage(msg) {
  const ctx = regionContext(msg);
  if (ctx.value_label === 'L3') return [];
  const content = msg.content || '';
  const candidates = [];

  for (const entity of extractEntities(content)) {
    candidates.push(withAssetInsight({
      ...baseCandidate(msg, ctx, 'entity_relationship', `${entity.type}:${entity.value}`, `${entity.value} 与 ${msg.group_name || ctx.collection_region} 的关联`),
      description: `实体类型 ${entity.type} 在消息中出现，可作为客户/国家/运营商/路由/设备的关联索引。`,
      confidence: 0.58,
      related_entities: [entity],
      metrics: { entity_type: entity.type, entity_value: entity.value, mention_count: 1, relation_scope: msg.group_name ? 'group' : 'region' },
      dedupe_key: stableHash(['entity', entity.type, entity.value, msg.group_name || '', ctx.business_sector].join('|')),
    }));
  }

  for (const rule of matchRules(content, ACTION_RULES)) {
    const playbook = buildActionPlaybook({ msg, rule });
    candidates.push(withAssetInsight({
      ...baseCandidate(msg, ctx, 'operation_action', rule.key, `${rule.label}: ${msg.group_name}`),
      title: `${rule.label}: ${playbook.problem_summary || msg.group_name}`,
      description: playbook.reusable_summary,
      confidence: playbook.problem_summary ? 0.66 : 0.52,
      metrics: {
        action_key: rule.key,
        action_label: rule.label,
        action_text: redact(content, 180),
        action_actor: msg.sender_name || '',
        action_actor_role: senderRole(msg.sender_name),
        action_actor_role_label: senderRoleLabel(msg.sender_name),
        effectiveness_signal: false,
        action_playbook: playbook,
      },
      related_entities: [{ type: 'action', value: rule.label }],
    }));
  }

  const risks = matchRules(content, RISK_RULES);
  if (risks.length) {
    candidates.push(withAssetInsight({
      ...baseCandidate(msg, ctx, 'risk_pattern', risks.map(r => r.key).sort().join('+'), `${msg.group_name} 风险先兆: ${risks.map(r => r.label).join(' + ')}`),
      description: '实时识别到可复用的风险语言或指标先兆。',
      confidence: risks.some(r => r.key === 'quality_drop') ? 0.68 : 0.58,
      metrics: {
        signal_count: 1,
        signals: risks.map(r => r.label),
        sender_role: senderRole(msg.sender_name),
        sender_role_label: senderRoleLabel(msg.sender_name),
      },
      related_entities: risks.map(r => ({ type: 'risk_signal', value: r.label })),
    }));
  }

  for (const rule of matchRules(content, CHANGE_RULES)) {
    const planned = rule.key === 'planned_maintenance' || /\bplanned|scheduled|maintenance\s+window\b|计划/i.test(content);
    candidates.push(withAssetInsight({
      ...baseCandidate(msg, ctx, 'change_event', rule.key, `${rule.label}: ${msg.group_name}`),
      description: planned ? '计划内变更/维护候选。' : '临时修复或故障后变更候选。',
      confidence: planned ? 0.76 : 0.62,
      metrics: {
        change_key: rule.key,
        change_label: rule.label,
        planned,
        change_actor: msg.sender_name || '',
        change_actor_role: senderRole(msg.sender_name),
        change_actor_role_label: senderRoleLabel(msg.sender_name),
      },
      related_entities: [{ type: 'change', value: rule.label }],
    }));
  }

  if (msg.sender_name && (matchRules(content, ACTION_RULES).length || CLOSE_PATTERN.test(content) || COMMITMENT_PATTERN.test(content))) {
    const role = CLOSE_PATTERN.test(content) ? '恢复确认人' : matchRules(content, ACTION_RULES).length ? '技术处理人' : '协调/客服接口';
    const internal = isInternalStaff(msg.sender_name);
    const roleTitle = internal ? `${msg.sender_name} - 我方${role}` : `${msg.sender_name} - ${role}`;
    candidates.push(withAssetInsight({
      ...baseCandidate(msg, ctx, 'contact_role', `${msg.group_name}:${msg.sender_name}:${role}`, roleTitle),
      description: internal ? '基于内部白名单确认的我方群内角色，可用于内部协作和升级路径。' : '基于动作、闭环词或承诺词推断的外部/供应商群内角色候选。',
      confidence: internal ? 0.9 : (role === '技术处理人' ? 0.7 : 0.62),
      metrics: {
        inferred_role: role,
        is_internal_staff: internal,
        contact_side: internal ? 'internal' : 'external',
        message_count: 1,
        action_count: matchRules(content, ACTION_RULES).length ? 1 : 0,
        close_count: CLOSE_PATTERN.test(content) ? 1 : 0,
        commitment_count: COMMITMENT_PATTERN.test(content) ? 1 : 0,
      },
      related_entities: [{ type: 'role', value: role }, { type: 'contact', value: msg.sender_name }, { type: 'contact_side', value: internal ? 'internal' : 'external' }],
      dedupe_key: stableHash(['contact', msg.group_name || '', msg.sender_name, role, internal ? 'internal' : 'external'].join('|')),
    }));
  }

  if (msg.has_media) {
    const category = classifyMedia(msg);
    candidates.push(withAssetInsight({
      ...baseCandidate(msg, ctx, 'media_evidence', `${category}:${msg.media_path || msg.message_id || msg.id}`, `${category}: ${msg.group_name}`),
      description: '媒体/附件证据索引，v1 仅归档元数据和上下文摘要。',
      confidence: category === '未分类附件' ? 0.48 : 0.68,
      metrics: { media_category: category, media_path: msg.media_path || '', platform: msg.platform },
      related_entities: [{ type: 'media_category', value: category }],
    }));
  }

  return candidates;
}

function processNewMessages() {
  const cursor = getCursor(MESSAGE_ANALYZER, 'message');
  const rows = sourceDb.prepare(`
    SELECT id, platform, receiver_account, message_id, group_id, group_name,
           sender_id, sender_name, content, has_media, media_path, timestamp, business_sector
    FROM messages
    WHERE id > ?
      AND (content IS NOT NULL OR has_media = 1)
    ORDER BY id ASC
    LIMIT ?
  `).all(cursor.last_msg_id || 0, BATCH_SIZE);

  if (!rows.length) return 0;
  const candidates = rows.flatMap(candidatesFromMessage);
  upsertCandidates(analyticsDb, candidates);
  const last = rows[rows.length - 1];
  updateCursor(MESSAGE_ANALYZER, last.id, last.timestamp || 0);
  console.log(`[knowledge-asset] messages=${rows.length}, candidates=${candidates.length}, last=${last.id}`);
  return rows.length;
}

function processCommitments() {
  const cursor = getCursor(COMMITMENT_ANALYZER, 'issue');
  const rows = analyticsDb.prepare(`
    SELECT ir.id, ir.group_name, ir.group_id, ir.region, ir.business_sector,
           ir.issue_type, ir.status, ir.opened_at, ir.closed_at, ir.duration_mins,
           ir.commitment_text, ir.commitment_due, ir.commitment_met, ir.closed_by,
           ar.receiver_account, ar.source_msg_ids
    FROM issue_records ir
    LEFT JOIN alert_records ar ON ar.id = ir.alert_id
    WHERE ir.id > ?
      AND ir.commitment_text IS NOT NULL
      AND TRIM(ir.commitment_text) != ''
    ORDER BY ir.id ASC
    LIMIT ?
  `).all(cursor.last_msg_id || 0, BATCH_SIZE);

  if (!rows.length) return 0;
  const candidates = rows.map((row) => {
    let sourceIds = [];
    try { sourceIds = JSON.parse(row.source_msg_ids || '[]').filter(Number.isFinite); } catch (_) {}
    const info = getRegionInfo(row.receiver_account);
    const sector = normalizeSector(row.business_sector || info.business_sector);
    const valueLabel = getValueLabel(row.receiver_account, row.group_name);
    return withAssetInsight({
      asset_type: 'sla_commitment',
      asset_key: `${row.group_name}:${row.issue_type}:${row.id}`,
      title: `${row.group_name} 承诺履约记录`,
      description: row.commitment_met === 1 ? '承诺已在截止前闭环。' : row.commitment_met === 0 ? '承诺未按期兑现或仍需复核。' : '承诺尚未形成明确兑现状态。',
      collection_region: row.region || info.region || '未知区',
      business_region: row.region || info.region || '未知区',
      business_sector: sector,
      receiver_account: row.receiver_account || '',
      value_label: valueLabel,
      group_name: row.group_name,
      source_msg_ids: sourceIds,
      time_range: { start: row.opened_at, end: row.closed_at || row.commitment_due || row.opened_at },
      first_seen_at: row.opened_at,
      last_seen_at: row.closed_at || row.commitment_due || row.opened_at,
      confidence: row.commitment_met === null ? 0.58 : 0.82,
      evidence: [redact(row.commitment_text)],
      metrics: {
        issue_id: row.id,
        issue_type: row.issue_type,
        status: row.status,
        duration_mins: row.duration_mins,
        commitment_due: row.commitment_due,
        commitment_met: row.commitment_met,
        closed_by: row.closed_by || '',
      },
      related_entities: [{ type: 'issue_type', value: row.issue_type }],
      extractor: COMMITMENT_ANALYZER,
    });
  });
  upsertCandidates(analyticsDb, candidates);
  const last = rows[rows.length - 1];
  updateCursor(COMMITMENT_ANALYZER, last.id, last.opened_at || 0);
  console.log(`[knowledge-asset] commitments=${rows.length}, last=${last.id}`);
  return rows.length;
}

function confirmOperationActions() {
  const cutoff = Date.now() - ACTION_EFFECT_MIN_MS;
  const rows = analyticsDb.prepare(`
    SELECT *
    FROM knowledge_asset_candidates
    WHERE asset_type = 'operation_action'
      AND review_status = 'pending_review'
      AND COALESCE(first_seen_at, 0) > 0
      AND first_seen_at <= ?
      AND (metrics IS NULL OR metrics NOT LIKE '%"effect_checked":true%')
    ORDER BY asset_value_score DESC, first_seen_at DESC
    LIMIT ?
  `).all(cutoff, ACTION_EFFECT_BATCH);

  if (!rows.length) return 0;
  const updates = [];

  for (const row of rows) {
    const metrics = parseJson(row.metrics, {});
    const evidence = parseJson(row.evidence, []);
    const sourceMsgIds = parseJson(row.source_msg_ids, []);
    const timeRange = parseJson(row.time_range, null);
    const start = timeRange?.start || row.first_seen_at;
    if (!start) continue;

    const sourceMsg = sourceMsgIds.length
      ? sourceDb.prepare('SELECT id, sender_name, content, timestamp, group_name FROM messages WHERE id = ?').get(sourceMsgIds[0])
      : null;
    const context = getActionContext(row.group_name || sourceMsg?.group_name || '', start);
    const closeMsg = sourceDb.prepare(`
      SELECT id, sender_name, content, timestamp
      FROM messages
      WHERE group_name = ?
        AND timestamp > ?
        AND timestamp <= ?
        AND content IS NOT NULL
        AND content != ''
      ORDER BY timestamp ASC
      LIMIT 100
    `).all(row.group_name || '', start, start + ACTION_EFFECT_WINDOW_MS)
      .find((msg) => CLOSE_PATTERN.test(msg.content));
    const actionRule = ACTION_RULES.find((rule) => rule.key === metrics.action_key) || { key: metrics.action_key || row.asset_key, label: metrics.action_label || row.title };
    const playbook = buildActionPlaybook({ row, msg: sourceMsg, rule: actionRule, closeMsg, context });

    const nextMetrics = {
      ...metrics,
      action_text: playbook.action_text,
      action_actor: playbook.action_actor,
      action_actor_role: playbook.action_actor_role,
      action_actor_role_label: playbook.action_actor_role_label,
      action_playbook: playbook,
      effect_checked: true,
      effect_checked_at: Date.now(),
      effectiveness_signal: !!closeMsg,
      effect_msg_id: closeMsg?.id || null,
      effect_delay_mins: closeMsg ? Number(((closeMsg.timestamp - start) / 60000).toFixed(1)) : null,
    };

    updates.push(withAssetInsight({
      dedupe_key: row.dedupe_key,
      asset_type: row.asset_type,
      asset_key: row.asset_key,
      title: `${playbook.action_label}: ${playbook.problem_summary || row.group_name}`,
      description: playbook.reusable_summary,
      collection_region: row.collection_region,
      business_region: row.business_region,
      business_sector: row.business_sector,
      receiver_account: row.receiver_account,
      value_label: row.value_label,
      group_name: row.group_name,
      source_msg_ids: Array.from(new Set([...sourceMsgIds, ...playbook.context_msg_ids])),
      time_range: { start, end: closeMsg?.timestamp || timeRange?.end || start },
      evidence: [
        playbook.problem_summary && `问题：${playbook.problem_summary}`,
        playbook.action_text && `动作：${playbook.action_text}`,
        playbook.result_signal && `结果：${playbook.result_signal}`,
        ...evidence,
      ].filter(usefulEvidenceLine).slice(0, 8),
      metrics: nextMetrics,
      related_entities: parseJson(row.related_entities, []),
      confidence: closeMsg ? Math.max(Number(row.confidence || 0), 0.78) : Number(row.confidence || 0.58),
      frequency: row.frequency || 1,
      first_seen_at: row.first_seen_at,
      last_seen_at: closeMsg?.timestamp || row.last_seen_at,
      extractor: MESSAGE_ANALYZER,
      validation_status: closeMsg ? 'effect_validated' : 'rule_validated',
    }));
  }

  if (updates.length) upsertCandidates(analyticsDb, updates);
  const confirmed = updates.filter((item) => item.metrics.effectiveness_signal).length;
  console.log(`[knowledge-asset] action_effect_checked=${updates.length}, confirmed=${confirmed}`);
  return updates.length;
}

function enrichOperationActionPlaybooks() {
  const rows = analyticsDb.prepare(`
    SELECT *
    FROM knowledge_asset_candidates
    WHERE asset_type = 'operation_action'
      AND COALESCE(first_seen_at, 0) > 0
      AND (
        metrics IS NULL
        OR metrics NOT LIKE '%"action_playbook"%'
        OR metrics LIKE '%"problem_summary":"ok"%'
        OR metrics LIKE '%"problem_summary":"OK"%'
        OR metrics LIKE '%"problem_summary":"Done"%'
        OR metrics LIKE '%"action_text":"ok"%'
        OR metrics LIKE '%"action_text":"OK"%'
      )
    ORDER BY asset_value_score DESC, first_seen_at DESC
    LIMIT 100
  `).all();

  if (!rows.length) return 0;
  const updates = [];

  for (const row of rows) {
    const metrics = parseJson(row.metrics, {});
    const sourceMsgIds = parseJson(row.source_msg_ids, []);
    const timeRange = parseJson(row.time_range, null);
    const start = timeRange?.start || row.first_seen_at;
    if (!start) continue;
    const sourceMsg = sourceMsgIds.length
      ? sourceDb.prepare('SELECT id, sender_name, content, timestamp, group_name FROM messages WHERE id = ?').get(sourceMsgIds[0])
      : null;
    const closeMsg = metrics.effect_msg_id
      ? sourceDb.prepare('SELECT id, sender_name, content, timestamp FROM messages WHERE id = ?').get(metrics.effect_msg_id)
      : null;
    const actionRule = ACTION_RULES.find((rule) => rule.key === metrics.action_key || rule.key === row.asset_key) || { key: metrics.action_key || row.asset_key, label: metrics.action_label || row.title };
    const playbook = buildActionPlaybook({ row, msg: sourceMsg, rule: actionRule, closeMsg });

    updates.push(withAssetInsight({
      dedupe_key: row.dedupe_key,
      asset_type: row.asset_type,
      asset_key: row.asset_key,
      title: `${playbook.action_label}: ${playbook.problem_summary || row.group_name}`,
      description: playbook.reusable_summary,
      collection_region: row.collection_region,
      business_region: row.business_region,
      business_sector: row.business_sector,
      receiver_account: row.receiver_account,
      value_label: row.value_label,
      group_name: row.group_name,
      source_msg_ids: Array.from(new Set([...sourceMsgIds, ...playbook.context_msg_ids])),
      time_range: { start, end: row.last_seen_at || timeRange?.end || start },
      evidence: [
        playbook.problem_summary && `问题：${playbook.problem_summary}`,
        playbook.action_text && `动作：${playbook.action_text}`,
        playbook.result_signal && `结果：${playbook.result_signal}`,
        ...parseJson(row.evidence, []),
      ].filter(usefulEvidenceLine).slice(0, 8),
      metrics: {
        ...metrics,
        action_text: playbook.action_text,
        action_actor: playbook.action_actor,
        action_actor_role: playbook.action_actor_role,
        action_actor_role_label: playbook.action_actor_role_label,
        action_playbook: playbook,
      },
      related_entities: parseJson(row.related_entities, []),
      confidence: playbook.problem_summary ? Math.max(Number(row.confidence || 0), 0.68) : Number(row.confidence || 0.58),
      frequency: row.frequency || 1,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      extractor: MESSAGE_ANALYZER,
      validation_status: row.validation_status || 'context_enriched',
    }));
  }

  upsertCandidates(analyticsDb, updates);
  console.log(`[knowledge-asset] action_playbook_enriched=${updates.length}`);
  return updates.length;
}

function enrichGeneralAssetInsights() {
  const rows = analyticsDb.prepare(`
    SELECT *
    FROM knowledge_asset_candidates
    WHERE (
        metrics IS NULL
        OR metrics NOT LIKE '%"asset_insight"%'
        OR metrics NOT LIKE '%"insight_version":"v2"%'
        OR metrics NOT LIKE '%"machine_assessment"%'
        OR metrics NOT LIKE '%"assessment_version":"v2"%'
        OR metrics NOT LIKE '%"target_library"%'
        OR metrics NOT LIKE '%"target_library_version":"v2"%'
      )
    ORDER BY asset_value_score DESC, last_seen_at DESC
    LIMIT ?
  `).all(ENRICH_BATCH);

  if (!rows.length) return 0;
  const updates = rows.map((row) => {
    const candidate = {
      dedupe_key: row.dedupe_key,
      asset_type: row.asset_type,
      asset_key: row.asset_key,
      title: row.title,
      description: row.description,
      collection_region: row.collection_region,
      business_region: row.business_region,
      business_sector: row.business_sector,
      receiver_account: row.receiver_account,
      value_label: row.value_label,
      group_name: row.group_name,
      source_msg_ids: parseJson(row.source_msg_ids, []),
      time_range: parseJson(row.time_range, null),
      evidence: parseJson(row.evidence, []),
      metrics: parseJson(row.metrics, {}),
      related_entities: parseJson(row.related_entities, []),
      confidence: Number(row.confidence || 0.5),
      frequency: row.frequency || 1,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      extractor: row.extractor || MESSAGE_ANALYZER,
      validation_status: row.validation_status || 'insight_enriched',
    };
    return withAssetInsight(candidate);
  });

  upsertCandidates(analyticsDb, updates);
  console.log(`[knowledge-asset] asset_insight_enriched=${updates.length}`);
  return updates.length;
}

function autoPromoteMachineAssessedAssets() {
  const rows = analyticsDb.prepare(`
    SELECT *
    FROM knowledge_asset_candidates
    WHERE review_status = 'pending_review'
      AND json_extract(metrics, '$.machine_assessment.manual_review_required') = 0
      AND json_extract(metrics, '$.machine_assessment.decision') IN ('auto_ready', 'auto_index', 'auto_insight')
    ORDER BY asset_value_score DESC, confidence DESC, last_seen_at DESC
    LIMIT ?
  `).all(AUTO_PROMOTE_BATCH);

  if (!rows.length) return 0;
  let promoted = 0;
  for (const row of rows) {
    try {
      const candidate = hydrateCandidateRow(row);
      const targetLibrary = targetLibraryForAsset(candidate);
      candidate.metrics = {
        ...(candidate.metrics || {}),
        target_library: targetLibrary.key,
        target_library_label: targetLibrary.label,
        target_library_path: targetLibrary.path,
        auto_promoted: true,
        auto_promoted_at: Date.now(),
      };
      promoteCandidateToAsset(analyticsDb, candidate, 'machine_assessment');
      promoted += 1;
    } catch (err) {
      console.error(`[knowledge-asset] auto_promote failed ${row.dedupe_key}:`, err.message);
    }
  }
  console.log(`[knowledge-asset] auto_promoted=${promoted}`);
  return promoted;
}

function buildRegionalIntelligence() {
  const since = Date.now() - REGIONAL_INTELLIGENCE_WINDOW_MS;
  const groups = analyticsDb.prepare(`
    SELECT collection_region, business_sector,
           COUNT(*) AS total,
           SUM(CASE WHEN asset_type = 'risk_pattern' THEN 1 ELSE 0 END) AS risk_count,
           SUM(CASE WHEN asset_type = 'operation_action' THEN 1 ELSE 0 END) AS action_count,
           SUM(CASE WHEN asset_type = 'sla_commitment' THEN 1 ELSE 0 END) AS commitment_count,
           SUM(CASE WHEN asset_type = 'media_evidence' THEN 1 ELSE 0 END) AS media_count,
           SUM(CASE WHEN business_region IS NOT NULL AND collection_region IS NOT NULL AND business_region != collection_region THEN 1 ELSE 0 END) AS cross_region_count,
           ROUND(AVG(asset_value_score), 1) AS avg_value,
           ROUND(AVG(confidence), 2) AS avg_confidence,
           MIN(first_seen_at) AS first_seen_at,
           MAX(last_seen_at) AS last_seen_at
    FROM knowledge_asset_candidates
    WHERE asset_type != 'regional_intelligence'
      AND COALESCE(last_seen_at, first_seen_at, 0) >= ?
      AND collection_region IS NOT NULL
      AND business_sector IS NOT NULL
    GROUP BY collection_region, business_sector
    HAVING total >= 3
    ORDER BY total DESC
    LIMIT 80
  `).all(since);

  if (!groups.length) return 0;

  const sampleStmt = analyticsDb.prepare(`
    SELECT asset_type, title, source_msg_ids, evidence, metrics, asset_value_score
    FROM knowledge_asset_candidates
    WHERE asset_type != 'regional_intelligence'
      AND collection_region = ?
      AND business_sector = ?
      AND COALESCE(last_seen_at, first_seen_at, 0) >= ?
    ORDER BY asset_value_score DESC, confidence DESC, last_seen_at DESC
    LIMIT 8
  `);
  const typeStmt = analyticsDb.prepare(`
    SELECT asset_type, COUNT(*) AS count
    FROM knowledge_asset_candidates
    WHERE asset_type != 'regional_intelligence'
      AND collection_region = ?
      AND business_sector = ?
      AND COALESCE(last_seen_at, first_seen_at, 0) >= ?
    GROUP BY asset_type
    ORDER BY count DESC
    LIMIT 5
  `);

  const candidates = groups.map((group) => {
    const samples = sampleStmt.all(group.collection_region, group.business_sector, since);
    const sourceIds = [];
    const evidence = [];
    for (const sample of samples) {
      sourceIds.push(...parseJson(sample.source_msg_ids, []));
      const sampleEvidence = parseJson(sample.evidence, []);
      if (sampleEvidence[0]) evidence.push(`${sample.title}: ${sampleEvidence[0]}`);
    }
    const topTypes = typeStmt.all(group.collection_region, group.business_sector, since);
    const day = new Date().toISOString().slice(0, 10);
    return withAssetInsight({
      dedupe_key: stableHash(['regional', day, group.collection_region, group.business_sector].join('|')),
      asset_type: 'regional_intelligence',
      asset_key: `${group.collection_region}:${group.business_sector}:${day}`,
      title: `${group.collection_region} / ${group.business_sector} 运营情报`,
      description: `近 24 小时沉淀 ${group.total} 条候选资产，其中风险 ${group.risk_count || 0}、动作 ${group.action_count || 0}、承诺 ${group.commitment_count || 0}、媒体证据 ${group.media_count || 0}。`,
      collection_region: group.collection_region,
      business_region: group.collection_region,
      business_sector: group.business_sector,
      value_label: 'L1',
      group_name: '',
      source_msg_ids: Array.from(new Set(sourceIds)).filter(Boolean).slice(0, 50),
      time_range: { start: group.first_seen_at, end: group.last_seen_at },
      first_seen_at: group.first_seen_at,
      last_seen_at: group.last_seen_at,
      confidence: Math.min(0.86, Math.max(0.55, Number(group.avg_confidence || 0.55))),
      frequency: group.total,
      evidence: evidence.slice(0, 6),
      metrics: {
        window_hours: Math.round(REGIONAL_INTELLIGENCE_WINDOW_MS / 3600000),
        total_assets: group.total,
        risk_count: group.risk_count || 0,
        action_count: group.action_count || 0,
        commitment_count: group.commitment_count || 0,
        media_count: group.media_count || 0,
        cross_region_count: group.cross_region_count || 0,
        avg_value: group.avg_value || 0,
        top_types: topTypes,
      },
      related_entities: [
        { type: 'region', value: group.collection_region },
        { type: 'business_sector', value: group.business_sector },
      ],
      extractor: MESSAGE_ANALYZER,
      validation_status: 'aggregate_validated',
    });
  });

  upsertCandidates(analyticsDb, candidates);
  console.log(`[knowledge-asset] regional_intelligence=${candidates.length}`);
  return candidates.length;
}

async function tick() {
  try {
    processNewMessages();
    processCommitments();
    confirmOperationActions();
    enrichOperationActionPlaybooks();
    enrichGeneralAssetInsights();
    autoPromoteMachineAssessedAssets();
    buildRegionalIntelligence();
  } catch (err) {
    console.error('[knowledge-asset] tick failed:', err.message);
  }
  setTimeout(tick, SCAN_INTERVAL);
}

module.exports = {
  candidatesFromMessage,
  buildRegionalIntelligence,
  confirmOperationActions,
  enrichOperationActionPlaybooks,
  enrichGeneralAssetInsights,
  autoPromoteMachineAssessedAssets,
  processCommitments,
  processNewMessages,
  redact,
  buildAssetInsight,
};

if (require.main === module) {
  if (process.argv.includes('--now')) {
    try {
      processNewMessages();
      processCommitments();
      confirmOperationActions();
      enrichOperationActionPlaybooks();
      enrichGeneralAssetInsights();
      autoPromoteMachineAssessedAssets();
      buildRegionalIntelligence();
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  }

  console.log(`[knowledge-asset] started, interval=${SCAN_INTERVAL}ms, startFromNow=${START_FROM_NOW}`);
  tick();

  process.on('SIGINT', () => {
    try { sourceDb.close(); } catch (_) {}
    try { analyticsDb.close(); } catch (_) {}
    process.exit(0);
  });
}
