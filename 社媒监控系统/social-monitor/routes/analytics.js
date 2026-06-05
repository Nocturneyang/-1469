const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const {
    hydrateAssetRow,
    LIBRARY_LABELS,
    promoteCandidateToAsset,
    TYPE_LABELS,
    normalizeSector,
    targetLibraryForAsset,
} = require('../lib/knowledge-assets');
const aiClient = require('../lib/ai-client');

const ANALYTICS_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'db', 'analytics.sqlite');
const SOURCE_DB_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'db', 'database.sqlite');
const STAFF_CONFIG_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'internal-staff.json');
const ACCOUNT_REGION_CONFIG_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'account-regions.json');
let _analyticsDb = null;
let _sourceDb = null;

function getAnalyticsDb() {
    if (_analyticsDb) return _analyticsDb;
    if (!fs.existsSync(ANALYTICS_PATH)) return null;
    try {
        const Database = require('better-sqlite3');
        _analyticsDb = new Database(ANALYTICS_PATH, { readonly: true });
        return _analyticsDb;
    } catch (e) {
        console.error('[server] 无法打开 analytics.sqlite:', e.message);
        return null;
    }
}

function getSourceDb() {
    if (_sourceDb) return _sourceDb;
    if (!fs.existsSync(SOURCE_DB_PATH)) return null;
    try {
        const Database = require('better-sqlite3');
        _sourceDb = new Database(SOURCE_DB_PATH, { readonly: true });
        return _sourceDb;
    } catch (e) {
        console.error('[server] 无法打开 database.sqlite:', e.message);
        return null;
    }
}

function openWritableAnalyticsDb() {
    if (!fs.existsSync(ANALYTICS_PATH)) return null;
    const Database = require('better-sqlite3');
    const db = new Database(ANALYTICS_PATH);
    db.pragma('journal_mode = WAL');
    return db;
}

function tableExists(db, tableName) {
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName);
        return !!row;
    } catch (_) {
        return false;
    }
}

function safeJson(value, fallback) {
    if (value == null || value === '') return fallback;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function redactMessageText(text, maxLen = 220) {
    return String(text || '')
        .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '[url]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
        .replace(/(?:密码|password|passwd|pwd|pass)\s*[:：=]?\s*[^\s,，;；]+/gi, '密码 [secret]')
        .replace(/\b(?:root|admin)\s+[A-Za-z0-9@#._-]{4,}\b/gi, '[credential]')
        .replace(/(?<!\d)\+?\d[\d\s().-]{5,}\d(?!\d)/g, '[number]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

function readStaffConfig() {
    try {
        if (!fs.existsSync(STAFF_CONFIG_PATH)) {
            return { whitelist: ['ITNIO~ DJ', 'ITNIO Support', 'Routing'], keywords: ['itnio', 'support', 'routing'], external_contacts: [] };
        }
        const config = JSON.parse(fs.readFileSync(STAFF_CONFIG_PATH, 'utf8'));
        return {
            whitelist: Array.isArray(config.whitelist) ? config.whitelist : [],
            keywords: Array.isArray(config.keywords) ? config.keywords : [],
            external_contacts: Array.isArray(config.external_contacts) ? config.external_contacts : [],
        };
    } catch (_) {
        return { whitelist: [], keywords: ['itnio', 'support', 'routing'], external_contacts: [] };
    }
}

function writeStaffConfig(config) {
    fs.mkdirSync(path.dirname(STAFF_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(STAFF_CONFIG_PATH, JSON.stringify({
        whitelist: Array.from(new Set(config.whitelist || [])).filter(Boolean),
        keywords: Array.from(new Set(config.keywords || [])).filter(Boolean),
        external_contacts: Array.from(new Set(config.external_contacts || [])).filter(Boolean),
    }, null, 2), 'utf8');
}

let _accountRegionMap = null;

function getAccountRegionMap() {
    if (_accountRegionMap) return _accountRegionMap;
    const map = new Map();
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGION_CONFIG_PATH, 'utf8'));
        for (const item of config.accounts || []) {
            if (!item?.account) continue;
            map.set(item.account, {
                region: item.region || '未知区',
                business_sector: normalizeSector(item.business_sector),
                value_label: item.value_label || 'L1',
                platform: item.platform || '',
            });
        }
    } catch (_) {}
    _accountRegionMap = map;
    return map;
}

function intelligenceScopeForRegion(region) {
    const name = String(region || '').trim();
    if (!name || name === '未知区') {
        return {
            key: 'unknown',
            label: '未识别归属',
            region_label: '归属',
            description: '账号或资产未映射到明确市场区域或业务域。',
        };
    }
    if (['欧美区', '南亚区', '亚太区', '语音'].includes(name) || /区$/.test(name)) {
        return {
            key: 'market',
            label: name === '语音' ? '语音市场' : '市场区域',
            region_label: '区域',
            description: '按真实市场区域或市场线聚合，适合判断需求、价格、资源效果和风险变化。',
        };
    }
    return {
        key: 'domain',
        label: '业务域',
        region_label: '业务域',
        description: '按采集账号或业务支持线聚合，适合看设备支持、客服、卡线等内部运营域。',
    };
}

function normalizeIntelligenceScope(value) {
    const scope = String(value || 'market').trim().toLowerCase();
    if (['market', 'domain', 'all', 'unknown'].includes(scope)) return scope;
    return 'market';
}

function intelligenceScopeMeta(scope) {
    const normalized = normalizeIntelligenceScope(scope);
    if (normalized === 'market') {
        return {
            key: 'market',
            label: '市场区域',
            region_label: '区域',
            description: '仅展示欧美区、南亚区、亚太区、语音等市场维度，避免混入采集域。',
        };
    }
    if (normalized === 'domain') {
        return {
            key: 'domain',
            label: '业务域',
            region_label: '业务域',
            description: '展示 WA设备技术、TG设备支持、客服、卡线等采集域和运营线。',
        };
    }
    if (normalized === 'unknown') {
        return {
            key: 'unknown',
            label: '未识别归属',
            region_label: '归属',
            description: '展示暂未完成账号区域映射的消息和资产。',
        };
    }
    return {
        key: 'all',
        label: '全部归属',
        region_label: '归属',
        description: '混合展示市场区域、业务域和未识别归属，仅用于排查数据口径。',
    };
}

function scopeMatchesRegion(region, scope) {
    const normalized = normalizeIntelligenceScope(scope);
    if (normalized === 'all') return true;
    return intelligenceScopeForRegion(region).key === normalized;
}

function contactNameFromAsset(asset) {
    const contact = (asset.related_entities || []).find(item => item.type === 'contact' && item.value);
    if (contact?.value) return String(contact.value).trim();
    const keyParts = String(asset.asset_key || '').split(':');
    if (keyParts.length >= 2) return keyParts[keyParts.length - 2].trim();
    const title = String(asset.title || '');
    if (title.includes(' - ')) return title.split(' - ')[0].trim();
    return '';
}

function retagContactAsset(asset, side, actor) {
    const contactName = contactNameFromAsset(asset);
    const role = asset.metrics?.inferred_role || '联系人';
    const internal = side === 'internal';
    const nextMetrics = {
        ...(asset.metrics || {}),
        is_internal_staff: internal,
        contact_side: internal ? 'internal' : 'external',
        identity_override: side,
        identity_override_by: actor,
        identity_override_at: Date.now(),
        machine_assessment: {
            ...(asset.metrics?.machine_assessment || {}),
            assessment_version: 'v1',
            decision: 'auto_ready',
            label: internal ? '可自动沉淀' : '外部已确认',
            reason: internal ? '人工已标记为我方人员，并同步进入内部白名单。' : '人工已标记为外部联系人，并同步进入外部联系人覆盖名单。',
            manual_review_required: false,
            review_priority: 'low',
            interaction_side: asset.metrics?.machine_assessment?.interaction_side || asset.metrics?.interaction_side || 'other',
            interaction_label: asset.metrics?.machine_assessment?.interaction_label || asset.metrics?.interaction_label || '其他交互',
            after_confirm: internal
                ? '确认后成为我方联系人/升级路径资产，用于内部协作和故障升级找人。'
                : '确认后成为外部/供应商联系人资产，用于供应商画像、技术接口人和响应能力分析。',
            human_review_when: '身份已人工标记，后续只需在发现误判时修正。',
        },
    };
    const nextInsight = {
        ...(nextMetrics.asset_insight || {}),
        primary_use: internal ? '沉淀我方协作角色和升级路径，便于故障时找到内部处理人。' : '识别外部或供应商侧接口人，便于问题升级时找对角色。',
        review_focus: internal ? '确认该联系人是否确为我方人员，以及角色是否由群内行为支撑。' : '确认该联系人是否代表供应商、客户或资源使用方。',
        limitation: internal ? '身份已人工标记，但具体职责仍需结合群内行为判断。' : '外部身份已人工标记，但仍需区分供应商侧与客户侧角色。',
        suggested_next_step: internal ? '可确认后进入内部联系人/升级路径资产。' : '可确认后进入外部联系人资产，并与供应商或客户群绑定。',
        reusable_summary: `${contactName || asset.title} 已标记为${internal ? '我方人员' : '外部联系人'}，推断角色为「${role}」。`,
    };
    nextMetrics.asset_insight = nextInsight;

    const related = [
        ...(asset.related_entities || []).filter(item => item.type !== 'contact_side'),
        { type: 'contact_side', value: internal ? 'internal' : 'external' },
    ];
    return {
        title: contactName ? `${contactName} - ${internal ? '我方' : ''}${role}` : asset.title,
        description: nextInsight.reusable_summary,
        metrics: nextMetrics,
        related_entities: related,
    };
}

function mapKnowledgeAsset(row) {
    if (!row) return null;
    return {
        ...row,
        source_msg_ids: safeJson(row.source_msg_ids, []),
        time_range: safeJson(row.time_range, null),
        evidence: safeJson(row.evidence, []).map(item => redactMessageText(item, 220)),
        metrics: safeJson(row.metrics, {}),
        related_entities: safeJson(row.related_entities, []),
        value_reasons: safeJson(row.value_reasons, []),
    };
}

function mapFormalKnowledgeAsset(row) {
    const asset = hydrateAssetRow(row);
    if (!asset) return null;
    const targetLibrary = targetLibraryForAsset(asset);
    return {
        ...asset,
        target_library: targetLibrary.key,
        target_library_label: targetLibrary.label,
        target_library_path: targetLibrary.path,
        evidence: (asset.evidence || []).map(item => redactMessageText(item, 220)),
    };
}

function relatedValue(asset, type) {
    return (asset.related_entities || []).find(item => item.type === type && item.value)?.value || '';
}

function cleanKnowledgeText(value, maxLen = 180) {
    return String(value || '')
        .replace(/^(问题|动作|结果|执行内容|处理动作|结果信号)\s*[:：]\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

function metricValue(db, sql, params = [], fallback = 0) {
    try {
        if (!db) return fallback;
        const row = db.prepare(sql).get(...params);
        if (!row) return fallback;
        const key = Object.keys(row)[0];
        return row[key] ?? fallback;
    } catch (_) {
        return fallback;
    }
}

function metricRows(db, sql, params = []) {
    try {
        if (!db) return [];
        return db.prepare(sql).all(...params);
    } catch (_) {
        return [];
    }
}

function pct(numerator, denominator) {
    const total = Number(denominator || 0);
    if (!total) return 0;
    return Math.round((Number(numerator || 0) / total) * 100);
}

function growthPct(current, previous) {
    const prev = Number(previous || 0);
    if (!prev) return Number(current || 0) > 0 ? 100 : 0;
    return Math.round(((Number(current || 0) - prev) / prev) * 100);
}

function formatRouteScope(row) {
    return [row.region || '未知区', row.business_sector || '未分类']
        .filter(Boolean)
        .join(' / ');
}

function evidenceByPrefix(asset, prefix) {
    const mark = `${prefix}：`;
    return (asset.evidence || [])
        .map(item => String(item || '').trim())
        .find(item => item.startsWith(mark));
}

function usefulEvidence(asset) {
    return (asset.evidence || [])
        .map(item => cleanKnowledgeText(item))
        .find(item => item && !/^(Done|OK|Ok|done|ok)$/i.test(item));
}

function isGenericAssetSummary(value) {
    return !value
        || /同一群\/同一天出现可复用的风险语言/.test(value)
        || /动作已出现/.test(value)
        || /实时识别到运营处理动作/.test(value)
        || /效果需人工复核/.test(value);
}

function assetProblemSummary(asset) {
    const playbook = asset.metrics?.action_playbook || {};
    const explicitProblem = cleanKnowledgeText(playbook.problem_summary || '');
    if (explicitProblem) return explicitProblem;

    const problemEvidence = cleanKnowledgeText(evidenceByPrefix(asset, '问题') || '');
    if (problemEvidence) return problemEvidence;

    if (!isGenericAssetSummary(asset.summary)) return cleanKnowledgeText(asset.summary);

    const evidence = usefulEvidence(asset);
    if (evidence) return evidence;

    const signals = Array.isArray(asset.metrics?.signals) ? asset.metrics.signals.filter(Boolean) : [];
    if (signals.length) return `${signals.join('/')} 信号重复出现`;

    return cleanKnowledgeText(asset.title || '待补充问题现象');
}

function uniqueKnowledgeTerms(values, limit = 6) {
    const banned = new Set([
        'QA 知识库',
        '设备知识库',
        '内容模板库',
        '供应商画像',
        '资产发现',
        '可自动沉淀',
        '需人工复核',
        '自动索引',
        '自动情报',
        '资源提供方交互',
        '资源使用方交互',
    ]);
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = cleanKnowledgeText(value, 40);
        if (!text || banned.has(text) || TYPE_LABELS[text]) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= limit) break;
    }
    return out;
}

function inferIssueCategory(text, fallback = '其他') {
    const content = String(text || '').toLowerCase();
    if (/otp|验证码|code|收不到|receive/.test(content)) return 'OTP未送达';
    if (/gateway|down|offline|掉线|remote|anydesk|teamviewer|远程/.test(content)) return '设备掉线与远程故障';
    if (/restart|reboot|reset|重启|复位/.test(content)) return '设备重启/复位';
    if (/port|端口|并发/.test(content)) return '端口异常';
    if (/blocked|block|拦截|封锁|失败|fail|failed/.test(content)) return '发送失败/拦截风险';
    if (/timeout|delay|eta|超时|延迟|等待/.test(content)) return '延迟/超时';
    return fallback;
}

function keywordHintsFromText(text) {
    const content = String(text || '').toLowerCase();
    const terms = [];
    if (/otp|验证码|code/.test(content)) terms.push('OTP', '验证码');
    if (/收不到|receive/.test(content)) terms.push('未收到');
    if (/gateway|网关/.test(content)) terms.push('网关');
    if (/down|offline|掉线/.test(content)) terms.push('掉线');
    if (/remote|anydesk|teamviewer|远程/.test(content)) terms.push('远程');
    if (/restart|reboot|重启/.test(content)) terms.push('重启');
    if (/reset|复位/.test(content)) terms.push('复位');
    if (/blocked|block|拦截|封锁/.test(content)) terms.push('拦截');
    if (/sim|卡/.test(content)) terms.push('SIM');
    if (/port|端口/.test(content)) terms.push('端口');
    if (/timeout|超时/.test(content)) terms.push('超时');
    if (/delay|eta|延迟/.test(content)) terms.push('延迟');
    return terms;
}

function inferDeviceCategory(text, fallback = '其他') {
    const content = String(text || '').toLowerCase();
    if (/remote|anydesk|teamviewer|远程/.test(content)) return '远程排查';
    if (/restart|reboot|reset|重启|复位/.test(content)) return '重启设备/服务';
    if (/port|端口|并发/.test(content)) return '端口';
    if (/sim|blocked|block|拦截|封锁|卡/.test(content)) return 'SIM/拦截';
    if (/gateway|down|offline|掉线|network|网络|连接/.test(content)) return '网络';
    if (/config|setting|配置|规则|rule/.test(content)) return '配置';
    return fallback;
}

function numberedSteps(lines) {
    return (lines || [])
        .map(item => cleanKnowledgeText(item, 260))
        .filter(Boolean)
        .filter((item, index, arr) => arr.indexOf(item) === index)
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n');
}

function qaStepsForAsset(asset, problem) {
    const playbook = asset.metrics?.action_playbook || {};
    const actionLabel = cleanKnowledgeText(playbook.action_label || asset.metrics?.action_label || '');
    const actionText = cleanKnowledgeText(playbook.action_text || evidenceByPrefix(asset, '动作') || '');
    const resultSignal = cleanKnowledgeText(playbook.result_signal || evidenceByPrefix(asset, '结果') || '');
    const signals = Array.isArray(asset.metrics?.signals) ? asset.metrics.signals.filter(Boolean) : [];

    if (asset.asset_type === 'risk_pattern') {
        return [
            `确认是否连续出现「${signals.join('/')}」等同类反馈`,
            '查看后续 1-2 小时是否有追问、失败、超时、告警或恢复反馈',
            '若同类信号重复出现，升级为风险预警并补充处理结论',
        ];
    }

    return [
        problem && `确认问题现象：${problem}`,
        actionText || actionLabel,
        resultSignal && `确认处理结果：${resultSignal}`,
        !resultSignal && '处理后继续观察是否恢复，并补充最终闭环结果',
    ].filter(Boolean);
}

function deviceStepsForAsset(asset, problem) {
    const playbook = asset.metrics?.action_playbook || {};
    const actionLabel = cleanKnowledgeText(playbook.action_label || asset.metrics?.action_label || '');
    const actionText = cleanKnowledgeText(playbook.action_text || evidenceByPrefix(asset, '动作') || '');
    const resultSignal = cleanKnowledgeText(playbook.result_signal || evidenceByPrefix(asset, '结果') || '');
    const signals = Array.isArray(asset.metrics?.signals) ? asset.metrics.signals.filter(Boolean) : [];

    if (asset.asset_type === 'risk_pattern') {
        return numberedSteps([
            `确认设备/线路是否反复出现「${signals.join('/')}」`,
            '检查同一时间窗口内是否伴随发送失败、阻断、超时或恢复反馈',
            '重复出现时暂停扩大流量，先做小量测试并记录可用窗口',
        ]);
    }

    return numberedSteps([
        problem && `确认故障现象：${problem}`,
        actionText || actionLabel,
        resultSignal && `验证结果：${resultSignal}`,
        !resultSignal && '处理后测试发送或远程连接是否恢复',
    ]);
}

const FORMAL_LIBRARY_SCAN_LIMIT = 50000;

function formalAssetsForLibrary(db, library, limit = 2000) {
    if (!db || !tableExists(db, 'knowledge_assets')) return [];
    return db.prepare(`
        SELECT *
        FROM knowledge_assets
        WHERE status = 'active'
        ORDER BY asset_value_score DESC, quality_score DESC, last_seen_at DESC
        LIMIT ?
    `).all(FORMAL_LIBRARY_SCAN_LIMIT)
        .map(mapFormalKnowledgeAsset)
        .filter(asset => asset.target_library === library)
        .slice(0, limit);
}

function formalAssetToQa(asset) {
    const playbook = asset.metrics?.action_playbook || {};
    const signals = Array.isArray(asset.metrics?.signals) ? asset.metrics.signals : [];
    const question = assetProblemSummary(asset);
    const issueCategory = asset.asset_type === 'risk_pattern' && signals.length
        ? `${signals[0]}预警`
        : inferIssueCategory(question, playbook.action_label || asset.metrics?.action_label || TYPE_LABELS[asset.asset_type] || '其他');
    const steps = qaStepsForAsset(asset, question);
    const keywords = uniqueKnowledgeTerms([
        ...signals,
        playbook.action_label,
        asset.metrics?.action_label,
        asset.metrics?.change_label,
        ...keywordHintsFromText(question),
    ]);
    return {
        id: `asset-${asset.asset_uid}`,
        source_type: 'asset_discovery',
        source_asset_uid: asset.asset_uid,
        business_sector: asset.business_sector,
        question_type: issueCategory,
        question_summary: question,
        question_keywords: keywords,
        answer_pattern: numberedSteps(steps) || cleanKnowledgeText(asset.summary || asset.title),
        answer_steps: steps.length ? steps : [cleanKnowledgeText(asset.summary || asset.title)],
        answer_category: issueCategory,
        source_group_name: asset.group_name,
        source_msg_ids: asset.source_msg_ids,
        frequency: asset.frequency || 1,
        confidence: asset.confidence || 0.5,
        created_at: asset.created_at,
    };
}

function formalAssetToDeviceKb(asset) {
    const playbook = asset.metrics?.action_playbook || {};
    const deviceModel = relatedValue(asset, 'device_model')
        || (asset.metrics?.entity_type === 'device_model' ? asset.metrics.entity_value : '')
        || asset.group_name
        || asset.title;
    const fault = assetProblemSummary(asset);
    const solution = deviceStepsForAsset(asset, fault);
    const category = inferDeviceCategory(
        [fault, playbook.action_label, asset.metrics?.action_label, (asset.metrics?.signals || []).join(' ')].join(' '),
        asset.metrics?.action_label || asset.metrics?.change_label || TYPE_LABELS[asset.asset_type] || '其他'
    );
    return {
        id: `asset-${asset.asset_uid}`,
        source_type: 'asset_discovery',
        source_asset_uid: asset.asset_uid,
        device_model: deviceModel,
        device_type: asset.metrics?.entity_type === 'device_model' ? '设备实体' : '',
        fault_symptom: fault,
        fault_category: category,
        solution_steps: solution,
        solution_effectiveness: asset.metrics?.effectiveness_signal ? 1 : 0,
        source_group_name: asset.group_name,
        source_msg_ids: JSON.stringify(asset.source_msg_ids || []),
        frequency: asset.frequency || 1,
        last_seen_at: asset.last_seen_at,
        created_at: asset.created_at,
    };
}

function formalAssetToContentTemplate(asset) {
    const customer = relatedValue(asset, 'customer') || asset.group_name || asset.business_sector || '资产发现';
    const content = asset.evidence?.[0]
        || asset.summary
        || asset.metrics?.asset_insight?.reusable_summary
        || asset.title;
    return {
        id: `asset-${asset.asset_uid}`,
        source_type: 'asset_discovery',
        source_asset_uid: asset.asset_uid,
        customer_name: customer,
        template_content: content,
        template_type: asset.metrics?.media_category || TYPE_LABELS[asset.asset_type] || '资产线索',
        target_region: asset.business_region || asset.collection_region,
        approved: null,
        compliance_notes: asset.metrics?.machine_assessment?.reason || asset.metrics?.asset_insight?.limitation || asset.summary,
        source_group_name: asset.group_name,
        source_msg_ids: JSON.stringify(asset.source_msg_ids || []),
        frequency: asset.frequency || 1,
        last_seen_at: asset.last_seen_at,
        created_at: asset.created_at,
    };
}

function qaRowsWithFormalAssets(db) {
    const nativeRows = db.prepare(
        'SELECT * FROM qa_knowledge_base ORDER BY confidence DESC, frequency DESC'
    ).all().map(r => ({
        ...r,
        source_type: 'qa_extractor',
        answer_steps: (r.answer_pattern || '').split('\n').filter(Boolean),
        question_keywords: (r.question_keywords || '').split(/[,，]/).map(k => k.trim()).filter(Boolean),
    }));
    return [...formalAssetsForLibrary(db, 'qa').map(formalAssetToQa), ...nativeRows]
        .sort((a, b) => (Number(b.confidence || 0) - Number(a.confidence || 0)) || (Number(b.frequency || 0) - Number(a.frequency || 0)));
}

function deviceKbRowsWithFormalAssets(db) {
    const nativeRows = db.prepare(
        'SELECT * FROM device_knowledge_graph ORDER BY frequency DESC, last_seen_at DESC'
    ).all().map(row => ({ ...row, source_type: 'device_extractor' }));
    return [...formalAssetsForLibrary(db, 'device').map(formalAssetToDeviceKb), ...nativeRows]
        .sort((a, b) => (Number(b.frequency || 0) - Number(a.frequency || 0)) || (Number(b.last_seen_at || 0) - Number(a.last_seen_at || 0)));
}

const GRAPH_ENTITY_LABELS = {
    region: '区域',
    sector: '业务板块',
    group: '群',
    asset_type: '资产类型',
    operator: '运营商',
    country: '国家/地区',
    customer: '客户',
    supplier: '供应商',
    device_model: '设备型号',
    route: 'Route',
    sender_id: 'Sender ID',
    contact: '联系人',
    contact_side: '联系人身份',
    role: '角色',
    action: '处理动作',
    issue_term: '问题词',
    risk_signal: '风险信号',
    change: '变更事件',
    media: '媒体证据',
    outcome: '处理结果',
    library: '沉淀去向',
};

const GRAPH_VIEW_CONFIG = {
    market: {
        key: 'market',
        label: '市场情报',
        description: '看国家、运营商、客户场景、需求热度与供应商/区域之间的关系。',
        focus: ['region', 'country', 'operator', 'customer', 'supplier', 'group'],
    },
    price: {
        key: 'price',
        label: '价格情报',
        description: '看报价、费率、成本讨论与区域、运营商、供应商之间的关系。',
        focus: ['supplier', 'customer', 'region', 'country', 'operator', 'group'],
    },
    effect: {
        key: 'effect',
        label: '效果反馈',
        description: '看测试、成功、失败、恢复反馈与资源、动作之间的关系。',
        focus: ['action', 'outcome', 'operator', 'device_model', 'route', 'supplier', 'customer'],
    },
    resource: {
        key: 'resource',
        label: '资源情报',
        description: '看国家、运营商、设备、线路、Sender ID 与供应商/区域之间的资源关系。',
        focus: ['region', 'supplier', 'country', 'operator', 'device_model', 'route', 'sender_id'],
    },
    risk: {
        key: 'risk',
        label: '风险情报',
        description: '看阻断、失败、超时、延迟等风险信号与对象之间的关系。',
        focus: ['risk_signal', 'issue_term', 'supplier', 'customer', 'operator', 'device_model', 'region'],
    },
    fulfillment: {
        key: 'fulfillment',
        label: '履约情报',
        description: '看承诺、ETA、处理进度、联系人和完成结果之间的关系。',
        focus: ['outcome', 'contact', 'role', 'supplier', 'customer', 'group', 'region'],
    },
    all: {
        key: 'all',
        label: '全局图谱',
        description: '保留全部上下文关系，用于排查实体和资产来源。',
        focus: [],
    },
};

const GRAPH_RELATION_LABELS = {
    region_sector: '区域覆盖板块',
    sector_group: '板块来源群',
    group_asset: '群产生资产',
    group_entity: '群内出现实体',
    asset_entity: '资产关联实体',
    region_resource: '区域资源信号',
    provider_resource: '供应商涉及资源',
    customer_need: '客户需求对象',
    country_operator: '国家关联运营商',
    provider_region: '供应商服务区域',
    provider_action: '供应商处理动作',
    provider_risk: '供应商风险信号',
    provider_commitment: '供应商履约信号',
    issue_action: '问题触发动作',
    action_outcome: '动作产生结果',
    risk_context: '风险发生对象',
    contact_role: '联系人角色',
    contact_scope: '联系人负责对象',
    contact_action: '联系人执行动作',
    asset_library: '资产沉淀去向',
};

function graphViewFor(value) {
    const raw = String(value || 'market').trim();
    const aliases = {
        issue: 'risk',
        supplier: 'resource',
        contact: 'fulfillment',
    };
    const key = aliases[raw] || raw;
    return GRAPH_VIEW_CONFIG[key] || GRAPH_VIEW_CONFIG.market;
}

function isProviderSector(sector) {
    return ['设备供应商', '直连供应商', '语音直连供应商', '语音供应商', '卡线'].includes(normalizeSector(sector));
}

function isCustomerSector(sector) {
    return normalizeSector(sector) === '客服';
}

function seenAt(asset) {
    return Number(asset?.last_seen_at || asset?.first_seen_at || 0);
}

function uniqueItems(items, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of items || []) {
        const key = keyFn(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function loadKnowledgeAssetPool(db, options = {}) {
    if (!db) return [];
    const days = Math.min(365, Math.max(1, parseInt(options.days) || 30));
    const since = Date.now() - days * 24 * 3600 * 1000;
    const scope = options.scope == null ? 'all' : normalizeIntelligenceScope(options.scope);
    const rows = [];

    if (tableExists(db, 'knowledge_asset_candidates')) {
        const candidateRows = db.prepare(`
            SELECT *
            FROM knowledge_asset_candidates
            WHERE COALESCE(last_seen_at, first_seen_at, 0) >= ?
            ORDER BY asset_value_score DESC, confidence DESC, last_seen_at DESC
            LIMIT 6000
        `).all(since).map(row => ({
            ...mapKnowledgeAsset(row),
            pool_source: 'candidate',
            pool_id: row.dedupe_key,
        }));
        rows.push(...candidateRows);
    }

    if (tableExists(db, 'knowledge_assets')) {
        const formalRows = db.prepare(`
            SELECT *
            FROM knowledge_assets
            WHERE status = 'active'
              AND COALESCE(last_seen_at, first_seen_at, 0) >= ?
            ORDER BY asset_value_score DESC, quality_score DESC, last_seen_at DESC
            LIMIT 4000
        `).all(since).map(row => ({
            ...mapFormalKnowledgeAsset(row),
            pool_source: 'formal',
            pool_id: row.asset_uid,
            review_status: 'confirmed',
        }));
        rows.push(...formalRows);
    }

    return rows.filter(asset => {
        if (!asset) return false;
        if (!scopeMatchesRegion(asset.collection_region, scope)) return false;
        if (options.region && asset.collection_region !== options.region) return false;
        if (options.sector && asset.business_sector !== options.sector) return false;
        if (options.type && asset.asset_type !== options.type) return false;
        return true;
    });
}

function assetTargetLibrary(asset) {
    const target = targetLibraryForAsset(asset);
    return target?.key || 'discovery';
}

function normalizeEntityType(type) {
    const raw = String(type || '').trim();
    if (!raw) return '';
    if (raw === 'business_sector') return 'sector';
    if (raw === 'collection_region' || raw === 'business_region') return 'region';
    if (raw === 'group_name') return 'group';
    if (raw === 'risk') return 'risk_signal';
    if (raw === 'change_event') return 'change';
    if (raw === 'media_evidence') return 'media';
    return raw;
}

function pushEntity(out, type, value, weight = 1) {
    const entityType = normalizeEntityType(type);
    const entityValue = String(value || '').trim();
    if (!entityType || !entityValue || entityValue === '-') return;
    out.push({ type: entityType, value: entityValue, weight: Math.max(1, Number(weight) || 1) });
}

function extractAssetEntities(asset) {
    const out = [];
    for (const entity of asset.related_entities || []) {
        pushEntity(out, entity.type, entity.value, entity.count || entity.weight || 1);
    }
    const m = asset.metrics || {};
    pushEntity(out, m.entity_type, m.entity_value, m.mention_count || 1);
    pushEntity(out, 'action', m.action_label, asset.frequency || 1);
    pushEntity(out, 'change', m.change_label, asset.frequency || 1);
    pushEntity(out, 'role', m.inferred_role, asset.frequency || 1);
    pushEntity(out, 'media', m.media_category, asset.frequency || 1);
    if (Array.isArray(m.signals)) {
        for (const signal of m.signals) pushEntity(out, 'risk_signal', signal, asset.frequency || 1);
    }
    if (Array.isArray(m.top_operators)) {
        for (const item of m.top_operators) pushEntity(out, 'operator', item.key || item.value, item.count || 1);
    }
    if (Array.isArray(m.top_issue_terms)) {
        for (const item of m.top_issue_terms) pushEntity(out, 'issue_term', item.key || item.value, item.count || 1);
    }
    if (Array.isArray(m.top_risk_signals)) {
        for (const item of m.top_risk_signals) pushEntity(out, 'risk_signal', item.key || item.value, item.count || 1);
    }
    return uniqueItems(out, item => `${item.type}:${item.value}`);
}

function addCounter(map, key, patch = {}) {
    if (!key) return null;
    const item = map.get(key) || { key, count: 0 };
    item.count += Number(patch.count || 1);
    for (const [k, v] of Object.entries(patch)) {
        if (k === 'count') continue;
        if (v == null || v === '') continue;
        item[k] = v;
    }
    map.set(key, item);
    return item;
}

function topCounters(map, limit = 6) {
    return Array.from(map.values())
        .sort((a, b) => (Number(b.count || 0) - Number(a.count || 0)) || String(a.key).localeCompare(String(b.key)))
        .slice(0, limit);
}

const BUSINESS_INTEL_CATEGORIES = {
    market: {
        label: '市场情报',
        short_label: '市场',
        tone: 'blue',
        empty: '暂未识别到明显需求、询价或市场热度信号。',
        patterns: [
            { label: '需求/询价', re: /(需求|询价|需要|有没有|有量|找|报价吗|need|looking for|require|demand|inquiry|quote)/i },
            { label: '客户/场景', re: /(客户|client|customer|项目|业务|campaign|otp|marketing|voice|sms)/i },
            { label: '国家/运营商热度', re: /(国家|地区|运营商|operator|country|traffic|volume|流量|量)/i },
        ],
    },
    price: {
        label: '价格情报',
        short_label: '价格',
        tone: 'amber',
        empty: '暂未识别到报价、涨跌价或成本变化信号。',
        patterns: [
            { label: '报价/价格', re: /(\$|usd|usdt|rmb|cny|价格|报价|单价|费率|多少钱|price|rate|cost|quote)/i },
            { label: '涨跌价', re: /(涨价|降价|涨了|降了|increase|decrease|expensive|cheap|便宜|贵)/i },
            { label: '成本/结算', re: /(成本|结算|扣费|余额|charge|billing|settle|payment)/i },
        ],
    },
    effect: {
        label: '效果反馈',
        short_label: '效果',
        tone: 'green',
        empty: '暂未识别到明确测试结果、恢复反馈或失败反馈。',
        patterns: [
            { label: '恢复/可用', re: /(恢复|可以了|好了|正常|可用|收到了|成功|done|fixed|working|ok now|success|delivered)/i },
            { label: '失败/不可用', re: /(失败|不行|不可用|没收到|收不到|还是不行|failed|not working|still not|timeout|blocked)/i },
            { label: '测试反馈', re: /(测试|test|try|验证|check result|result|反馈|confirm)/i },
        ],
    },
    resource: {
        label: '资源情报',
        short_label: '资源',
        tone: 'cyan',
        empty: '暂未识别到明显供应商、通道、设备或运营商资源信号。',
        patterns: [
            { label: '通道/线路', re: /(route|通道|线路|channel|供应商|supplier|资源|vendor)/i },
            { label: '运营商/SID', re: /(operator|运营商|sender|sender id|sid|vnl|mcc|mnc)/i },
            { label: '设备/SIM', re: /(sim|卡池|卡|号码|设备|device|gateway|goip|port|端口)/i },
        ],
    },
    risk: {
        label: '风险情报',
        short_label: '风险',
        tone: 'red',
        empty: '暂未识别到明显阻断、超时、延迟或反复追问信号。',
        patterns: [
            { label: '阻断/失败', re: /(blocked|reject|rejected|failed|失败|拦截|封|拒绝|error|603)/i },
            { label: '超时/掉线', re: /(timeout|down|offline|超时|掉线|离线|异常|不稳定)/i },
            { label: '延迟/沉默', re: /(delay|eta|checking|still|wait|无响应|沉默|延迟|拖|反复)/i },
        ],
    },
    fulfillment: {
        label: '履约情报',
        short_label: '履约',
        tone: 'purple',
        empty: '暂未识别到明确承诺、ETA 或兑现结果。',
        patterns: [
            { label: '承诺/ETA', re: /(eta|soon|today|tomorrow|稍后|马上|尽快|今天|明天|预计|承诺|promise)/i },
            { label: '处理中', re: /(checking|processing|处理中|排查中|等待|wait|hold on|联系运营商)/i },
            { label: '完成/兑现', re: /(done|fixed|完成|已处理|已恢复|兑现|closed|solved)/i },
        ],
    },
};

function initBusinessCategory(key) {
    const meta = BUSINESS_INTEL_CATEGORIES[key];
    return {
        key,
        label: meta.label,
        short_label: meta.short_label,
        tone: meta.tone,
        count: 0,
        terms: new Map(),
        groupCounters: new Map(),
        objectCounters: new Map(),
        sampleMessages: [],
        messageIds: new Set(),
        latest_at: 0,
    };
}

function initBusinessSignalRow(region, sector) {
    const categories = {};
    for (const key of Object.keys(BUSINESS_INTEL_CATEGORIES)) categories[key] = initBusinessCategory(key);
    return {
        key: `${region}::${sector}`,
        collection_region: region,
        business_sector: sector,
        message_count: 0,
        active_groups: new Set(),
        latest_at: 0,
        categories,
    };
}

function classifyBusinessIntelText(text) {
    const content = String(text || '').trim();
    if (content.length < 2) return [];
    const matches = [];
    for (const [key, meta] of Object.entries(BUSINESS_INTEL_CATEGORIES)) {
        for (const pattern of meta.patterns) {
            if (!pattern.re.test(content)) continue;
            matches.push({ key, label: pattern.label });
        }
    }
    return uniqueItems(matches, item => `${item.key}:${item.label}`);
}

const INTEL_COUNTRY_PATTERNS = [
    ['美国', /\b(?:usa?|united states|america)\b|美国/i],
    ['巴西', /\b(?:brazil|br)\b|巴西/i],
    ['印度', /\b(?:india|in)\b|印度/i],
    ['印尼', /\b(?:indonesia|indo)\b|印尼|印度尼西亚/i],
    ['巴基斯坦', /\b(?:pakistan|pak)\b|巴基斯坦/i],
    ['孟加拉', /\b(?:bangladesh|bd)\b|孟加拉/i],
    ['菲律宾', /\b(?:philippines|philippine|ph)\b|菲律宾/i],
    ['澳大利亚', /\b(?:australia|aus|au)\b|澳大利亚|澳洲/i],
    ['韩国', /\b(?:korea|kr)\b|韩国/i],
    ['日本', /\b(?:japan|jp)\b|日本/i],
    ['英国', /\b(?:uk|britain|england)\b|英国/i],
    ['意大利', /\b(?:italy|italia)\b|意大利/i],
    ['西班牙', /\b(?:spain|es)\b|西班牙/i],
    ['瑞典', /\b(?:sweden|se)\b|瑞典/i],
    ['沙特', /\b(?:saudi|ksa)\b|沙特/i],
    ['埃及', /\b(?:egypt|eg)\b|埃及/i],
    ['肯尼亚', /\b(?:kenya|ke)\b|肯尼亚/i],
    ['尼泊尔', /\b(?:nepal|np)\b|尼泊尔/i],
    ['喀麦隆', /\b(?:cameroon|cm)\b|喀麦隆/i],
    ['埃塞俄比亚', /\b(?:ethiopia|et)\b|埃塞俄比亚/i],
    ['黎巴嫩', /\b(?:lebanon|lb)\b|黎巴嫩/i],
];

function pushIntelObject(out, type, value, label = value) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length < 2 || clean.length > 80) return;
    out.push({ type, value: clean, label: `${label}` });
}

function compactGroupName(name) {
    return String(name || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 42);
}

function extractBusinessIntelObjects(msg, categoryKey) {
    const text = `${msg.group_name || ''}\n${msg.content || ''}`;
    const out = [];
    for (const [country, re] of INTEL_COUNTRY_PATTERNS) {
        if (re.test(text)) pushIntelObject(out, 'country', country, `国家/地区：${country}`);
    }
    const groupName = compactGroupName(msg.group_name);
    if (groupName) pushIntelObject(out, 'group', groupName, `对话群：${groupName}`);

    const operatorMatch = text.match(/(?:operator|carrier|telco|运营商)\s*[:：-]?\s*([A-Za-z0-9][A-Za-z0-9 ._&+-]{2,28})/i);
    if (operatorMatch?.[1]) pushIntelObject(out, 'operator', operatorMatch[1], `运营商：${operatorMatch[1].trim()}`);

    if (/(otp|验证码)/i.test(text)) pushIntelObject(out, 'scenario', 'OTP', '场景：OTP');
    if (/(marketing|营销|挂机短信)/i.test(text)) pushIntelObject(out, 'scenario', '营销短信', '场景：营销短信');
    if (/(voice|语音|呼叫|call)/i.test(text)) pushIntelObject(out, 'scenario', '语音', '场景：语音');
    if (/(sms|短信)/i.test(text)) pushIntelObject(out, 'scenario', '短信', '场景：短信');

    if (categoryKey === 'price') {
        const prices = text.match(/(?:\$|usd|usdt|rmb|cny|￥)?\s?\d+(?:\.\d+)?\s?(?:%|usd|usdt|rmb|cny|元|分)?/gi) || [];
        for (const item of prices.slice(0, 3)) {
            const clean = item.trim();
            if (/\d/.test(clean) && clean.length <= 16) pushIntelObject(out, 'price', clean, `价格片段：${clean}`);
        }
    }

    if (categoryKey === 'effect') {
        if (/(恢复|可以了|好了|正常|可用|收到了|成功|done|fixed|working|ok now|success|delivered)/i.test(text)) {
            pushIntelObject(out, 'outcome', '恢复/可用', '结果：恢复/可用');
        }
        if (/(失败|不行|不可用|没收到|收不到|failed|not working|timeout|blocked)/i.test(text)) {
            pushIntelObject(out, 'outcome', '失败/不可用', '结果：失败/不可用');
        }
        if (/(测试|test|try|验证|result|反馈|confirm)/i.test(text)) {
            pushIntelObject(out, 'outcome', '测试反馈', '结果：测试反馈');
        }
    }

    if (categoryKey === 'resource') {
        if (/(route|通道|线路|channel)/i.test(text)) pushIntelObject(out, 'resource', '通道/线路', '资源：通道/线路');
        if (/(sender|sender id|sid|vnl)/i.test(text)) pushIntelObject(out, 'resource', 'Sender ID/SID', '资源：Sender ID/SID');
        if (/(sim|卡池|设备|device|gateway|goip|port|端口)/i.test(text)) pushIntelObject(out, 'resource', '设备/SIM/端口', '资源：设备/SIM/端口');
    }

    if (categoryKey === 'risk') {
        if (/(blocked|reject|rejected|拦截|封|拒绝|603)/i.test(text)) pushIntelObject(out, 'risk', '阻断/拦截', '风险：阻断/拦截');
        if (/(timeout|down|offline|超时|掉线|离线|异常|不稳定)/i.test(text)) pushIntelObject(out, 'risk', '超时/掉线', '风险：超时/掉线');
        if (/(delay|checking|still|wait|无响应|延迟|反复)/i.test(text)) pushIntelObject(out, 'risk', '延迟/反复等待', '风险：延迟/反复等待');
    }

    if (categoryKey === 'fulfillment') {
        if (/(eta|soon|today|tomorrow|预计|承诺|promise)/i.test(text)) pushIntelObject(out, 'fulfillment', '承诺/ETA', '履约：承诺/ETA');
        if (/(checking|processing|处理中|排查中|等待|wait|hold on|联系运营商)/i.test(text)) pushIntelObject(out, 'fulfillment', '处理中', '履约：处理中');
        if (/(done|fixed|完成|已处理|已恢复|closed|solved)/i.test(text)) pushIntelObject(out, 'fulfillment', '完成/兑现', '履约：完成/兑现');
    }

    return uniqueItems(out, item => `${item.type}:${item.value}`).slice(0, 8);
}

function recordBusinessSignal(row, match, msg) {
    const bucket = row.categories[match.key];
    if (!bucket) return;
    bucket.count += 1;
    addCounter(bucket.terms, match.label);
    addCounter(bucket.groupCounters, msg.group_name || '未知群');
    const objects = extractBusinessIntelObjects(msg, match.key);
    for (const object of objects) {
        addCounter(bucket.objectCounters, `${object.type}:${object.value}`, {
            type: object.type,
            value: object.value,
            label: object.label,
        });
    }
    if (!bucket.messageIds.has(msg.id) && bucket.sampleMessages.length < 10) {
        bucket.messageIds.add(msg.id);
        bucket.sampleMessages.push({
            id: msg.id,
            group_name: msg.group_name || '未知群',
            signal: match.label,
            objects: objects.slice(0, 4).map(item => item.label),
            summary: redactMessageText(msg.content, 90),
            timestamp: msg.timestamp,
        });
    }
    bucket.latest_at = Math.max(bucket.latest_at || 0, Number(msg.timestamp || 0));
}

function loadRegionalBusinessSignals(options = {}) {
    const sdb = getSourceDb();
    if (!sdb || !tableExists(sdb, 'messages')) {
        return { byKey: new Map(), total_messages: 0, category_totals: {}, top_samples: [] };
    }

    const dayNum = Math.min(365, Math.max(1, parseInt(options.days) || 30));
    const since = Date.now() - dayNum * 24 * 3600 * 1000;
    const scope = normalizeIntelligenceScope(options.scope);
    const accountMap = getAccountRegionMap();
    const rows = sdb.prepare(`
        SELECT id, receiver_account, business_sector, group_name, sender_name, content, has_media, timestamp
        FROM messages
        WHERE timestamp >= ?
          AND content IS NOT NULL
          AND TRIM(content) != ''
        ORDER BY timestamp DESC
        LIMIT 22000
    `).all(since);

    const byKey = new Map();
    const categoryTotals = {};
    let messageTotal = 0;

    for (const msg of rows) {
        const info = accountMap.get(msg.receiver_account) || {};
        if (info.value_label === 'L3') continue;
        const region = info.region || '未知区';
        const sector = normalizeSector(msg.business_sector || info.business_sector);
        if (!scopeMatchesRegion(region, scope)) continue;
        if (options.region && region !== options.region) continue;
        if (options.sector && sector !== options.sector) continue;

        const key = `${region}::${sector}`;
        const row = byKey.get(key) || initBusinessSignalRow(region, sector);
        row.message_count += 1;
        messageTotal += 1;
        row.active_groups.add(msg.group_name || '未知群');
        row.latest_at = Math.max(row.latest_at || 0, Number(msg.timestamp || 0));

        const matches = classifyBusinessIntelText(msg.content);
        for (const match of matches) {
            recordBusinessSignal(row, match, msg);
            categoryTotals[match.key] = (categoryTotals[match.key] || 0) + 1;
        }
        byKey.set(key, row);
    }

    return {
        byKey,
        total_messages: messageTotal,
        category_totals: categoryTotals,
        top_samples: [],
    };
}

function serializeBusinessCategory(bucket) {
    return {
        key: bucket.key,
        label: bucket.label,
        short_label: bucket.short_label,
        tone: bucket.tone,
        count: bucket.count,
        terms: topCounters(bucket.terms, 4),
        objects: topCounters(bucket.objectCounters, 6),
        sample_messages: bucket.sampleMessages.slice(0, 5),
        active_group_count: bucket.groupCounters.size,
        top_groups: topCounters(bucket.groupCounters, 3),
        latest_at: bucket.latest_at,
    };
}

function serializeBusinessSignalRow(row) {
    if (!row) return null;
    const categories = Object.values(row.categories).map(serializeBusinessCategory);
    const topCategory = categories.slice().sort((a, b) => b.count - a.count)[0] || null;
    return {
        message_count: row.message_count,
        active_group_count: row.active_groups.size,
        latest_at: row.latest_at,
        categories,
        top_category: topCategory,
    };
}

function buildCategoryInsight(category, row) {
    const count = Number(category.count || 0);
    const name = category.short_label || category.label;
    if (!count) return BUSINESS_INTEL_CATEGORIES[category.key]?.empty || '暂无明显信号。';
    const topTerms = (category.terms || []).slice(0, 2).map(item => item.key).join('、');
    const region = row.collection_region || '该区域';
    const sector = row.business_sector || '该板块';
    if (category.key === 'market') return `${region}/${sector} 出现 ${count} 条需求、询价或量级信号，重点看 ${topTerms || '需求来源'}。`;
    if (category.key === 'price') return `${region}/${sector} 出现 ${count} 条报价、价格或成本信号，可用于判断资源成本变化。`;
    if (category.key === 'effect') return `${region}/${sector} 出现 ${count} 条测试、恢复或失败反馈，适合回看资源和动作效果。`;
    if (category.key === 'resource') return `${region}/${sector} 出现 ${count} 条通道、设备、运营商或供应商资源信号。`;
    if (category.key === 'risk') return `${region}/${sector} 出现 ${count} 条阻断、超时、延迟或不稳定信号，需要关注风险外溢。`;
    if (category.key === 'fulfillment') return `${region}/${sector} 出现 ${count} 条承诺、ETA 或处理进度信号，可联动履约复盘。`;
    return `${name} 出现 ${count} 条信号。`;
}

function categoryStrength(category, row) {
    const count = Number(category.count || 0);
    if (!count) return '待观察';
    const messageCount = Math.max(1, Number(row.business_intel?.message_count || row.message_count || 1));
    const ratio = count / messageCount;
    if (count >= 80 || ratio >= 0.08) return '强信号';
    if (count >= 20 || ratio >= 0.03) return '中信号';
    return '弱信号';
}

function categoryTermText(category) {
    const terms = (category.terms || []).slice(0, 3).map(item => item.key);
    return terms.length ? terms.join('、') : '零散表达';
}

function categoryObjectLabels(category, limit = 5, options = {}) {
    const excludeGroups = options.excludeGroups !== false;
    return (category.objects || [])
        .filter(item => !excludeGroups || item.type !== 'group')
        .map(item => item.label || item.value || item.key)
        .filter(Boolean)
        .slice(0, limit);
}

function categoryGroupLabels(category, limit = 3) {
    const fromGroups = (category.top_groups || []).map(item => item.key || item.label).filter(Boolean);
    if (fromGroups.length) return fromGroups.slice(0, limit);
    return (category.objects || [])
        .filter(item => item.type === 'group')
        .map(item => item.value || item.label)
        .filter(Boolean)
        .slice(0, limit);
}

function formatIntelList(items, fallback) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return fallback;
    if (list.length === 1) return list[0];
    return list.slice(0, 4).join('、');
}

function categoryConcreteFocus(category) {
    const objects = categoryObjectLabels(category, 4);
    if (objects.length) return formatIntelList(objects, '具体对象暂不稳定');
    const terms = (category.terms || []).slice(0, 3).map(item => item.key);
    return formatIntelList(terms, '具体对象暂不稳定');
}

function buildConversationSummary(category, row) {
    const count = Number(category.count || 0);
    const region = row.collection_region || '该区域';
    const sector = row.business_sector || '该板块';
    if (!count) return BUSINESS_INTEL_CATEGORIES[category.key]?.empty || '暂无明显信号。';
    const groups = formatIntelList(categoryGroupLabels(category, 3), '多个对话群');
    const focus = categoryConcreteFocus(category);
    const strength = categoryStrength(category, row);

    if (category.key === 'market') {
        return `近期${region}/${sector}的对话主要围绕 ${focus} 展开，集中出现在 ${groups}。从这些消息看，区域内有需求确认、资源匹配或客户场景询问，属于${strength}市场线索；但是否能转成机会，还要继续补齐目标价格、需求量级和可用供应商。`;
    }
    if (category.key === 'price') {
        return `近期${region}/${sector}的价格相关对话集中在 ${focus}，主要出现在 ${groups}。这些消息说明报价、费率或成本变化已经进入业务讨论，可作为价格基线素材；但还需要绑定国家/运营商、供应商和质量反馈，避免只按单条报价做判断。`;
    }
    if (category.key === 'effect') {
        return `近期${region}/${sector}的效果反馈集中在 ${focus}，主要来自 ${groups}。这些对话已经能反映部分资源或处理动作是否有效，适合沉淀成功、失败、恢复和不可用的结果；当前还需要把反馈绑定到具体资源对象和恢复后稳定性。`;
    }
    if (category.key === 'resource') {
        return `近期${region}/${sector}的资源讨论集中在 ${focus}，主要来自 ${groups}。这些消息可用于整理通道、设备、SIM、运营商或供应商的可用范围，并判断是否存在替代资源；当前缺口是资源质量分层和替代关系还不够清楚。`;
    }
    if (category.key === 'risk') {
        return `近期${region}/${sector}的风险对话集中在 ${focus}，主要来自 ${groups}。这些消息说明阻断、失败、超时、掉线或反复等待不只是单点现象，需要按区域问题看影响范围、责任方和恢复时间。`;
    }
    if (category.key === 'fulfillment') {
        return `近期${region}/${sector}的履约对话集中在 ${focus}，主要来自 ${groups}。这些消息可用于复盘承诺、ETA、处理中和完成反馈是否一致；当前需要继续补齐承诺方、实际完成时间和未兑现原因。`;
    }
    return `近期${region}/${sector}的相关对话集中在 ${focus}，主要来自 ${groups}，可作为后续运营观察线索。`;
}

function categoryScopeText(category) {
    const groups = Number(category.active_group_count || 0);
    if (groups >= 8) return `覆盖 ${groups} 个群，说明不是单点消息，需要按区域共性处理。`;
    if (groups >= 2) return `覆盖 ${groups} 个群，具备横向对比价值。`;
    if (groups === 1) return '主要集中在单个群，适合作为局部线索继续观察。';
    return '暂未形成稳定覆盖面。';
}

function buildCategoryBasis(category, row) {
    const count = Number(category.count || 0);
    const messageCount = Math.max(0, Number(row.business_intel?.message_count || row.message_count || 0));
    const groups = Number(category.active_group_count || 0);
    const terms = (category.terms || []).slice(0, 3).map(item => item.key).filter(Boolean);
    const objectLabels = categoryObjectLabels(category, 4);
    const groupLabels = categoryGroupLabels(category, 3);
    const sampleSignals = uniqueItems((category.sample_messages || []).map(item => item.signal).filter(Boolean), item => item).slice(0, 3);
    const basis = [];
    if (objectLabels.length) basis.push(`对话对象：${objectLabels.join('、')}`);
    if (groupLabels.length) basis.push(`集中群：${groupLabels.join('、')}`);
    if (sampleSignals.length) basis.push(`代表信号：${sampleSignals.join('、')}`);
    if (count) basis.push(`${count} 条${category.label || '情报'}信号`);
    if (groups) basis.push(`覆盖 ${groups} 个群`);
    if (messageCount && count) {
        basis.push(`约占该区域/板块近期消息 ${Math.min(100, Math.round((count / Math.max(1, messageCount)) * 100))}%`);
    }
    if (terms.length) basis.push(`信号类型：${terms.join('、')}`);
    if (row.high_value) basis.push(`关联高价值候选 ${row.high_value} 条`);
    if (row.cross_region_count) basis.push(`跨区线索 ${row.cross_region_count} 条`);
    return basis.length ? basis : ['缺少稳定样本', '缺少可验证闭环'];
}

function buildCategoryJudgment(category, row) {
    const count = Number(category.count || 0);
    const region = row.collection_region || '该区域';
    const sector = row.business_sector || '该板块';
    if (!count) return BUSINESS_INTEL_CATEGORIES[category.key]?.empty || '暂无明显信号。';
    const strength = categoryStrength(category, row);
    const termText = categoryTermText(category);
    const scope = categoryScopeText(category);
    if (category.key === 'market') {
        return `${strength}。${region}/${sector} 的需求、询价或客户场景讨论正在集中，关键词集中在 ${termText}。${scope}`;
    }
    if (category.key === 'price') {
        return `${strength}。报价、费率或成本变化已经进入对话上下文，关键词集中在 ${termText}，适合和效果反馈一起判断资源性价比。${scope}`;
    }
    if (category.key === 'effect') {
        return `${strength}。测试结果、恢复确认和失败反馈较多，说明该区域已经有可沉淀的“资源是否有效、动作是否有效”结论。${scope}`;
    }
    if (category.key === 'resource') {
        return `${strength}。通道、设备、SIM、运营商或供应商资源被频繁提及，适合沉淀区域资源地图和可替代资源池。${scope}`;
    }
    if (category.key === 'risk') {
        return `${strength}。阻断、失败、超时、掉线或反复等待信号较明显，需要把问题从单次处理升级为区域风险观察。${scope}`;
    }
    if (category.key === 'fulfillment') {
        return `${strength}。ETA、处理中、完成或兑现类表达较多，说明该区域适合做承诺履约复盘和响应节奏评估。${scope}`;
    }
    return `${strength}。${region}/${sector} 出现稳定信号，关键词集中在 ${termText}。${scope}`;
}

function buildCategoryNextStep(category) {
    const count = Number(category.count || 0);
    if (!count) return '继续积累消息，暂不进入正式沉淀。';
    if (category.key === 'market') return '整理国家/运营商/客户场景/需求量级，和当前可供资源做匹配。';
    if (category.key === 'price') return '沉淀报价、涨跌价原因、质量反馈和可替代供应商，形成区域价格基线。';
    if (category.key === 'effect') return '把成功、失败、恢复、不可用反馈绑定到资源和处理动作，形成效果台账。';
    if (category.key === 'resource') return '建立区域资源清单，标记通道、设备、SIM、运营商和供应商的可用范围。';
    if (category.key === 'risk') return '把高频风险归类为阻断、超时、掉线、延迟或沉默，并配置预警规则。';
    if (category.key === 'fulfillment') return '把承诺时间、处理方、实际恢复和未兑现对象纳入 SLA 复盘。';
    return '保留为区域经营线索，等待更多上下文确认。';
}

function buildCategoryNextSteps(category) {
    const count = Number(category.count || 0);
    if (!count) return ['继续积累消息上下文', '等待出现明确对象、结果或闭环后再沉淀'];
    if (category.key === 'market') {
        return ['提取高频国家/运营商/客户场景', '补齐目标价格和需求量级', '匹配当前可用供应商或线路', '有测试反馈后沉淀为区域市场机会'];
    }
    if (category.key === 'price') {
        return ['记录报价区间和币种', '标记涨跌价方向和原因', '绑定供应商、国家和质量反馈', '形成区域价格基线'];
    }
    if (category.key === 'effect') {
        return ['把成功、失败、恢复、不可用反馈绑定到资源对象', '补齐恢复后稳定性', '沉淀有效资源和无效资源清单'];
    }
    if (category.key === 'resource') {
        return ['按国家/运营商/设备/SIM/通道拆资源', '标记可用范围和替代关系', '同步到资源台账或供应商画像'];
    }
    if (category.key === 'risk') {
        return ['拆分阻断、失败、超时、延迟和沉默主因', '标记影响区域、客户和供应商', '配置预警规则并建立复盘条目'];
    }
    if (category.key === 'fulfillment') {
        return ['抽取承诺方、ETA 和处理方', '核对实际完成时间和是否兑现', '将未兑现对象联动到供应商画像'];
    }
    return [buildCategoryNextStep(category)];
}

function categoryDestinationPlan(category) {
    const regional = LIBRARY_LABELS.region_intelligence;
    if (category.key === 'market') {
        return { available: [regional], planned: ['市场机会台账', '资源匹配台账'] };
    }
    if (category.key === 'price') {
        return { available: [regional, LIBRARY_LABELS.supplier], planned: ['价格基线库'] };
    }
    if (category.key === 'effect') {
        return { available: [regional, LIBRARY_LABELS.qa, LIBRARY_LABELS.device], planned: ['资源效果台账'] };
    }
    if (category.key === 'resource') {
        return { available: [regional, LIBRARY_LABELS.supplier, LIBRARY_LABELS.device], planned: ['资源台账'] };
    }
    if (category.key === 'risk') {
        return { available: [regional], planned: ['风险模式库', '预警规则'] };
    }
    if (category.key === 'fulfillment') {
        return { available: [regional, LIBRARY_LABELS.supplier], planned: ['SLA 履约资产'] };
    }
    return { available: [regional], planned: [] };
}

function categoryActionStatus(category, row, decision) {
    const count = Number(category.count || 0);
    const strength = categoryStrength(category, row);
    const missingCount = (decision?.missing_info || []).length;
    if (!count) return { label: '仅观察', tone: 'muted' };
    if (['market', 'price'].includes(category.key) && missingCount >= 2) return { label: '需要补信息', tone: 'amber' };
    if (category.key === 'risk' && ['强信号', '中信号'].includes(strength)) return { label: '可直接行动', tone: 'red' };
    if (category.key === 'effect' && ['强信号', '中信号'].includes(strength)) return { label: '建议沉淀', tone: 'green' };
    if (category.key === 'resource' && ['强信号', '中信号'].includes(strength)) return { label: '建议沉淀', tone: 'cyan' };
    if (category.key === 'fulfillment' && ['强信号', '中信号'].includes(strength)) return { label: '建议复盘', tone: 'purple' };
    if (strength === '强信号') return { label: '建议沉淀', tone: 'blue' };
    if (strength === '中信号') return { label: '需要补信息', tone: 'amber' };
    return { label: '仅观察', tone: 'muted' };
}

function categoryCardTitle(category, row, decision) {
    const count = Number(category.count || 0);
    if (!count) return `${category.label}：继续观察`;
    if (category.key === 'market') {
        return (decision?.missing_info || []).length >= 2 ? '市场情报：需要补齐可供资源匹配' : '市场情报：可跟进需求机会';
    }
    if (category.key === 'price') return '价格情报：需要补齐价格基线';
    if (category.key === 'effect') return '效果反馈：可形成资源效果台账';
    if (category.key === 'resource') return '资源情报：可建立区域资源地图';
    if (category.key === 'risk') return '风险情报：需要优先复盘主因';
    if (category.key === 'fulfillment') return '履约情报：可联动 SLA 复盘';
    return `${category.label}：建议沉淀`;
}

function categoryByKey(categories, key) {
    return (categories || []).find(item => item.key === key) || { key, count: 0, terms: [], active_group_count: 0 };
}

function categoryHasTerm(category, text) {
    return (category.terms || []).some(item => String(item.key || '').includes(text));
}

function levelFromCategory(category, row) {
    const strength = categoryStrength(category, row);
    if (strength === '强信号') return { value: '高', tone: 'strong' };
    if (strength === '中信号') return { value: '中', tone: 'medium' };
    if (strength === '弱信号') return { value: '低', tone: 'low' };
    return { value: '待观察', tone: 'muted' };
}

function buildCategoryDecision(category, row) {
    const count = Number(category.count || 0);
    const region = row.collection_region || '该区域';
    const sector = row.business_sector || '该板块';
    const strength = categoryStrength(category, row);
    const basis = buildCategoryBasis(category, row);
    const terms = (category.terms || []).slice(0, 4).map(item => item.key);
    const objectLabels = categoryObjectLabels(category, 4);
    const keyObjects = objectLabels.length ? objectLabels : (terms.length ? terms : ['暂未形成稳定对象']);
    if (category.active_group_count) keyObjects.push(`覆盖 ${category.active_group_count} 个群`);
    const conversationSummary = buildConversationSummary(category, row);
    if (!count) {
        return {
            conclusion: BUSINESS_INTEL_CATEGORIES[category.key]?.empty || '暂无明显信号。',
            key_objects: keyObjects,
            basis,
            impact: '当前不足以支撑运营动作，建议继续观察。',
            missing_info: ['缺少稳定样本', '缺少可验证闭环'],
        };
    }

    if (category.key === 'market') {
        const missing = [];
        if (!categoryHasTerm(category, '国家')) missing.push('缺少明确国家/运营商');
        if (!categoryHasTerm(category, '需求')) missing.push('缺少需求量级');
        if (!categoryHasTerm(category, '客户')) missing.push('缺少客户场景优先级');
        return {
            conclusion: conversationSummary,
            key_objects: keyObjects,
            basis,
            impact: '可用于判断需求热度，但还需要和资源供给、报价、测试结果一起看，才能形成投放或采购判断。',
            missing_info: missing.length ? missing : ['缺少目标价格', '缺少可供资源匹配结果'],
        };
    }
    if (category.key === 'price') {
        const missing = [];
        if (!categoryHasTerm(category, '报价')) missing.push('缺少具体报价区间');
        if (!categoryHasTerm(category, '涨跌价')) missing.push('缺少涨跌方向');
        if (!categoryHasTerm(category, '成本')) missing.push('缺少成本/结算背景');
        return {
            conclusion: conversationSummary,
            key_objects: keyObjects,
            basis,
            impact: '可提示资源成本变化，但未绑定国家、供应商和质量反馈前，不宜直接用于采购或调价。',
            missing_info: missing.length ? missing : ['缺少历史价格对比', '缺少质量匹配结论'],
        };
    }
    if (category.key === 'effect') {
        return {
            conclusion: conversationSummary,
            key_objects: keyObjects,
            basis,
            impact: '这类信息能直接回答资源是否有效、动作是否有效，优先级高于单纯聊天热度。',
            missing_info: ['缺少资源对象绑定', '缺少恢复后稳定性', '缺少成功率/失败率口径'],
        };
    }
    if (category.key === 'resource') {
        return {
            conclusion: conversationSummary,
            key_objects: keyObjects,
            basis,
            impact: '适合形成区域资源地图，用于判断哪些资源可用、哪些资源可替代、哪些供应商值得优先跟进。',
            missing_info: ['缺少资源可用范围', '缺少替代资源关系', '缺少资源质量分层'],
        };
    }
    if (category.key === 'risk') {
        return {
            conclusion: conversationSummary,
            key_objects: keyObjects,
            basis,
            impact: '如果风险与资源/效果反馈同时偏高，说明不是简单热度问题，而是可用性或履约稳定性问题。',
            missing_info: ['缺少风险主因', '缺少影响国家/运营商', '缺少责任方和恢复时间'],
        };
    }
    if (category.key === 'fulfillment') {
        return {
            conclusion: conversationSummary,
            key_objects: keyObjects,
            basis,
            impact: '可用于判断供应商或处理方是否按承诺推进，适合和风险信号一起做 SLA 复盘。',
            missing_info: ['缺少承诺方', '缺少实际完成时间', '缺少未兑现原因'],
        };
    }
    return {
        conclusion: conversationSummary,
        key_objects: keyObjects,
        basis,
        impact: '可作为运营观察线索。',
        missing_info: ['缺少进一步分类'],
    };
}

function buildBattleReport(categories, row) {
    const active = (categories || []).filter(item => item.count > 0).sort((a, b) => b.count - a.count);
    const top = active[0];
    const second = active[1];
    if (!top) return `${row.collection_region}/${row.business_sector} 暂未形成稳定运营情报，建议继续积累消息上下文。`;
    const risk = categoryByKey(categories, 'risk');
    const price = categoryByKey(categories, 'price');
    const effect = categoryByKey(categories, 'effect');
    const riskNote = risk.count >= 80 ? '风险暴露较明显，需要同步复盘失败、延迟和响应稳定性' : '风险暂未成为主导信号';
    const priceNote = price.count >= 20 ? '价格信息已有一定密度，可补充报价区间和涨跌方向' : '价格信息仍偏少，暂不宜直接用于采购判断';
    const effectNote = effect.count >= 80 ? '效果反馈较多，适合沉淀资源有效性台账' : '效果闭环还需要继续补齐';
    return `${row.collection_region}/${row.business_sector} 近期以${top.label}为主${second ? `，${second.label}次之` : ''}；${riskNote}；${priceNote}；${effectNote}。`;
}

function buildOperationalProfile(categories, row) {
    const market = levelFromCategory(categoryByKey(categories, 'market'), row);
    const price = levelFromCategory(categoryByKey(categories, 'price'), row);
    const effect = levelFromCategory(categoryByKey(categories, 'effect'), row);
    const resource = levelFromCategory(categoryByKey(categories, 'resource'), row);
    const risk = levelFromCategory(categoryByKey(categories, 'risk'), row);
    const fulfillment = levelFromCategory(categoryByKey(categories, 'fulfillment'), row);
    return [
        { label: '市场热度', value: market.value, tone: market.tone, detail: '需求、询价、客户场景和国家/运营商讨论密度。' },
        { label: '资源供给', value: resource.value, tone: resource.tone, detail: '通道、线路、SIM、设备和供应商资源讨论密度。' },
        { label: '价格透明度', value: price.value, tone: price.tone, detail: '报价、涨跌价、成本和结算信息是否充分。' },
        { label: '效果可验证性', value: effect.value, tone: effect.tone, detail: '测试、恢复、失败和可用性反馈是否能形成闭环。' },
        { label: '风险状态', value: risk.value === '高' ? '预警' : risk.value === '中' ? '关注' : risk.value === '低' ? '正常' : '待观察', tone: risk.tone, detail: '阻断、失败、超时、延迟和沉默风险。' },
        { label: '履约可信度', value: fulfillment.value, tone: fulfillment.tone, detail: '承诺、ETA、处理中和完成反馈是否可复盘。' },
    ];
}

function buildPriorityActions(categories, row) {
    const market = categoryByKey(categories, 'market');
    const price = categoryByKey(categories, 'price');
    const effect = categoryByKey(categories, 'effect');
    const resource = categoryByKey(categories, 'resource');
    const risk = categoryByKey(categories, 'risk');
    const fulfillment = categoryByKey(categories, 'fulfillment');
    const actions = [];

    if (risk.count >= 80 || (risk.count >= 20 && effect.count >= 20)) {
        actions.push({
            title: '优先复盘风险主因',
            text: '风险与效果反馈同时活跃，建议先拆分阻断、失败、超时、延迟和沉默，明确影响范围和责任方。',
            tone: 'red',
        });
    }
    if (market.count >= 80 && resource.count < 20) {
        actions.push({
            title: '补齐可供资源',
            text: '市场需求明显高于资源供给信号，建议核对国家/运营商需求和当前可用线路。',
            tone: 'blue',
        });
    }
    if (resource.count >= 80 && effect.count >= 80) {
        actions.push({
            title: '沉淀资源效果台账',
            text: '资源和效果反馈都较多，建议把可用资源、失败资源、恢复后稳定性沉淀到同一张台账。',
            tone: 'green',
        });
    }
    if (price.count < 20 && market.count >= 20) {
        actions.push({
            title: '补充价格基线',
            text: '有需求但价格信号不足，建议补充报价区间、涨跌方向、供应商和质量匹配情况。',
            tone: 'amber',
        });
    }
    if (fulfillment.count >= 20 && risk.count >= 20) {
        actions.push({
            title: '核验承诺兑现',
            text: '履约和风险信号同时存在，建议核对 ETA、承诺方、实际完成时间和未兑现原因。',
            tone: 'purple',
        });
    }
    if ((row.high_value || 0) >= 20) {
        actions.push({
            title: '优先确认高价值资产',
            text: `已有 ${row.high_value} 个高价值资产候选，建议优先确认能进入知识库、供应商画像或区域复盘的条目。`,
            tone: 'cyan',
        });
    }
    if (!actions.length) {
        actions.push({
            title: '继续观察并补上下文',
            text: '当前信号还不足以形成明确动作，建议继续积累国家、运营商、供应商、报价和测试结果上下文。',
            tone: 'slate',
        });
    }
    return actions.slice(0, 4);
}

function buildBriefKeyPoints(categories, row) {
    const byKey = new Map(categories.map(item => [item.key, item]));
    const get = key => byKey.get(key)?.count || 0;
    const points = [];
    const region = row.collection_region || '该区域';
    const sector = row.business_sector || '该板块';
    const market = get('market');
    const price = get('price');
    const effect = get('effect');
    const resource = get('resource');
    const risk = get('risk');
    const fulfillment = get('fulfillment');

    if (market || price) {
        const focus = market >= price ? '需求和询价更活跃' : '价格和成本变化更突出';
        points.push({
            title: '市场与价格',
            text: `${region}/${sector} 里${focus}，可用于判断客户需求、采购成本和资源报价是否进入变化期。`,
        });
    }
    if (resource || effect) {
        const focus = resource >= effect ? '资源供给信号更密集' : '效果反馈更密集';
        points.push({
            title: '资源与效果',
            text: `${focus}。建议把资源、运营商、设备/SIM 和测试结果放在同一张台账里看，避免只看到单条问题。`,
        });
    }
    if (risk || fulfillment) {
        const focus = risk >= fulfillment ? '风险暴露高于履约反馈' : '履约进度信息较多';
        points.push({
            title: '风险与履约',
            text: `${focus}。后续应关注阻断、超时、沉默、ETA 和实际恢复之间是否一致。`,
        });
    }
    if ((row.high_value || 0) || (row.cross_region_count || 0)) {
        points.push({
            title: '沉淀优先级',
            text: `已有 ${row.high_value || 0} 个高价值资产、${row.cross_region_count || 0} 个跨区线索，适合优先转入知识库、供应商画像或专项复盘。`,
        });
    }
    if (!points.length) {
        points.push({
            title: '观察结论',
            text: '当前消息量还不足以形成明确经营判断，建议继续积累上下文后再做正式沉淀。',
        });
    }
    return points.slice(0, 4);
}

function buildBusinessBrief(row) {
    const intel = row.business_intel || {};
    const categories = (intel.categories || []).map(category => {
        const decision = buildCategoryDecision(category, row);
        const destinationPlan = categoryDestinationPlan(category);
        return {
            ...category,
            insight: buildCategoryInsight(category, row),
            judgment: buildCategoryJudgment(category, row),
            next_step: buildCategoryNextStep(category),
            score_label: categoryStrength(category, row),
            signal_scope: categoryScopeText(category),
            conclusion: decision.conclusion,
            key_objects: decision.key_objects,
            basis: decision.basis,
            impact: decision.impact,
            missing_info: decision.missing_info,
            card_title: categoryCardTitle(category, row, decision),
            action_status: categoryActionStatus(category, row, decision),
            target_libraries: destinationPlan.available,
            available_destinations: destinationPlan.available,
            planned_capabilities: destinationPlan.planned,
            next_steps: buildCategoryNextSteps(category),
        };
    });
    const activeCategories = categories.filter(item => item.count > 0).sort((a, b) => b.count - a.count);
    const top = activeCategories[0];
    const second = activeCategories[1];
    const title = top
        ? `${row.collection_region} / ${row.business_sector}：${top.short_label}信号最活跃`
        : `${row.collection_region} / ${row.business_sector}：暂无明显经营情报信号`;
    const parts = [];
    if (top) parts.push(`${top.label} ${top.count} 条`);
    if (second) parts.push(`${second.label} ${second.count} 条`);
    if (row.high_value) parts.push(`高价值资产 ${row.high_value} 条`);
    if (row.cross_region_count) parts.push(`跨区线索 ${row.cross_region_count} 条`);
    const context = intel.message_count ? `基于 ${intel.message_count} 条近期消息、${intel.active_group_count || 0} 个活跃群的长上下文聚合。` : '';
    const summary = parts.length
        ? `${parts.join('，')}。${context}建议按市场、价格、效果、资源、风险和履约六类沉淀，不再只按单条问题处理。`
        : '该区域近期消息有沉淀价值，但市场、价格、效果反馈等经营信号还不集中。';
    return {
        title,
        summary,
        battle_report: buildBattleReport(categories, row),
        primary_category: top?.key || '',
        operational_profile: buildOperationalProfile(categories, row),
        priority_actions: buildPriorityActions(categories, row),
        key_points: buildBriefKeyPoints(categories, row),
        categories,
    };
}

function regionRecommendation(row) {
    const tips = [];
    const categories = row.business_intel?.categories || [];
    const market = categories.find(item => item.key === 'market')?.count || 0;
    const price = categories.find(item => item.key === 'price')?.count || 0;
    const effect = categories.find(item => item.key === 'effect')?.count || 0;
    if (market >= 5) tips.push('市场/需求信号集中，建议沉淀国家、运营商、客户需求和可供资源。');
    if (price >= 2) tips.push('价格/成本信号出现，建议归档报价、涨跌价原因和质量匹配情况。');
    if (effect >= 5) tips.push('效果反馈较多，建议沉淀有效资源、无效资源和处理动作结果。');
    if ((row.risk_count || 0) >= 5) tips.push('风险信号密度高，优先下钻风险模式和重复追问。');
    if ((row.action_count || 0) >= 5) tips.push('处理动作样本较多，适合沉淀区域标准排障动作。');
    if ((row.commitment_count || 0) > 0) tips.push('存在承诺履约记录，建议联动供应商画像做 SLA 复盘。');
    if ((row.cross_region_count || 0) > 0) tips.push('出现跨区域指向，建议确认是否存在跨区资源复用或问题外溢。');
    if (!tips.length) tips.push('当前资产密度较低，建议先看高价值样本再决定是否专项沉淀。');
    return tips.slice(0, 3);
}

function summarizeRegionDashboard(assets, messageIntel = null, options = {}) {
    const matrix = new Map();
    const regions = new Map();
    const sectors = new Map();
    const entityMap = new Map();
    const actionMap = new Map();
    const riskMap = new Map();
    const viewScope = intelligenceScopeMeta(options.scope);

    const ensureRow = (region, sector) => {
        const normalizedRegion = region || '未知区';
        const normalizedSector = normalizeSector(sector);
        const scopeInfo = intelligenceScopeForRegion(normalizedRegion);
        const key = `${normalizedRegion}::${normalizedSector}`;
        const row = matrix.get(key) || {
            key,
            collection_region: normalizedRegion,
            business_sector: normalizedSector,
            intelligence_scope: scopeInfo.key,
            intelligence_scope_label: scopeInfo.label,
            region_axis_label: scopeInfo.region_label,
            total: 0,
            formal_count: 0,
            candidate_count: 0,
            high_value: 0,
            risk_count: 0,
            action_count: 0,
            commitment_count: 0,
            media_count: 0,
            entity_count: 0,
            cross_region_count: 0,
            provider_count: 0,
            user_count: 0,
            value_sum: 0,
            confidence_sum: 0,
            last_seen_at: 0,
            typeCounters: new Map(),
            groupCounters: new Map(),
            entityCounters: new Map(),
            libraryCounters: new Map(),
            business_intel: null,
        };
        matrix.set(key, row);
        addCounter(regions, normalizedRegion);
        addCounter(sectors, normalizedSector);
        return row;
    };

    for (const asset of assets) {
        const region = asset.collection_region || '未知区';
        const sector = normalizeSector(asset.business_sector);
        const row = ensureRow(region, sector);

        row.total += 1;
        row.formal_count += asset.pool_source === 'formal' ? 1 : 0;
        row.candidate_count += asset.pool_source === 'candidate' ? 1 : 0;
        row.high_value += (asset.value_level === 'high' || Number(asset.asset_value_score || 0) >= 75) ? 1 : 0;
        row.risk_count += asset.asset_type === 'risk_pattern' ? 1 : 0;
        row.action_count += asset.asset_type === 'operation_action' ? 1 : 0;
        row.commitment_count += asset.asset_type === 'sla_commitment' ? 1 : 0;
        row.media_count += asset.asset_type === 'media_evidence' ? 1 : 0;
        row.entity_count += asset.asset_type === 'entity_relationship' ? 1 : 0;
        row.cross_region_count += asset.business_region && asset.collection_region && asset.business_region !== asset.collection_region ? 1 : 0;
        row.value_sum += Number(asset.asset_value_score || 0);
        row.confidence_sum += Number(asset.confidence || 0);
        row.last_seen_at = Math.max(row.last_seen_at || 0, seenAt(asset));

        const side = asset.metrics?.machine_assessment?.interaction_side || asset.metrics?.interaction_side || '';
        if (side === 'resource_provider') row.provider_count += 1;
        if (side === 'resource_user') row.user_count += 1;

        addCounter(row.typeCounters, asset.asset_type, { label: TYPE_LABELS[asset.asset_type] || asset.asset_type });
        addCounter(row.groupCounters, asset.group_name || '跨群汇总');
        addCounter(row.libraryCounters, assetTargetLibrary(asset), { label: LIBRARY_LABELS[assetTargetLibrary(asset)] || assetTargetLibrary(asset) });

        for (const entity of extractAssetEntities(asset)) {
            addCounter(row.entityCounters, `${entity.type}:${entity.value}`, {
                count: entity.weight,
                type: entity.type,
                label: GRAPH_ENTITY_LABELS[entity.type] || entity.type,
                value: entity.value,
            });
            addCounter(entityMap, `${entity.type}:${entity.value}`, {
                count: entity.weight,
                type: entity.type,
                label: GRAPH_ENTITY_LABELS[entity.type] || entity.type,
                value: entity.value,
            });
            if (entity.type === 'action') addCounter(actionMap, entity.value, { label: entity.value, count: entity.weight });
            if (entity.type === 'risk_signal' || entity.type === 'issue_term') addCounter(riskMap, entity.value, { label: entity.value, count: entity.weight });
        }
    }

    if (messageIntel?.byKey) {
        for (const signalRow of messageIntel.byKey.values()) {
            const row = ensureRow(signalRow.collection_region, signalRow.business_sector);
            row.business_intel = serializeBusinessSignalRow(signalRow);
            row.last_seen_at = Math.max(row.last_seen_at || 0, signalRow.latest_at || 0);
        }
    }

    const rows = Array.from(matrix.values()).map(row => {
        const avg_value = row.total ? Math.round((row.value_sum / row.total) * 10) / 10 : 0;
        const avg_confidence = row.total ? Math.round((row.confidence_sum / row.total) * 100) / 100 : 0;
        const withBase = {
            ...row,
            avg_value,
            avg_confidence,
            typeCounters: undefined,
            groupCounters: undefined,
            entityCounters: undefined,
            libraryCounters: undefined,
            top_types: topCounters(row.typeCounters, 5),
            top_groups: topCounters(row.groupCounters, 5),
            top_entities: topCounters(row.entityCounters, 6),
            target_libraries: topCounters(row.libraryCounters, 5),
        };
        withBase.business_brief = buildBusinessBrief(withBase);
        withBase.recommendations = regionRecommendation(withBase);
        return withBase;
    }).sort((a, b) => (b.high_value - a.high_value) || (b.avg_value - a.avg_value) || (b.total - a.total));

    const topAssets = assets
        .slice()
        .sort((a, b) => (Number(b.asset_value_score || 0) - Number(a.asset_value_score || 0)) || (Number(b.confidence || 0) - Number(a.confidence || 0)))
        .slice(0, 12)
        .map(asset => ({
            id: asset.pool_id,
            source: asset.pool_source,
            asset_type: asset.asset_type,
            asset_type_label: TYPE_LABELS[asset.asset_type] || asset.asset_type,
            title: asset.title,
            summary: asset.summary || asset.description,
            collection_region: asset.collection_region,
            business_sector: asset.business_sector,
            group_name: asset.group_name,
            value_score: asset.asset_value_score,
            confidence: asset.confidence,
        }));

    return {
        total: assets.length,
        view_scope: viewScope,
        formal_count: assets.filter(a => a.pool_source === 'formal').length,
        candidate_count: assets.filter(a => a.pool_source === 'candidate').length,
        high_value: assets.filter(a => a.value_level === 'high' || Number(a.asset_value_score || 0) >= 75).length,
        message_count: messageIntel?.total_messages || 0,
        category_totals: messageIntel?.category_totals || {},
        top_signal_samples: messageIntel?.top_samples || [],
        matrix: rows,
        regions: topCounters(regions, 100).map(item => item.key),
        sectors: topCounters(sectors, 100).map(item => item.key),
        top_entities: topCounters(entityMap, 12),
        top_actions: topCounters(actionMap, 8),
        top_risks: topCounters(riskMap, 8),
        top_assets: topAssets,
    };
}

const DOMAIN_INTELLIGENCE_PROFILES = {
    customer_service: {
        key: 'customer_service',
        title: '客服运营情报',
        short_title: '客服',
        subtitle: '资源使用方交互：客户问题、需求、闭环和可转 QA 资产。',
        tone: 'blue',
        regions: ['TGlaffic客服'],
        sectors: ['客服'],
        interaction_side: 'resource_user',
        primary_library: 'qa',
        primary_library_label: 'QA 知识库',
        empty: '当前客服域还没有足够样本形成运营情报。',
    },
    device_tech: {
        key: 'device_tech',
        title: '设备技术情报',
        short_title: '设备技术',
        subtitle: '资源提供方交互：设备、通道、动作有效性和供应商技术能力。',
        tone: 'cyan',
        regions: ['WA设备技术', 'TG-设备支持'],
        sectors: ['设备供应商'],
        interaction_side: 'resource_provider',
        primary_library: 'device',
        primary_library_label: '设备知识库',
        empty: '当前设备技术域还没有足够样本形成技术情报。',
    },
};

function domainProfileFor(kind) {
    return DOMAIN_INTELLIGENCE_PROFILES[String(kind || '').trim()] || DOMAIN_INTELLIGENCE_PROFILES.customer_service;
}

function assetMatchesDomainProfile(asset, profile) {
    const region = String(asset.collection_region || '').trim();
    const sector = normalizeSector(asset.business_sector);
    return profile.regions.includes(region) || profile.sectors.includes(sector);
}

function signalRowMatchesDomainProfile(row, profile) {
    const region = String(row.collection_region || '').trim();
    const sector = normalizeSector(row.business_sector);
    return profile.regions.includes(region) || profile.sectors.includes(sector);
}

function mergeBusinessCategoryBucket(target, bucket) {
    if (!target || !bucket) return;
    target.count += Number(bucket.count || 0);
    for (const item of bucket.terms?.values?.() || []) {
        addCounter(target.terms, item.key, { count: item.count || 1, label: item.label });
    }
    for (const item of bucket.groupCounters?.values?.() || []) {
        addCounter(target.groupCounters, item.key, { count: item.count || 1, label: item.label });
    }
    for (const item of bucket.objectCounters?.values?.() || []) {
        addCounter(target.objectCounters, item.key, {
            count: item.count || 1,
            type: item.type,
            value: item.value,
            label: item.label,
        });
    }
    for (const sample of bucket.sampleMessages || []) {
        if (!sample?.id || target.messageIds.has(sample.id) || target.sampleMessages.length >= 12) continue;
        target.messageIds.add(sample.id);
        target.sampleMessages.push(sample);
    }
    target.latest_at = Math.max(Number(target.latest_at || 0), Number(bucket.latest_at || 0));
}

function aggregateDomainSignals(messageIntel, profile) {
    const byKey = new Map();
    const categoryTotals = {};
    const categoryBuckets = {};
    for (const key of Object.keys(BUSINESS_INTEL_CATEGORIES)) categoryBuckets[key] = initBusinessCategory(key);
    const activeGroupNames = new Set();
    let totalMessages = 0;
    let latestAt = 0;

    for (const row of messageIntel?.byKey?.values?.() || []) {
        if (!signalRowMatchesDomainProfile(row, profile)) continue;
        byKey.set(row.key, row);
        totalMessages += Number(row.message_count || 0);
        for (const group of row.active_groups || []) activeGroupNames.add(group || '未知群');
        latestAt = Math.max(latestAt, Number(row.latest_at || 0));
        for (const bucket of Object.values(row.categories || {})) {
            categoryTotals[bucket.key] = (categoryTotals[bucket.key] || 0) + Number(bucket.count || 0);
            mergeBusinessCategoryBucket(categoryBuckets[bucket.key], bucket);
        }
    }

    const categoryDetails = Object.values(categoryBuckets).map(serializeBusinessCategory);
    const topSamples = categoryDetails
        .flatMap(item => item.sample_messages || [])
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
        .slice(0, 8);

    return {
        byKey,
        total_messages: totalMessages,
        active_group_count: activeGroupNames.size,
        latest_at: latestAt,
        category_totals: categoryTotals,
        category_details: categoryDetails,
        top_samples: topSamples,
    };
}

function assetLibraryKey(asset) {
    return asset.metrics?.target_library || asset.target_library || assetTargetLibrary(asset);
}

function addAssetRelatedCounters(asset, counters) {
    const m = asset.metrics || {};
    if (m.action_label) addCounter(counters.actions, m.action_label, { label: m.action_label });
    if (m.action_playbook?.action_label) addCounter(counters.actions, m.action_playbook.action_label, { label: m.action_playbook.action_label });
    if (m.inferred_role) addCounter(counters.roles, m.inferred_role, { label: m.inferred_role });
    if (Array.isArray(m.signals)) {
        for (const signal of m.signals) addCounter(counters.risks, signal, { label: signal });
    }
    for (const entity of extractAssetEntities(asset)) {
        if (entity.type === 'action') addCounter(counters.actions, entity.value, { count: entity.weight, label: entity.value });
        if (entity.type === 'risk_signal' || entity.type === 'issue_term') addCounter(counters.risks, entity.value, { count: entity.weight, label: entity.value });
        if (entity.type === 'role') addCounter(counters.roles, entity.value, { count: entity.weight, label: entity.value });
        if (entity.type === 'contact') addCounter(counters.contacts, entity.value, { count: entity.weight, label: entity.value });
        if (entity.type === 'device_model' || entity.type === 'route' || entity.type === 'operator') {
            addCounter(counters.resources, entity.value, { count: entity.weight, label: entity.value, type: entity.type });
        }
    }
}

function summarizeDomainAssets(assets) {
    const counters = {
        groups: new Map(),
        actions: new Map(),
        risks: new Map(),
        roles: new Map(),
        contacts: new Map(),
        resources: new Map(),
        libraries: new Map(),
        types: new Map(),
    };
    const stats = {
        total: assets.length,
        high_value: 0,
        pending_review: 0,
        auto_ready: 0,
        actions: 0,
        effective_actions: 0,
        avg_effect_delay_mins: 0,
        risks: 0,
        contacts: 0,
        commitments: 0,
        qa_ready: 0,
        device_ready: 0,
        media: 0,
        changes: 0,
    };
    let delaySum = 0;
    let delayCount = 0;

    for (const asset of assets) {
        const type = asset.asset_type;
        const library = assetLibraryKey(asset);
        stats.high_value += (asset.value_level === 'high' || Number(asset.asset_value_score || 0) >= 75) ? 1 : 0;
        stats.pending_review += asset.review_status === 'pending_review' ? 1 : 0;
        stats.auto_ready += asset.metrics?.machine_assessment?.decision === 'auto_ready' ? 1 : 0;
        stats.actions += type === 'operation_action' ? 1 : 0;
        stats.risks += type === 'risk_pattern' ? 1 : 0;
        stats.contacts += type === 'contact_role' ? 1 : 0;
        stats.commitments += type === 'sla_commitment' ? 1 : 0;
        stats.media += type === 'media_evidence' ? 1 : 0;
        stats.changes += type === 'change_event' ? 1 : 0;
        stats.qa_ready += library === 'qa' ? 1 : 0;
        stats.device_ready += library === 'device' ? 1 : 0;
        if (asset.metrics?.effectiveness_signal) stats.effective_actions += 1;
        const delay = Number(asset.metrics?.effect_delay_mins);
        if (Number.isFinite(delay) && delay > 0) {
            delaySum += delay;
            delayCount += 1;
        }

        addCounter(counters.groups, asset.group_name || '跨群汇总');
        addCounter(counters.libraries, library, { label: LIBRARY_LABELS[library] || asset.metrics?.target_library_label || library });
        addCounter(counters.types, type, { label: TYPE_LABELS[type] || type });
        addAssetRelatedCounters(asset, counters);
    }

    stats.avg_effect_delay_mins = delayCount ? Math.round((delaySum / delayCount) * 10) / 10 : 0;
    return { stats, counters };
}

function domainCard(label, value, tone, summary, action, meta = [], key = '', extra = {}) {
    return { key, label, value, tone, summary, action, meta, ...extra };
}

function domainCategoryValue(profile, key, stats, categories) {
    const base = Number(categories[key] || 0);
    if (key === 'effect') return base + Number(stats.effective_actions || 0);
    if (key === 'risk') return base + Number(stats.risks || 0);
    if (key === 'fulfillment') return base + Number(stats.commitments || 0);
    if (key === 'resource' && profile.key === 'device_tech') return base + Number(stats.device_ready || 0);
    if (key === 'market' && profile.key === 'customer_service') return base + Number(stats.qa_ready || 0);
    return base;
}

function domainCategorySummary(profile, key, value, stats, categories) {
    const count = Number(categories[key] || 0);
    const isCustomer = profile.key === 'customer_service';
    if (key === 'market') {
        if (isCustomer) return value ? '客户需求、国家/运营商、客户场景和可转 QA 线索已形成市场信号。' : '客户侧市场/需求信号暂不集中。';
        return value ? '设备或资源需求、区域热度和客户场景开始出现，可用于判断设备资源配置方向。' : '设备技术域的市场/需求信号暂不集中。';
    }
    if (key === 'price') {
        if (isCustomer) return count ? '客户侧已出现询价、价格或成本敏感表达，可转成价格情报。' : '客服消息中暂未形成明确价格/成本信号。';
        return count ? '供应商侧出现报价、费率或成本变化讨论，需要和资源效果一起判断性价比。' : '设备技术域暂未形成明确价格/成本信号。';
    }
    if (key === 'effect') {
        const delay = stats.avg_effect_delay_mins || '-';
        if (isCustomer) return value ? `客户侧已有测试、恢复或失败反馈，动作后平均约 ${delay} 分钟可观察结果。` : '客户侧可验证效果反馈还不多。';
        return value ? `设备侧已有测试、恢复或失败反馈，动作后平均约 ${delay} 分钟可观察结果。` : '设备侧可验证效果反馈还不多。';
    }
    if (key === 'resource') {
        if (isCustomer) return value ? '客户反馈中已经出现国家、运营商、通道或资源对象，可反向沉淀资源需求。' : '客户侧资源对象还不清晰。';
        return value ? '设备、SIM、通道、运营商和供应商资源信号较活跃，适合建立资源台账。' : '设备资源与供应商资源信号暂不集中。';
    }
    if (key === 'risk') {
        if (isCustomer) return value ? '客户侧失败、延迟、投诉或反复追问信号已经形成风险压力。' : '客户侧风险信号不集中。';
        return value ? '设备侧阻断、失败、掉线、超时或反复 checking 信号需要进入风险复盘。' : '设备侧风险信号不集中。';
    }
    if (key === 'fulfillment') {
        if (isCustomer) return value ? '客户侧 ETA、处理中、恢复确认或承诺类表达可用于履约跟踪。' : '客户侧承诺/ETA 信号还不明显。';
        return value ? '供应商联系人、ETA、承诺或完成反馈可用于技术响应和履约画像。' : '供应商响应和履约信号还不明显。';
    }
    return value ? `${profile.short_title}出现 ${value} 条相关信号。` : '暂未形成明显信号。';
}

function domainCategoryAction(profile, key) {
    const isCustomer = profile.key === 'customer_service';
    if (key === 'market') return isCustomer
        ? '抽取客户场景、国家/运营商、需求量级和可转 QA 问题。'
        : '把设备需求、区域热度和资源缺口同步到区域情报和设备资源规划。';
    if (key === 'price') return isCustomer
        ? '补齐客户目标价格、成本敏感点和最终可用资源，形成价格线索。'
        : '记录报价、成本变化、质量反馈和可替代供应商，形成价格基线。';
    if (key === 'effect') return isCustomer
        ? '把测试成功、失败、恢复反馈绑定到问题和处理步骤，沉淀客服 SOP。'
        : '把重启、reset、远程排查等动作绑定触发条件和恢复结果。';
    if (key === 'resource') return isCustomer
        ? '把客户提到的国家、运营商、通道、模板或资源诉求反向流入资源台账。'
        : '按设备/型号、SIM、通道、运营商和供应商拆出有效、失败、待验证状态。';
    if (key === 'risk') return isCustomer
        ? '优先归类收不到、失败、延迟、投诉升级，并标记影响客户和场景。'
        : '拆分阻断、超时、掉线、失败和沉默，配置设备/供应商风险预警。';
    if (key === 'fulfillment') return isCustomer
        ? '记录承诺方、ETA、实际恢复和是否兑现，联动客服复盘。'
        : '识别关键技术接口人，记录 ETA、处理方、兑现情况和重复违约对象。';
    return '继续观察，等待更多上下文。';
}

function domainCategoryMeta(profile, key, stats, categories) {
    const base = Number(categories[key] || 0);
    if (key === 'market') return profile.key === 'customer_service'
        ? [`市场 ${base}`, `可转 QA ${stats.qa_ready}`]
        : [`市场 ${base}`, `设备库 ${stats.device_ready}`];
    if (key === 'price') return [`价格 ${base}`, `高价值 ${stats.high_value}`];
    if (key === 'effect') return [`效果 ${base}`, `有效动作 ${stats.effective_actions}`];
    if (key === 'resource') return profile.key === 'device_tech'
        ? [`资源 ${base}`, `设备库 ${stats.device_ready}`]
        : [`资源 ${base}`, `资源对象`];
    if (key === 'risk') return [`风险信号 ${base}`, `风险资产 ${stats.risks}`];
    if (key === 'fulfillment') return [`履约 ${base}`, `承诺 ${stats.commitments}`, `联系人 ${stats.contacts}`];
    return [`信号 ${base}`];
}

function domainSignalContextRow(profile, signalSummary, stats = {}) {
    return {
        collection_region: profile.short_title || profile.title || '专项',
        business_sector: profile.key === 'customer_service' ? '客服' : '设备技术',
        message_count: Number(signalSummary?.total_messages || 0),
        business_intel: { message_count: Number(signalSummary?.total_messages || 0) },
        high_value: Number(stats.high_value || 0),
    };
}

function domainCategoryDetail(signalSummary, key) {
    return (signalSummary?.category_details || []).find(item => item.key === key) || null;
}

function domainCategoryEvidence(profile, key, stats, categories, signalSummary) {
    const detail = domainCategoryDetail(signalSummary, key);
    if (!detail || !Number(detail.count || 0)) return domainCategoryMeta(profile, key, stats, categories);
    const context = domainSignalContextRow(profile, signalSummary, stats);
    return buildCategoryBasis(detail, context).slice(0, 6);
}

function domainCategorySummaryFromConversation(profile, key, value, stats, categories, signalSummary) {
    const detail = domainCategoryDetail(signalSummary, key);
    if (!detail || !Number(detail.count || 0)) return domainCategorySummary(profile, key, value, stats, categories);
    return buildConversationSummary(detail, domainSignalContextRow(profile, signalSummary, stats));
}

function domainCategoryMetaWithObjects(profile, key, stats, categories, signalSummary) {
    const detail = domainCategoryDetail(signalSummary, key);
    const base = domainCategoryMeta(profile, key, stats, categories);
    if (!detail || !Number(detail.count || 0)) return base;
    const objectLabels = categoryObjectLabels(detail, 3);
    const groupLabels = categoryGroupLabels(detail, 2);
    const extra = [];
    if (objectLabels.length) extra.push(`对象 ${objectLabels.join('、')}`);
    if (groupLabels.length) extra.push(`群 ${groupLabels.join('、')}`);
    return uniqueItems([...base, ...extra], item => item).slice(0, 5);
}

function buildDomainIntelCards(profile, stats, signalSummary) {
    const categories = signalSummary?.category_totals || {};
    return Object.entries(BUSINESS_INTEL_CATEGORIES).map(([key, meta]) => {
        const value = domainCategoryValue(profile, key, stats, categories);
        const detail = domainCategoryDetail(signalSummary, key);
        return domainCard(
            meta.label,
            value,
            meta.tone,
            domainCategorySummaryFromConversation(profile, key, value, stats, categories, signalSummary),
            domainCategoryAction(profile, key),
            domainCategoryMetaWithObjects(profile, key, stats, categories, signalSummary),
            key,
            {
                basis: domainCategoryEvidence(profile, key, stats, categories, signalSummary),
                objects: detail ? categoryObjectLabels(detail, 6, { excludeGroups: false }) : [],
                sample_messages: (detail?.sample_messages || []).slice(0, 3),
                signal_count: Number(detail?.count || 0),
                active_group_count: Number(detail?.active_group_count || 0),
            }
        );
    });
}

function buildCustomerServiceCards(stats, signalSummary) {
    return buildDomainIntelCards(DOMAIN_INTELLIGENCE_PROFILES.customer_service, stats, signalSummary);
}

function buildDeviceTechCards(stats, signalSummary) {
    return buildDomainIntelCards(DOMAIN_INTELLIGENCE_PROFILES.device_tech, stats, signalSummary);
}

function buildDomainActions(profile, stats, categories) {
    const tips = [];
    if (profile.key === 'customer_service') {
        if ((categories.risk || 0) || stats.risks) tips.push('先把客户反馈拆成收不到、发送失败、延迟、投诉升级四类，形成客服问题看板。');
        if ((categories.market || 0) || (categories.price || 0)) tips.push('补齐国家、运营商、客户场景、价格和需求量级，让客服反馈能转成市场情报。');
        if (stats.effective_actions) tips.push('把已验证有效的处理动作沉淀到 QA 知识库，并标记触发条件和预计恢复时间。');
        if (stats.pending_review) tips.push('优先审核待审高价值客服资产，减少 QA 积累效率低的问题。');
    } else {
        if ((categories.resource || 0) || (categories.effect || 0)) tips.push('建立设备/通道/运营商资源台账，按有效、失败、待验证三类维护。');
        if (stats.effective_actions) tips.push('将远程排查、重启、reset、换 SIM 等有效动作沉淀为设备知识库步骤。');
        if (stats.contacts || stats.commitments) tips.push('把关键技术接口人和 ETA 兑现情况同步到供应商画像。');
        if ((categories.risk || 0) || stats.risks) tips.push('对阻断、超时、掉线、反复 checking 配置风险预警和复盘入口。');
    }
    if (!tips.length) tips.push(profile.empty);
    return tips.slice(0, 4);
}

function buildDomainBrief(profile, stats, categories, summary, signalSummary) {
    const topCategory = Object.entries(categories)
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0];
    const topLabel = topCategory ? BUSINESS_INTEL_CATEGORIES[topCategory[0]]?.label : '';
    const topCount = topCategory ? Number(topCategory[1] || 0) : 0;
    const topDetail = topCategory ? domainCategoryDetail(signalSummary, topCategory[0]) : null;
    const focus = topDetail && Number(topDetail.count || 0) ? categoryConcreteFocus(topDetail) : '客户/资源反馈';
    const groups = topDetail && Number(topDetail.count || 0) ? formatIntelList(categoryGroupLabels(topDetail, 3), '多个对话群') : '多个对话群';
    if (profile.key === 'customer_service') {
        return {
            title: `客服域：${topLabel || '客户反馈'}集中在 ${focus}`,
            summary: `基于 ${summary.message_count} 条近期客服对话和 ${summary.asset_count} 个知识资产样本，当前最明显的是${topLabel || '客户反馈'}，主要围绕 ${focus}，集中在 ${groups}。这些信息适合把客户问题转成 QA、资源需求、效果反馈和风险复盘；${topLabel ? `${topLabel}已识别 ${topCount} 条信号。` : '还需要继续积累稳定闭环。'}`,
        };
    }
    return {
        title: `设备技术域：${topLabel || '资源状态'}集中在 ${focus}`,
        summary: `基于 ${summary.message_count} 条近期设备技术对话和 ${summary.asset_count} 个知识资产样本，当前最明显的是${topLabel || '资源状态'}，主要围绕 ${focus}，集中在 ${groups}。这些信息适合沉淀设备知识、资源台账、供应商画像和风险预警；${topLabel ? `${topLabel}已识别 ${topCount} 条信号。` : '还需要继续积累稳定闭环。'}`,
    };
}

const DOMAIN_AI_CACHE = new Map();

function envPositiveNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function domainAiRuntimeConfig() {
    const config = typeof aiClient.getConfig === 'function' ? aiClient.getConfig() : {};
    return {
        enabled: process.env.DOMAIN_INTELLIGENCE_AI_ENABLED !== '0',
        model: process.env.DOMAIN_INTELLIGENCE_AI_MODEL || config.domainIntelligenceModel || config.knowledgeModel || config.model || 'knowledge-default',
        tier: process.env.DOMAIN_INTELLIGENCE_AI_TIER || 'default',
        hasProvider: Boolean(config.hasKey || config.hasGemini),
        promptVersion: aiClient.PROMPT_VERSIONS?.domainIntelligence || 'v1.0',
        timeoutMs: envPositiveNumber('DOMAIN_INTELLIGENCE_AI_TIMEOUT_MS', 25000),
        cacheMs: envPositiveNumber('DOMAIN_INTELLIGENCE_AI_CACHE_MS', 10 * 60 * 1000),
    };
}

function domainAiFallback(status, runtime, reason, label = '专项情报') {
    return {
        enabled: false,
        status,
        model: runtime.model,
        prompt_version: runtime.promptVersion,
        summary: `AI 判断暂未参与，当前展示为${label}的规则抽取和确定性总结。`,
        judgment: reason,
        priority: 'medium',
        confidence: 0,
        reasons: ['规则层已保留对话对象、集中群、代表信号和建议动作'],
        risks: ['缺少模型二次判断时，应优先人工复核高价值或高风险卡片'],
        actions: ['确认 AI 配置后刷新页面，或继续按判断依据人工筛选'],
        cards: [],
    };
}

function compactAiText(value, maxLen = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function compactDomainCardForAi(card) {
    return {
        key: card.key,
        label: card.label,
        value: card.value,
        summary: compactAiText(card.summary, 220),
        action: compactAiText(card.action, 120),
        basis: (card.basis || []).slice(0, 4).map(item => compactAiText(item, 90)),
        objects: (card.objects || []).slice(0, 4).map(item => compactAiText(item, 80)),
        samples: (card.sample_messages || []).slice(0, 1).map(item => ({
            group_name: compactAiText(item.group_name, 60),
            signal: item.signal,
            objects: (item.objects || []).slice(0, 3).map(object => compactAiText(object, 60)),
            summary: compactAiText(item.summary, 80),
        })),
    };
}

function buildDomainAiPrompt(profile, dashboard) {
    const payload = {
        domain: profile.title,
        interaction_side: profile.interaction_side,
        days: dashboard.days,
        brief: dashboard.brief,
        summary: dashboard.summary,
        cards: (dashboard.cards || []).map(compactDomainCardForAi),
        priority_actions: dashboard.priority_actions || [],
    };
    return [
        '你是社媒监控系统的运营情报分析助手。请只基于输入的已抽取事实做判断，不要编造未出现的客户、国家、供应商、设备、价格或结果。',
        '任务：判断该专项情报是否有运营参考价值、优先级如何、缺口是什么、下一步应该做什么。',
        '输出必须是严格 JSON：',
        '{',
        '  "summary": "不超过120字的总体判断，必须提到具体对象或信号类别",',
        '  "judgment": "不超过80字的价值判断",',
        '  "priority": "high|medium|low",',
        '  "confidence": 0-100,',
        '  "reasons": ["最多4条判断理由"],',
        '  "risks": ["最多3条风险或缺口"],',
        '  "actions": ["最多4条可执行动作"],',
        '  "cards": [{"key":"market|price|effect|resource|risk|fulfillment","summary":"该卡片的AI补充总结","judgment":"该卡片是否值得跟进","priority":"high|medium|low","confidence":0-100}]',
        '}',
        '',
        `事实包：${JSON.stringify(payload)}`,
    ].join('\n');
}

function normalizeStringList(value, limit = 4) {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean).slice(0, limit);
}

function normalizeAiCardList(value, fallbackConfidence = 0) {
    if (!Array.isArray(value)) return [];
    return value.map(item => ({
        key: String(item?.key || '').trim(),
        summary: String(item?.summary || '').trim().slice(0, 180),
        judgment: String(item?.judgment || '').trim().slice(0, 140),
        priority: ['high', 'medium', 'low'].includes(item?.priority) ? item.priority : 'medium',
        confidence: Math.max(0, Math.min(100, Math.round(Number(item?.confidence || fallbackConfidence || 0)))),
    })).filter(item => item.key);
}

function normalizeDomainAiResult(raw, runtime) {
    const result = raw && typeof raw === 'object' ? raw : {};
    const priority = ['high', 'medium', 'low'].includes(result.priority) ? result.priority : 'medium';
    const confidence = Math.max(0, Math.min(100, Math.round(Number(result.confidence || 0))));
    const cards = normalizeAiCardList(result.cards, confidence);
    return {
        enabled: true,
        status: 'ready',
        model: runtime.model,
        prompt_version: runtime.promptVersion,
        summary: String(result.summary || '').trim().slice(0, 180),
        judgment: String(result.judgment || '').trim().slice(0, 140),
        priority,
        confidence,
        reasons: normalizeStringList(result.reasons, 4),
        risks: normalizeStringList(result.risks, 3),
        actions: normalizeStringList(result.actions, 4),
        cards,
    };
}

function applyDomainAiJudgment(dashboard, aiJudgment) {
    const byKey = new Map((aiJudgment?.cards || []).map(item => [item.key, item]));
    dashboard.ai_judgment = aiJudgment;
    dashboard.cards = (dashboard.cards || []).map(card => {
        const aiCard = byKey.get(card.key);
        if (!aiCard) return card;
        return {
            ...card,
            ai_summary: aiCard.summary,
            ai_judgment: aiCard.judgment,
            ai_priority: aiCard.priority,
            ai_confidence: aiCard.confidence,
        };
    });
    return dashboard;
}

function domainAiCacheKey(profile, dashboard) {
    return JSON.stringify({
        key: profile.key,
        days: dashboard.days,
        summary: dashboard.summary,
        categories: dashboard.category_totals,
        samples: (dashboard.top_signal_samples || []).slice(0, 5).map(item => item.id),
    });
}

async function enrichDomainDashboardWithAi(profile, dashboard, options = {}) {
    const runtime = domainAiRuntimeConfig();
    if (options.enableAi === false || !runtime.enabled) {
        return applyDomainAiJudgment(dashboard, domainAiFallback('disabled', runtime, '专项情报 AI 已关闭。'));
    }
    if (!runtime.hasProvider) {
        return applyDomainAiJudgment(dashboard, domainAiFallback('not_configured', runtime, '未配置可用 AI Key。'));
    }

    const cacheKey = domainAiCacheKey(profile, dashboard);
    const cached = DOMAIN_AI_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < runtime.cacheMs) {
        return applyDomainAiJudgment(dashboard, cached.value);
    }

    try {
        const text = await aiClient.callAI(buildDomainAiPrompt(profile, dashboard), {
            model: runtime.model,
            tier: runtime.tier,
            maxTokens: 1400,
            timeoutMs: runtime.timeoutMs,
            systemMessage: '你是 JSON-only API。只输出合法 JSON，不要 markdown，不要解释推理过程。',
        });
        const parsed = aiClient.extractJSON(text);
        const aiJudgment = normalizeDomainAiResult(parsed, runtime);
        DOMAIN_AI_CACHE.set(cacheKey, { at: Date.now(), value: aiJudgment });
        return applyDomainAiJudgment(dashboard, aiJudgment);
    } catch (err) {
        const fallback = domainAiFallback('fallback', runtime, `AI 调用失败：${err.message || 'unknown'}`);
        DOMAIN_AI_CACHE.set(cacheKey, { at: Date.now(), value: fallback });
        return applyDomainAiJudgment(dashboard, fallback);
    }
}

function regionFocusRow(summary, focusKey = '') {
    const rows = summary?.matrix || [];
    if (!rows.length) return null;
    if (focusKey) {
        const found = rows.find(row => row.key === focusKey);
        if (found) return found;
    }
    return rows[0];
}

function compactRegionCategoryForAi(category) {
    return {
        key: category.key,
        label: category.label,
        count: category.count,
        title: compactAiText(category.card_title || category.label, 80),
        summary: compactAiText(category.conclusion || category.insight, 220),
        basis: (category.basis || []).slice(0, 4).map(item => compactAiText(item, 90)),
        objects: (category.key_objects || []).slice(0, 4).map(item => compactAiText(item, 80)),
        missing_info: (category.missing_info || []).slice(0, 3).map(item => compactAiText(item, 80)),
        next_steps: (category.next_steps || []).slice(0, 3).map(item => compactAiText(item, 90)),
        action_status: category.action_status?.label || '',
    };
}

function buildRegionAiPrompt(summary, focusRow) {
    const brief = focusRow?.business_brief || {};
    const payload = {
        scope: summary?.view_scope?.label || '区域运营情报',
        days: summary?.days || undefined,
        focus: {
            key: focusRow?.key,
            collection_region: focusRow?.collection_region,
            business_sector: focusRow?.business_sector,
            message_count: focusRow?.business_intel?.message_count || 0,
            active_group_count: focusRow?.business_intel?.active_group_count || 0,
            asset_count: focusRow?.total || 0,
            high_value: focusRow?.high_value || 0,
        },
        brief: {
            title: brief.title,
            summary: compactAiText(brief.summary, 260),
            battle_report: compactAiText(brief.battle_report, 220),
            key_points: (brief.key_points || []).slice(0, 3).map(item => ({
                title: compactAiText(item.title, 50),
                text: compactAiText(item.text, 130),
            })),
        },
        categories: (brief.categories || []).map(compactRegionCategoryForAi),
        priority_actions: (brief.priority_actions || []).slice(0, 4).map(item => ({
            title: compactAiText(item.title, 50),
            text: compactAiText(item.text, 130),
        })),
    };
    return [
        '你是社媒监控系统的区域运营情报分析助手。请只基于输入事实包做判断，不要编造未出现的客户、国家、供应商、设备、价格或结果。',
        '任务：对当前区域/板块的运营情报做二次判断，给出优先级、价值判断、缺口和下一步动作。',
        '输出必须是严格 JSON：',
        '{',
        '  "summary": "不超过120字的总体判断，必须提到具体对象或信号类别",',
        '  "judgment": "不超过80字的价值判断",',
        '  "priority": "high|medium|low",',
        '  "confidence": 0-100,',
        '  "reasons": ["最多4条判断理由"],',
        '  "risks": ["最多3条风险或缺口"],',
        '  "actions": ["最多4条可执行动作"],',
        '  "cards": [{"key":"market|price|effect|resource|risk|fulfillment","summary":"该卡片AI补充总结","judgment":"该卡片是否值得跟进","priority":"high|medium|low","confidence":0-100}]',
        '}',
        '',
        `事实包：${JSON.stringify(payload)}`,
    ].join('\n');
}

function regionAiCacheKey(summary, focusRow) {
    const categories = focusRow?.business_brief?.categories || [];
    return JSON.stringify({
        kind: 'region',
        scope: summary?.view_scope?.key,
        focus: focusRow?.key,
        messages: focusRow?.business_intel?.message_count || 0,
        assets: focusRow?.total || 0,
        counts: categories.map(item => [item.key, item.count]),
        latest: focusRow?.last_seen_at || 0,
    });
}

function applyRegionAiJudgment(summary, focusRow, aiJudgment) {
    summary.ai_judgment = aiJudgment;
    summary.ai_focus_key = focusRow?.key || '';
    const byKey = new Map((aiJudgment?.cards || []).map(item => [item.key, item]));
    if (focusRow?.business_brief?.categories?.length) {
        focusRow.business_brief.categories = focusRow.business_brief.categories.map(category => {
            const aiCard = byKey.get(category.key);
            if (!aiCard) return category;
            return {
                ...category,
                ai_summary: aiCard.summary,
                ai_judgment: aiCard.judgment,
                ai_priority: aiCard.priority,
                ai_confidence: aiCard.confidence,
            };
        });
    }
    return summary;
}

async function enrichRegionDashboardWithAi(summary, options = {}) {
    const runtime = domainAiRuntimeConfig();
    const focusRow = regionFocusRow(summary, options.focusKey);
    if (!focusRow) {
        return applyRegionAiJudgment(summary, null, domainAiFallback('empty', runtime, '暂无可分析的区域/板块。', '区域运营情报'));
    }
    if (options.enableAi === false || !runtime.enabled) {
        return applyRegionAiJudgment(summary, focusRow, domainAiFallback('disabled', runtime, '区域运营情报 AI 已关闭。', '区域运营情报'));
    }
    if (!runtime.hasProvider) {
        return applyRegionAiJudgment(summary, focusRow, domainAiFallback('not_configured', runtime, '未配置可用 AI Key。', '区域运营情报'));
    }

    const cacheKey = regionAiCacheKey(summary, focusRow);
    const cached = DOMAIN_AI_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < runtime.cacheMs) {
        return applyRegionAiJudgment(summary, focusRow, cached.value);
    }

    try {
        const text = await aiClient.callAI(buildRegionAiPrompt(summary, focusRow), {
            model: runtime.model,
            tier: runtime.tier,
            maxTokens: 1400,
            timeoutMs: runtime.timeoutMs,
            systemMessage: '你是 JSON-only API。只输出合法 JSON，不要 markdown，不要解释推理过程。',
        });
        const parsed = aiClient.extractJSON(text);
        const aiJudgment = normalizeDomainAiResult(parsed, runtime);
        DOMAIN_AI_CACHE.set(cacheKey, { at: Date.now(), value: aiJudgment });
        return applyRegionAiJudgment(summary, focusRow, aiJudgment);
    } catch (err) {
        const fallback = domainAiFallback('fallback', runtime, `AI 调用失败：${err.message || 'unknown'}`, '区域运营情报');
        DOMAIN_AI_CACHE.set(cacheKey, { at: Date.now(), value: fallback });
        return applyRegionAiJudgment(summary, focusRow, fallback);
    }
}

function buildDomainIntelligenceDashboard(db, kind, options = {}) {
    const profile = domainProfileFor(kind);
    const days = Math.min(365, Math.max(1, parseInt(options.days) || 30));
    const allAssets = loadKnowledgeAssetPool(db, { days, scope: 'domain' });
    const assets = allAssets.filter(asset => assetMatchesDomainProfile(asset, profile));
    const allSignals = loadRegionalBusinessSignals({ days, scope: 'domain' });
    const signalSummary = aggregateDomainSignals(allSignals, profile);
    const assetSummary = summarizeDomainAssets(assets);
    const stats = assetSummary.stats;
    const categories = signalSummary.category_totals || {};
    const summary = {
        message_count: signalSummary.total_messages,
        active_group_count: signalSummary.active_group_count,
        latest_at: signalSummary.latest_at,
        asset_count: stats.total,
        high_value: stats.high_value,
    };
    const cards = profile.key === 'customer_service'
        ? buildCustomerServiceCards(stats, signalSummary)
        : buildDeviceTechCards(stats, signalSummary);
    const regionalSummary = summarizeRegionDashboard(assets, signalSummary, { scope: 'domain' });

    return {
        profile,
        days,
        brief: buildDomainBrief(profile, stats, categories, summary, signalSummary),
        summary,
        stats,
        category_totals: categories,
        category_details: signalSummary.category_details || [],
        top_signal_samples: signalSummary.top_samples || [],
        cards,
        priority_actions: buildDomainActions(profile, stats, categories),
        top_groups: topCounters(assetSummary.counters.groups, 8),
        top_actions: topCounters(assetSummary.counters.actions, 8),
        top_risks: topCounters(assetSummary.counters.risks, 8),
        top_roles: topCounters(assetSummary.counters.roles, 8),
        top_contacts: topCounters(assetSummary.counters.contacts, 8),
        top_resources: topCounters(assetSummary.counters.resources, 8),
        knowledge_flow: topCounters(assetSummary.counters.libraries, 6),
        top_types: topCounters(assetSummary.counters.types, 6),
        matrix: regionalSummary.matrix,
        top_assets: assets
            .slice()
            .sort((a, b) => (Number(b.asset_value_score || 0) - Number(a.asset_value_score || 0)) || (Number(b.confidence || 0) - Number(a.confidence || 0)))
            .slice(0, 10)
            .map(asset => ({
                id: asset.pool_id,
                source: asset.pool_source,
                asset_type: asset.asset_type,
                asset_type_label: TYPE_LABELS[asset.asset_type] || asset.asset_type,
                title: asset.title,
                summary: asset.metrics?.asset_insight?.reusable_summary || asset.summary || asset.description,
                group_name: asset.group_name,
                collection_region: asset.collection_region,
                business_sector: asset.business_sector,
                value_score: asset.asset_value_score,
                confidence: asset.confidence,
                target_library_label: asset.metrics?.target_library_label || LIBRARY_LABELS[assetLibraryKey(asset)] || assetLibraryKey(asset),
            })),
    };
}

function graphNodeId(type, value) {
    return `${normalizeEntityType(type)}:${String(value || '').trim()}`;
}

function graphRelationLabel(kind, fallback) {
    return GRAPH_RELATION_LABELS[kind] || fallback || kind || '关联';
}

function graphEdgeMeaning(kind, from, to, asset) {
    const relation = graphRelationLabel(kind);
    const sector = normalizeSector(asset?.business_sector);
    const region = asset?.collection_region || '未知区';
    if (kind === 'provider_resource') return `${from.label} 与 ${to.label} 在 ${sector} 交互中反复出现，可作为资源归属或能力线索继续核实。`;
    if (kind === 'customer_need') return `${from.label} 的客户侧反馈涉及 ${to.label}，适合转入 QA、需求或市场情报整理。`;
    if (kind === 'issue_action') return `${from.label} 后出现 ${to.label}，可作为问题处置路径候选。`;
    if (kind === 'action_outcome') return `${from.label} 后出现 ${to.label}，用于判断动作是否值得沉淀。`;
    if (kind === 'provider_risk') return `${from.label} 与 ${to.label} 风险信号绑定，适合进入供应商风险画像。`;
    if (kind === 'contact_scope') return `${from.label} 与 ${to.label} 在同一业务上下文反复出现，可用于找人和升级路径。`;
    if (kind === 'contact_action') return `${from.label} 执行或参与 ${to.label}，可用于判断技术处理能力。`;
    if (kind === 'region_resource') return `${region} 出现 ${to.label} 资源/对象信号，可用于区域资源台账。`;
    return `${from.label} 与 ${to.label} 存在「${relation}」关系。`;
}

function graphTargetLibrariesForNode(node) {
    if (!node) return [];
    if (['country', 'operator', 'device_model', 'route', 'sender_id'].includes(node.type)) return ['区域情报库', '资源台账', '供应商画像'];
    if (['issue_term', 'risk_signal'].includes(node.type)) return ['风险模式库', 'QA 知识库', '设备知识库'];
    if (node.type === 'action') return ['运营处理动作库', 'QA 知识库', '设备知识库'];
    if (node.type === 'supplier') return ['供应商画像', '资源台账', 'SLA 履约资产'];
    if (node.type === 'contact') return ['联系人/角色知识库', '供应商画像'];
    if (node.type === 'customer') return ['QA 知识库', '区域情报库'];
    return ['实体关系图谱'];
}

function businessNodeForAsset(asset) {
    const group = String(asset?.group_name || '').trim();
    const sector = normalizeSector(asset?.business_sector);
    if (!group) return null;
    if (isProviderSector(sector)) {
        return { type: 'supplier', value: group, label: '供应商/资源群' };
    }
    if (isCustomerSector(sector)) {
        return { type: 'customer', value: group, label: '客户/使用方群' };
    }
    return { type: 'group', value: group, label: '来源群' };
}

function contactNodeForAsset(asset) {
    const name = contactNameFromAsset(asset)
        || asset?.metrics?.action_actor
        || asset?.metrics?.action_playbook?.action_actor
        || '';
    return String(name || '').trim();
}

function outcomeForAsset(asset) {
    if (asset?.asset_type === 'operation_action') {
        if (asset.metrics?.effectiveness_signal) return '恢复/有效';
        if (asset.metrics?.effect_checked) return '已验证但效果不明确';
        return '待验证';
    }
    if (asset?.asset_type === 'sla_commitment') {
        if (asset.metrics?.commitment_met === 1) return '承诺已兑现';
        if (asset.metrics?.commitment_met === 0) return '承诺未兑现/待复核';
        return '承诺待确认';
    }
    return '';
}

function graphViewAllowsEdge(edge, viewKey) {
    if (viewKey === 'all') return true;
    return Array.isArray(edge.views) && edge.views.includes(viewKey);
}

function nodeBriefFor(node, edges, nodeMap) {
    const related = edges
        .filter(edge => edge.from === node.id || edge.to === node.id)
        .sort((a, b) => (Number(b.value_score || 0) - Number(a.value_score || 0)) || (Number(b.weight || 0) - Number(a.weight || 0)));
    const byType = new Map();
    for (const edge of related) {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const other = nodeMap.get(otherId);
        if (!other) continue;
        const list = byType.get(other.type) || [];
        list.push(other);
        byType.set(other.type, list);
    }
    const pick = (...types) => types.flatMap(type => byType.get(type) || []);
    const keyObjects = uniqueItems(pick('region', 'supplier', 'customer', 'country', 'operator', 'device_model', 'route', 'sender_id', 'action', 'risk_signal', 'contact', 'role')
        .map(item => ({ type: item.type_label, label: item.label, weight: item.weight })), item => `${item.type}:${item.label}`)
        .slice(0, 8);
    const relationCount = related.length;
    const riskCount = pick('risk_signal', 'issue_term').length;
    const actionCount = pick('action', 'outcome').length;
    const resourceCount = pick('country', 'operator', 'device_model', 'route', 'sender_id').length;
    const supplierCount = pick('supplier').length;
    const contactCount = pick('contact', 'role').length;

    let conclusion = `${node.label} 已关联 ${relationCount} 条业务关系。`;
    let impact = '可作为图谱查询入口，继续查看关联资产和来源证据。';
    let nextSteps = ['查看右侧关键关系，确认是否有可沉淀资产', '按证据强度补齐缺失字段', '确认后流入对应知识库或画像'];

    if (['country', 'operator', 'device_model', 'route', 'sender_id'].includes(node.type)) {
        conclusion = `${node.label} 关联 ${supplierCount} 个供应商/群、${actionCount} 个处置或结果信号、${riskCount} 个问题/风险信号。`;
        impact = resourceCount || supplierCount ? '适合作为资源查询入口，判断覆盖区域、可用资源、问题类型和替代方向。' : '当前更像资源线索，需要继续补齐供应商、质量和效果反馈。';
        nextSteps = ['核实可用供应商或线路', '补齐价格、质量和测试结果', '把有效资源沉淀到资源台账或供应商画像'];
    } else if (node.type === 'supplier') {
        conclusion = `${node.label} 关联 ${resourceCount} 个资源对象、${riskCount} 个风险/问题、${contactCount} 个联系人/角色。`;
        impact = '适合判断供应商覆盖能力、技术响应、风险暴露和可替代性。';
        nextSteps = ['查看关联资源和风险是否集中', '确认关键联系人和处理动作', '同步到供应商画像和资源台账'];
    } else if (['issue_term', 'risk_signal'].includes(node.type)) {
        conclusion = `${node.label} 关联 ${actionCount} 个处置动作/结果、${supplierCount} 个供应商或群。`;
        impact = '适合从问题反查历史动作，判断是否可形成 SOP 或预警规则。';
        nextSteps = ['筛选已出现恢复结果的动作', '区分有效、无效和待验证处理', '沉淀到风险模式库、QA 或设备知识库'];
    } else if (node.type === 'action') {
        conclusion = `${node.label} 关联 ${riskCount} 个问题/风险、${supplierCount} 个供应商或群。`;
        impact = '适合评估动作是否可复用，以及适用条件和恢复结果是否明确。';
        nextSteps = ['确认触发条件和执行方', '核对动作后的恢复信号', '沉淀为运营处理动作或知识库步骤'];
    } else if (node.type === 'contact') {
        conclusion = `${node.label} 关联 ${contactCount} 个角色/身份、${supplierCount} 个供应商或群、${actionCount} 个动作/结果。`;
        impact = '适合判断联系人是处理人、确认人、转发人还是升级路径。';
        nextSteps = ['确认内部/外部身份', '核实负责对象和处理动作', '沉淀到联系人/角色知识库和供应商画像'];
    }

    return {
        conclusion,
        impact,
        key_objects: keyObjects,
        next_steps: nextSteps,
        target_libraries: graphTargetLibrariesForNode(node),
    };
}

function buildEntityGraph(assets, centerId = '', view = 'resource') {
    const viewConfig = graphViewFor(view);
    const viewKey = viewConfig.key;
    const nodes = new Map();
    const edges = new Map();

    const addNode = (type, value, patch = {}) => {
        const entityType = normalizeEntityType(type);
        const entityValue = String(value || '').trim();
        if (!entityType || !entityValue || entityValue === '-') return null;
        const id = graphNodeId(entityType, entityValue);
        const existing = nodes.get(id) || {
            id,
            type: entityType,
            type_label: GRAPH_ENTITY_LABELS[entityType] || entityType,
            label: entityValue,
            weight: 0,
            value_score: 0,
            asset_count: 0,
            sources: [],
            views: new Set(),
        };
        existing.weight += Number(patch.weight || 1);
        existing.value_score = Math.max(existing.value_score || 0, Number(patch.value_score || 0));
        existing.asset_count += patch.asset_count || 0;
        for (const item of patch.views || []) existing.views.add(item);
        if (patch.asset) {
            existing.sources = uniqueItems([
                ...existing.sources,
                {
                    id: patch.asset.pool_id,
                    source: patch.asset.pool_source,
                    title: patch.asset.title,
                    asset_type: patch.asset.asset_type,
                    asset_type_label: TYPE_LABELS[patch.asset.asset_type] || patch.asset.asset_type,
                    summary: patch.asset.summary || patch.asset.description,
                    value_score: patch.asset.asset_value_score,
                    group_name: patch.asset.group_name,
                    collection_region: patch.asset.collection_region,
                    business_sector: patch.asset.business_sector,
                },
            ], item => `${item.source}:${item.id}`).slice(0, 6);
        }
        nodes.set(id, existing);
        return existing;
    };

    const addEdge = (from, to, relation, asset, weight = 1, options = {}) => {
        if (!from?.id || !to?.id || from.id === to.id) return;
        const kind = options.kind || relation;
        const views = Array.from(new Set(options.views || ['all']));
        const key = `${from.id}=>${to.id}::${kind}`;
        const existing = edges.get(key) || {
            id: key,
            from: from.id,
            to: to.id,
            relation: graphRelationLabel(kind, relation),
            relation_kind: kind,
            weight: 0,
            value_score: 0,
            evidence_count: 0,
            confidence: 0,
            semantic: !!options.semantic,
            business_meaning: '',
            views: [],
            sources: [],
        };
        existing.weight += Number(weight || 1);
        existing.value_score = Math.max(existing.value_score || 0, Number(asset?.asset_value_score || 0));
        existing.evidence_count += asset ? 1 : 0;
        existing.confidence = Math.max(existing.confidence || 0, Number(asset?.confidence || 0));
        existing.semantic = existing.semantic || !!options.semantic;
        existing.views = Array.from(new Set([...(existing.views || []), ...views]));
        existing.business_meaning = existing.business_meaning || graphEdgeMeaning(kind, from, to, asset);
        for (const edgeView of views) {
            from.views?.add(edgeView);
            to.views?.add(edgeView);
        }
        if (asset) {
            existing.sources = uniqueItems([
                ...existing.sources,
                {
                    id: asset.pool_id,
                    source: asset.pool_source,
                    title: asset.title,
                    asset_type: asset.asset_type,
                    summary: asset.summary || asset.description,
                    value_score: asset.asset_value_score,
                    source_msg_ids: asset.source_msg_ids || [],
                },
            ], item => `${item.source}:${item.id}`).slice(0, 5);
        }
        edges.set(key, existing);
    };

    for (const asset of assets) {
        const valueScore = Number(asset.asset_value_score || 0);
        const sector = normalizeSector(asset.business_sector);
        const providerSide = isProviderSector(sector);
        const customerSide = isCustomerSector(sector);
        const semanticViews = providerSide
            ? ['market', 'price', 'effect', 'resource', 'risk', 'fulfillment']
            : customerSide
                ? ['market', 'price', 'effect', 'resource', 'risk', 'fulfillment']
                : ['market', 'resource'];
        const regionNode = addNode('region', asset.collection_region || '未知区', { asset, value_score: valueScore, asset_count: 1, views: ['market', 'price', 'effect', 'resource', 'risk', 'fulfillment'] });
        const sectorNode = addNode('sector', asset.business_sector || '未分类', { asset, value_score: valueScore, asset_count: 1, views: ['all'] });
        const groupNode = addNode('group', asset.group_name || '跨群汇总', { asset, value_score: valueScore, asset_count: 1, views: ['all', 'fulfillment'] });
        const typeNode = addNode('asset_type', TYPE_LABELS[asset.asset_type] || asset.asset_type, { asset, value_score: valueScore, asset_count: 1, views: ['all'] });
        const businessDescriptor = businessNodeForAsset(asset);
        const businessNode = businessDescriptor
            ? addNode(businessDescriptor.type, businessDescriptor.value, { asset, value_score: valueScore, asset_count: 1, views: semanticViews })
            : groupNode;

        addEdge(regionNode, sectorNode, '区域-板块', asset, 1, { kind: 'region_sector', views: ['all'] });
        addEdge(sectorNode, groupNode, '板块-来源群', asset, 1, { kind: 'sector_group', views: ['all'] });
        addEdge(groupNode, typeNode, '群-资产类型', asset, 1, { kind: 'group_asset', views: ['all'] });
        if (businessNode && businessNode.id !== groupNode.id) {
            addEdge(businessNode, groupNode, '业务对象来源群', asset, 1, { kind: 'sector_group', views: ['all', 'fulfillment'] });
        }
        if (providerSide && businessNode) addEdge(businessNode, regionNode, '供应商服务区域', asset, 1, { kind: 'provider_region', views: ['market', 'price', 'resource'], semantic: true });

        const entityNodes = [];
        for (const entity of extractAssetEntities(asset)) {
            const entityNode = addNode(entity.type, entity.value, {
                asset,
                weight: entity.weight,
                value_score: valueScore,
                asset_count: 1,
                views: ['all'],
            });
            if (!entityNode) continue;
            entityNodes.push(entityNode);
            addEdge(groupNode, entityNode, '群-实体共现', asset, entity.weight, { kind: 'group_entity', views: ['all'] });
            addEdge(typeNode, entityNode, '资产-实体', asset, Math.max(1, Math.round(entity.weight / 2)), { kind: 'asset_entity', views: ['all'] });

            if (['country', 'operator', 'device_model', 'route', 'sender_id'].includes(entityNode.type)) {
                const resourceViews = ['country', 'operator'].includes(entityNode.type) ? ['market', 'resource', 'effect'] : ['resource', 'effect'];
                addEdge(regionNode, entityNode, '区域资源信号', asset, entity.weight, { kind: 'region_resource', views: resourceViews, semantic: true });
                if (businessNode) {
                    addEdge(businessNode, entityNode, providerSide ? '供应商涉及资源' : '客户需求对象', asset, entity.weight, {
                        kind: providerSide ? 'provider_resource' : 'customer_need',
                        views: providerSide ? ['market', 'price', 'effect', 'resource'] : ['market', 'price', 'effect', 'resource', 'risk'],
                        semantic: true,
                    });
                }
            }

            if (['risk_signal', 'issue_term'].includes(entityNode.type)) {
                if (businessNode) addEdge(entityNode, businessNode, '风险发生对象', asset, entity.weight, { kind: 'risk_context', views: ['risk'], semantic: true });
                if (providerSide && businessNode) addEdge(businessNode, entityNode, '供应商风险信号', asset, entity.weight, { kind: 'provider_risk', views: ['risk'], semantic: true });
            }

            if (entityNode.type === 'action' && businessNode) {
                addEdge(businessNode, entityNode, providerSide ? '供应商处理动作' : '客户处理动作', asset, entity.weight, {
                    kind: providerSide ? 'provider_action' : 'issue_action',
                    views: providerSide ? ['effect', 'risk', 'fulfillment'] : ['effect', 'risk', 'fulfillment'],
                    semantic: true,
                });
            }
        }

        const countryNodes = entityNodes.filter(node => node.type === 'country');
        const operatorNodes = entityNodes.filter(node => node.type === 'operator');
        for (const country of countryNodes) {
            for (const operator of operatorNodes) {
                addEdge(country, operator, '国家关联运营商', asset, 1, { kind: 'country_operator', views: ['market', 'resource'], semantic: true });
            }
        }

        const issueNodes = entityNodes.filter(node => node.type === 'issue_term' || node.type === 'risk_signal');
        const actionNodes = entityNodes.filter(node => node.type === 'action');
        for (const issueNode of issueNodes) {
            for (const actionNode of actionNodes) {
                addEdge(issueNode, actionNode, '问题触发动作', asset, 1, { kind: 'issue_action', views: ['risk', 'effect'], semantic: true });
            }
        }

        const outcome = outcomeForAsset(asset);
        if (outcome) {
            const outcomeNode = addNode('outcome', outcome, { asset, value_score: valueScore, asset_count: 1, views: ['effect', 'fulfillment'] });
            for (const actionNode of actionNodes) {
                addEdge(actionNode, outcomeNode, '动作产生结果', asset, 1, { kind: 'action_outcome', views: ['effect', 'fulfillment'], semantic: true });
            }
            if (!actionNodes.length && businessNode) {
                addEdge(businessNode, outcomeNode, '供应商履约信号', asset, 1, { kind: 'provider_commitment', views: ['fulfillment', 'risk'], semantic: true });
            }
        }

        const targetLibrary = asset.metrics?.target_library_label || LIBRARY_LABELS[assetLibraryKey(asset)] || '';
        if (targetLibrary) {
            const libraryNode = addNode('library', targetLibrary, { asset, value_score: valueScore, asset_count: 1, views: ['all'] });
            addEdge(typeNode, libraryNode, '资产沉淀去向', asset, 1, { kind: 'asset_library', views: ['all'], semantic: true });
        }

        if (asset.asset_type === 'contact_role' || asset.metrics?.action_playbook?.action_actor) {
            const contactName = contactNodeForAsset(asset);
            if (contactName) {
                const contactNode = addNode('contact', contactName, { asset, value_score: valueScore, asset_count: 1, views: ['fulfillment', 'risk'] });
                const role = asset.metrics?.inferred_role || asset.metrics?.action_actor_role_label || '';
                if (role) {
                    const roleNode = addNode('role', role, { asset, value_score: valueScore, asset_count: 1, views: ['fulfillment', 'risk'] });
                    addEdge(contactNode, roleNode, '联系人角色', asset, 1, { kind: 'contact_role', views: ['fulfillment'], semantic: true });
                }
                if (businessNode) addEdge(contactNode, businessNode, '联系人负责对象', asset, 1, { kind: 'contact_scope', views: ['fulfillment', 'risk'], semantic: true });
                for (const actionNode of actionNodes) {
                    addEdge(contactNode, actionNode, '联系人执行动作', asset, 1, { kind: 'contact_action', views: ['fulfillment', 'effect'], semantic: true });
                }
            }
        }
    }

    const allEdges = Array.from(edges.values());
    let edgeList = allEdges.filter(edge => graphViewAllowsEdge(edge, viewKey));
    let nodeList = Array.from(nodes.values()).filter(node => viewKey === 'all' || node.views?.has(viewKey) || edgeList.some(edge => edge.from === node.id || edge.to === node.id));
    const adjacency = new Map();
    for (const edge of edgeList) {
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
        if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
        adjacency.get(edge.from).add(edge.to);
        adjacency.get(edge.to).add(edge.from);
    }

    const centerOptions = nodeList
        .filter(node => !['asset_type', 'library'].includes(node.type))
        .sort((a, b) => (b.value_score - a.value_score) || (b.weight - a.weight))
        .slice(0, 40)
        .map(node => ({ id: node.id, label: node.label, type: node.type, type_label: node.type_label, weight: node.weight }));

    const visibleNodeIds = new Set(nodeList.map(node => node.id));
    let keep = null;
    if (centerId && visibleNodeIds.has(centerId)) {
        keep = new Set([centerId]);
        let frontier = new Set([centerId]);
        for (let depth = 0; depth < 2; depth += 1) {
            const next = new Set();
            for (const id of frontier) {
                for (const target of adjacency.get(id) || []) {
                    if (!keep.has(target)) next.add(target);
                    keep.add(target);
                }
            }
            frontier = next;
        }
    } else {
        keep = new Set();
        const rankedEdges = edgeList
            .slice()
            .sort((a, b) => Number(b.semantic) - Number(a.semantic) || (b.value_score - a.value_score) || (b.weight - a.weight));
        for (const edge of rankedEdges) {
            if (keep.size >= 64) break;
            const nextSize = keep.size + (keep.has(edge.from) ? 0 : 1) + (keep.has(edge.to) ? 0 : 1);
            if (nextSize > 64 && !keep.has(edge.from) && !keep.has(edge.to)) continue;
            keep.add(edge.from);
            keep.add(edge.to);
        }
        for (const node of nodeList
            .slice()
            .sort((a, b) => {
                const focusBoostA = viewConfig.focus.includes(a.type) ? 1000 : 0;
                const focusBoostB = viewConfig.focus.includes(b.type) ? 1000 : 0;
                return (focusBoostB - focusBoostA) || (b.value_score - a.value_score) || (b.weight - a.weight);
            })) {
            if (keep.size >= 64) break;
            keep.add(node.id);
        }
    }

    nodeList = nodeList.filter(node => keep.has(node.id));
    edgeList = edgeList
        .filter(edge => keep.has(edge.from) && keep.has(edge.to))
        .sort((a, b) => Number(b.semantic) - Number(a.semantic) || (b.value_score - a.value_score) || (b.weight - a.weight))
        .slice(0, 120);

    const finalNodeMap = new Map(nodeList.map(node => [node.id, node]));
    nodeList = nodeList.map(node => {
        const clean = { ...node, views: Array.from(node.views || []) };
        clean.business_brief = nodeBriefFor(clean, edgeList, finalNodeMap);
        return clean;
    });
    const cleanNodeMap = new Map(nodeList.map(node => [node.id, node]));

    const relationCounts = {};
    for (const edge of edgeList) {
        relationCounts[edge.relation] = (relationCounts[edge.relation] || 0) + 1;
    }

    return {
        nodes: nodeList.sort((a, b) => (b.value_score - a.value_score) || (b.weight - a.weight)),
        edges: edgeList,
        center: centerId && cleanNodeMap.has(centerId) ? cleanNodeMap.get(centerId) : null,
        center_options: centerOptions,
        views: Object.values(GRAPH_VIEW_CONFIG),
        active_view: viewConfig,
        summary: {
            asset_count: assets.length,
            node_count: nodeList.length,
            edge_count: edgeList.length,
            semantic_edge_count: edgeList.filter(edge => edge.semantic).length,
            relation_counts: relationCounts,
        },
    };
}

router.get('/analytics/dashboard', (req, res) => {
    const days = Math.max(1, Math.min(30, Number(req.query.days || 7)));
    const adb = getAnalyticsDb();
    const sdb = getSourceDb();
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const last24Ms = Date.now() - 24 * 60 * 60 * 1000;
    const prev24Ms = Date.now() - 48 * 60 * 60 * 1000;
    const accountMap = getAccountRegionMap();

    try {
        const last24Messages = metricValue(sdb, 'SELECT COUNT(*) AS c FROM messages WHERE timestamp >= ?', [last24Ms]);
        const prev24Messages = metricValue(sdb, 'SELECT COUNT(*) AS c FROM messages WHERE timestamp >= ? AND timestamp < ?', [prev24Ms, last24Ms]);
        const activeGroups24h = metricValue(sdb, `
            SELECT COUNT(DISTINCT group_name) AS c
            FROM messages
            WHERE timestamp >= ? AND group_name IS NOT NULL AND group_name != ''
        `, [last24Ms]);
        const activeAccounts24h = metricValue(sdb, `
            SELECT COUNT(DISTINCT receiver_account) AS c
            FROM messages
            WHERE timestamp >= ? AND receiver_account IS NOT NULL AND receiver_account != ''
        `, [last24Ms]);
        const media24h = metricValue(sdb, 'SELECT COUNT(*) AS c FROM messages WHERE timestamp >= ? AND has_media = 1', [last24Ms]);

        const accountVolumeRows = metricRows(sdb, `
            SELECT receiver_account,
                   COUNT(*) AS message_count,
                   COUNT(DISTINCT group_name) AS group_count,
                   SUM(CASE WHEN has_media = 1 THEN 1 ELSE 0 END) AS media_count
            FROM messages
            WHERE timestamp >= ?
              AND receiver_account IS NOT NULL
              AND receiver_account != ''
            GROUP BY receiver_account
            ORDER BY message_count DESC
            LIMIT 30
        `, [sinceMs]);

        const sectorVolumeMap = new Map();
        for (const row of accountVolumeRows) {
            const meta = accountMap.get(row.receiver_account) || {};
            const key = `${meta.region || '未知区'}||${meta.business_sector || '未分类'}`;
            const bucket = sectorVolumeMap.get(key) || {
                region: meta.region || '未知区',
                business_sector: meta.business_sector || '未分类',
                message_count: 0,
                group_count: 0,
                media_count: 0,
                accounts: new Set(),
            };
            bucket.message_count += Number(row.message_count || 0);
            bucket.group_count += Number(row.group_count || 0);
            bucket.media_count += Number(row.media_count || 0);
            bucket.accounts.add(row.receiver_account);
            sectorVolumeMap.set(key, bucket);
        }
        const sectorVolume = Array.from(sectorVolumeMap.values())
            .map(item => ({ ...item, account_count: item.accounts.size, accounts: Array.from(item.accounts).slice(0, 6) }))
            .sort((a, b) => b.message_count - a.message_count)
            .slice(0, 10);

        const alertLevelRows = metricRows(adb, `
            SELECT alert_level, COUNT(*) AS count
            FROM alert_records
            WHERE created_at >= datetime('now', '+8 hours', ?)
            GROUP BY alert_level
        `, [`-${days} days`]);
        const alertLevels = { p0: 0, p1: 0, p2: 0 };
        for (const row of alertLevelRows) {
            const key = String(row.alert_level || '').toLowerCase();
            if (Object.prototype.hasOwnProperty.call(alertLevels, key)) {
                alertLevels[key] = Number(row.count || 0);
            }
        }
        const totalAlerts = alertLevels.p0 + alertLevels.p1 + alertLevels.p2;
        const pushedAlerts = metricValue(adb, `
            SELECT COUNT(*) AS c
            FROM alert_records
            WHERE is_pushed = 1 AND created_at >= datetime('now', '+8 hours', ?)
        `, [`-${days} days`]);
        const unpushedAlerts = Math.max(0, totalAlerts - Number(pushedAlerts || 0));
        const alerts24h = metricValue(adb, `
            SELECT COUNT(*) AS c
            FROM alert_records
            WHERE created_at >= datetime('now', '+8 hours', '-24 hours')
        `);
        const prevAlerts24h = metricValue(adb, `
            SELECT COUNT(*) AS c
            FROM alert_records
            WHERE created_at >= datetime('now', '+8 hours', '-48 hours')
              AND created_at < datetime('now', '+8 hours', '-24 hours')
        `);

        const openIssues = metricValue(adb, "SELECT COUNT(*) AS c FROM issue_records WHERE status = 'open'");
        const escalatedIssues = metricValue(adb, "SELECT COUNT(*) AS c FROM issue_records WHERE status = 'escalated'");
        const closedIssues = metricValue(adb, "SELECT COUNT(*) AS c FROM issue_records WHERE status = 'closed'");
        const totalIssues = openIssues + escalatedIssues + closedIssues;
        const avgResolutionMins = Math.round(Number(metricValue(adb, `
            SELECT AVG(duration_mins) AS c
            FROM issue_records
            WHERE status = 'closed' AND duration_mins IS NOT NULL
        `, [], 0)) || 0);

        const regionHotspots = metricRows(adb, `
            SELECT COALESCE(region, '未知区') AS region,
                   COALESCE(business_sector, '未分类') AS business_sector,
                   COUNT(*) AS alert_count,
                   SUM(CASE WHEN alert_level = 'p0' THEN 1 ELSE 0 END) AS p0_count,
                   SUM(CASE WHEN alert_level = 'p1' THEN 1 ELSE 0 END) AS p1_count,
                   SUM(CASE WHEN alert_level = 'p2' THEN 1 ELSE 0 END) AS p2_count,
                   SUM(CASE WHEN is_pushed = 0 THEN 1 ELSE 0 END) AS unpushed_count,
                   MAX(created_at) AS latest_alert_at
            FROM alert_records
            WHERE created_at >= datetime('now', '+8 hours', ?)
            GROUP BY region, business_sector
            ORDER BY alert_count DESC, p0_count DESC, p1_count DESC
            LIMIT 12
        `, [`-${days} days`]).map(row => ({
            ...row,
            scope: formatRouteScope(row),
            risk_score: Math.min(100, Number(row.p0_count || 0) * 35 + Number(row.p1_count || 0) * 12 + Number(row.p2_count || 0) * 8 + Number(row.unpushed_count || 0) * 6),
        }));

        const issueHotspots = metricRows(adb, `
            SELECT COALESCE(region, '未知区') AS region,
                   COALESCE(business_sector, '未分类') AS business_sector,
                   COUNT(*) AS open_count,
                   SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) AS escalated_count,
                   AVG(duration_mins) AS avg_duration_mins
            FROM issue_records
            WHERE status IN ('open', 'escalated')
            GROUP BY region, business_sector
            ORDER BY escalated_count DESC, open_count DESC
            LIMIT 10
        `).map(row => ({ ...row, scope: formatRouteScope(row) }));

        const responseGaps = metricRows(adb, `
            SELECT id, group_name, region, business_sector, receiver_account,
                   ai_title, ai_action, source_msg_ids, created_at
            FROM alert_records
            WHERE alert_level = 'p2'
              AND created_at >= datetime('now', '+8 hours', ?)
            ORDER BY created_at DESC
            LIMIT 10
        `, [`-${days} days`]).map(row => ({
            ...row,
            source_count: safeJson(row.source_msg_ids, []).length,
        }));

        const recentAlerts = metricRows(adb, `
            SELECT id, alert_level, group_name, region, business_sector, receiver_account,
                   ai_title, ai_type, ai_action, ai_score, is_pushed, created_at
            FROM alert_records
            WHERE created_at >= datetime('now', '+8 hours', ?)
            ORDER BY created_at DESC
            LIMIT 16
        `, [`-${days} days`]);

        const openIssueList = metricRows(adb, `
            SELECT id, group_name, region, business_sector, issue_type, status,
                   recurrence_count, escalation_count, opened_at, commitment_text
            FROM issue_records
            WHERE status IN ('open', 'escalated')
            ORDER BY escalation_count DESC, created_at DESC
            LIMIT 12
        `);

        let knowledge = { ready: false, total_candidates: 0, high_value: 0, pending_review: 0, confirmed: 0, formal_assets: 0, by_type: [], top_candidates: [] };
        if (adb && tableExists(adb, 'knowledge_asset_candidates')) {
            knowledge = {
                ready: true,
                total_candidates: metricValue(adb, 'SELECT COUNT(*) AS c FROM knowledge_asset_candidates'),
                high_value: metricValue(adb, "SELECT COUNT(*) AS c FROM knowledge_asset_candidates WHERE value_level = 'high' OR asset_value_score >= 75"),
                pending_review: metricValue(adb, "SELECT COUNT(*) AS c FROM knowledge_asset_candidates WHERE review_status = 'pending_review'"),
                confirmed: metricValue(adb, "SELECT COUNT(*) AS c FROM knowledge_asset_candidates WHERE review_status = 'confirmed'"),
                formal_assets: tableExists(adb, 'knowledge_assets') ? metricValue(adb, "SELECT COUNT(*) AS c FROM knowledge_assets WHERE status = 'active'") : 0,
                by_type: metricRows(adb, `
                    SELECT asset_type, COUNT(*) AS count, ROUND(AVG(asset_value_score), 1) AS avg_value
                    FROM knowledge_asset_candidates
                    GROUP BY asset_type
                    ORDER BY count DESC
                    LIMIT 8
                `),
                top_candidates: metricRows(adb, `
                    SELECT dedupe_key, asset_type, title, collection_region, business_sector,
                           asset_value_score, confidence, review_status
                    FROM knowledge_asset_candidates
                    ORDER BY asset_value_score DESC, confidence DESC, last_seen_at DESC
                    LIMIT 8
                `).map(mapKnowledgeAsset),
            };
        } else if (adb && tableExists(adb, 'knowledge_assets')) {
            knowledge = {
                ...knowledge,
                ready: true,
                formal_assets: metricValue(adb, "SELECT COUNT(*) AS c FROM knowledge_assets WHERE status = 'active'"),
            };
        }

        const digest = {
            generated: tableExists(adb, 'daily_digests') ? metricValue(adb, `
                SELECT COUNT(*) AS c
                FROM daily_digests
                WHERE created_at >= datetime('now', '+8 hours', ?)
            `, [`-${days} days`]) : 0,
            groups: tableExists(adb, 'daily_digests') ? metricValue(adb, `
                SELECT COUNT(DISTINCT group_name) AS c
                FROM daily_digests
                WHERE created_at >= datetime('now', '+8 hours', ?)
            `, [`-${days} days`]) : 0,
        };

        const reliability = tableExists(adb, 'reliability_snapshots')
            ? {
                assessed_suppliers: metricValue(adb, 'SELECT COUNT(DISTINCT group_name) AS c FROM reliability_snapshots'),
                avg_score: Math.round(Number(metricValue(adb, 'SELECT AVG(reliability_score) AS c FROM reliability_snapshots', [], 0)) || 0),
                risky_suppliers: metricRows(adb, `
                    SELECT group_name, region, business_sector, reliability_score, total_issues, still_open
                    FROM reliability_snapshots
                    ORDER BY reliability_score ASC, still_open DESC
                    LIMIT 8
                `),
            }
            : { assessed_suppliers: 0, avg_score: 0, risky_suppliers: [] };

        const alertTrend = metricRows(adb, `
            SELECT strftime('%m-%d', created_at) AS day,
                   alert_level,
                   COUNT(*) AS count
            FROM alert_records
            WHERE created_at >= datetime('now', '+8 hours', ?)
            GROUP BY day, alert_level
            ORDER BY day ASC
        `, [`-${Math.min(days, 14)} days`]);

        const messageTrend = metricRows(sdb, `
            SELECT strftime('%m-%d', datetime(timestamp / 1000, 'unixepoch', '+8 hours')) AS day,
                   platform,
                   COUNT(*) AS count
            FROM messages
            WHERE timestamp >= ?
            GROUP BY day, platform
            ORDER BY day ASC
        `, [Date.now() - Math.min(days, 14) * 24 * 60 * 60 * 1000]);

        res.json({
            success: true,
            data: {
                ready: !!adb || !!sdb,
                generated_at: new Date().toISOString(),
                scope: { days },
                collection: {
                    messages_24h: last24Messages,
                    previous_messages_24h: prev24Messages,
                    message_growth_pct: growthPct(last24Messages, prev24Messages),
                    active_groups_24h: activeGroups24h,
                    active_accounts_24h: activeAccounts24h,
                    media_24h: media24h,
                    sector_volume: sectorVolume,
                },
                alerts: {
                    total: totalAlerts,
                    last_24h: alerts24h,
                    previous_24h: prevAlerts24h,
                    growth_pct: growthPct(alerts24h, prevAlerts24h),
                    pushed: pushedAlerts,
                    unpushed: unpushedAlerts,
                    push_success_rate: pct(pushedAlerts, totalAlerts),
                    by_level: alertLevels,
                    recent: recentAlerts,
                    trend: alertTrend,
                },
                issues: {
                    open: openIssues,
                    escalated: escalatedIssues,
                    closed: closedIssues,
                    resolve_rate: pct(closedIssues, totalIssues),
                    avg_resolution_mins: avgResolutionMins,
                    hotspots: issueHotspots,
                    open_list: openIssueList,
                },
                response_gaps: responseGaps,
                region_hotspots: regionHotspots,
                knowledge,
                digest,
                reliability,
                message_trend: messageTrend,
            },
        });
    } catch (err) {
        console.error('Analytics dashboard error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/analytics/summary', (req, res) => {
    const adb = getAnalyticsDb();
    if (!adb) {
        return res.json({ success: true, data: { ready: false, totalAlerts: 0, p0: 0, p1: 0, openIssues: 0, closedIssues: 0, alerts: [], issueResolveRate: 0, digestCount: 0, groupsCovered: 0, assessedSuppliers: 0 } });
    }
    try {
        const p0 = adb.prepare("SELECT COUNT(*) AS c FROM alert_records WHERE alert_level='p0'").get()?.c || 0;
        const p1 = adb.prepare("SELECT COUNT(*) AS c FROM alert_records WHERE alert_level='p1'").get()?.c || 0;
        const openIssues = adb.prepare("SELECT COUNT(*) AS c FROM issue_records WHERE status='open'").get()?.c || 0;
        const closedIssues = adb.prepare("SELECT COUNT(*) AS c FROM issue_records WHERE status='closed'").get()?.c || 0;
        const totalIssues = openIssues + closedIssues;
        const issueResolveRate = totalIssues > 0 ? Math.round((closedIssues / totalIssues) * 100) : 0;

        let digestCount = 0;
        try {
            digestCount = adb.prepare("SELECT COUNT(*) AS c FROM daily_digests").get()?.c || 0;
        } catch (e) {
            // Table doesn't exist, keep as 0
        }

        let groupsCovered = 0;
        try {
            const sdb = getSourceDb();
            if (sdb) {
                groupsCovered = sdb.prepare("SELECT COUNT(DISTINCT group_name) AS c FROM messages WHERE group_name IS NOT NULL AND group_name != ''").get()?.c || 0;
            }
        } catch (e) {
            // Table doesn't exist, keep as 0
        }

        let assessedSuppliers = 0;
        try {
            assessedSuppliers = adb.prepare("SELECT COUNT(DISTINCT business_sector) AS c FROM supplier_profiles").get()?.c || 0;
        } catch (e) {
            // Table doesn't exist, keep as 0
        }

        const alerts = [];
        if (p0 > 0) {
            alerts.push({ level: 'P0', count: p0, platforms: 'WhatsApp, Telegram' });
        }
        if (p1 > 0) {
            alerts.push({ level: 'P1', count: p1, platforms: 'WhatsApp, Telegram, Teams' });
        }

        res.json({
            success: true,
            data: {
                ready: true,
                totalAlerts: p0 + p1,
                p0,
                p1,
                openIssues,
                closedIssues,
                alerts,
                issueResolveRate,
                digestCount,
                groupsCovered,
                assessedSuppliers
            }
        });
    } catch (err) {
        console.error('Analytics summary error:', err);
        res.json({ success: true, data: { ready: false, totalAlerts: 0, p0: 0, p1: 0, openIssues: 0, closedIssues: 0, alerts: [], issueResolveRate: 0, digestCount: 0, groupsCovered: 0, assessedSuppliers: 0 } });
    }
});

router.get('/status', (req, res) => {
    res.json({ success: true, running: true });
});

// ─── 统一知识资产候选池 ───────────────────────────────────────────
router.get('/knowledge-assets/summary', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_asset_candidates')) {
            return res.json({ success: true, data: { ready: false, total: 0, byType: [], byStatus: [], top: [] } });
        }

        const total = adb.prepare('SELECT COUNT(*) AS c FROM knowledge_asset_candidates').get()?.c || 0;
        const highValue = adb.prepare("SELECT COUNT(*) AS c FROM knowledge_asset_candidates WHERE value_level = 'high' OR asset_value_score >= 75").get()?.c || 0;
        const pending = adb.prepare("SELECT COUNT(*) AS c FROM knowledge_asset_candidates WHERE review_status = 'pending_review'").get()?.c || 0;
        const confirmed = adb.prepare("SELECT COUNT(*) AS c FROM knowledge_asset_candidates WHERE review_status = 'confirmed'").get()?.c || 0;
        const manualPending = adb.prepare(`
            SELECT COUNT(*) AS c
            FROM knowledge_asset_candidates
            WHERE review_status = 'pending_review'
              AND json_extract(metrics, '$.machine_assessment.manual_review_required') = 1
        `).get()?.c || 0;
        const machineHandled = adb.prepare(`
            SELECT COUNT(*) AS c
            FROM knowledge_asset_candidates
            WHERE COALESCE(json_extract(metrics, '$.machine_assessment.manual_review_required'), 0) = 0
        `).get()?.c || 0;
        const byType = adb.prepare(`
            SELECT asset_type, COUNT(*) AS count, ROUND(AVG(asset_value_score), 1) AS avg_value, ROUND(AVG(confidence), 2) AS avg_confidence
            FROM knowledge_asset_candidates
            GROUP BY asset_type
            ORDER BY count DESC
        `).all();
        const byStatus = adb.prepare(`
            SELECT review_status, COUNT(*) AS count
            FROM knowledge_asset_candidates
            GROUP BY review_status
            ORDER BY count DESC
        `).all();
        const bySector = adb.prepare(`
            SELECT business_sector, COUNT(*) AS count, ROUND(AVG(asset_value_score), 1) AS avg_value
            FROM knowledge_asset_candidates
            WHERE business_sector IS NOT NULL AND business_sector != ''
            GROUP BY business_sector
            ORDER BY count DESC
        `).all();
        const byInteraction = adb.prepare(`
            SELECT json_extract(metrics, '$.machine_assessment.interaction_side') AS interaction_side,
                   json_extract(metrics, '$.machine_assessment.interaction_label') AS interaction_label,
                   COUNT(*) AS count,
                   SUM(CASE WHEN json_extract(metrics, '$.machine_assessment.manual_review_required') = 1 THEN 1 ELSE 0 END) AS needs_review
            FROM knowledge_asset_candidates
            GROUP BY interaction_side, interaction_label
            ORDER BY count DESC
        `).all();
        const byMachineDecision = adb.prepare(`
            SELECT json_extract(metrics, '$.machine_assessment.decision') AS decision,
                   json_extract(metrics, '$.machine_assessment.label') AS label,
                   COUNT(*) AS count
            FROM knowledge_asset_candidates
            GROUP BY decision, label
            ORDER BY count DESC
        `).all();
        const top = adb.prepare(`
            SELECT *
            FROM knowledge_asset_candidates
            WHERE review_status = 'pending_review'
              AND json_extract(metrics, '$.machine_assessment.manual_review_required') = 1
            ORDER BY asset_value_score DESC, confidence DESC, last_seen_at DESC
            LIMIT 12
        `).all().map(mapKnowledgeAsset);

        res.json({ success: true, data: { ready: true, total, highValue, pending, confirmed, manualPending, machineHandled, byType, byStatus, bySector, byInteraction, byMachineDecision, top } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/intelligence/regions', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_asset_candidates')) {
            return res.json({ success: true, data: [] });
        }

        const { region, sector, days } = req.query;
        const dayNum = Math.min(90, Math.max(1, parseInt(days) || 30));
        const since = Date.now() - dayNum * 24 * 3600 * 1000;
        const where = ['COALESCE(last_seen_at, first_seen_at, 0) >= ?'];
        const params = [since];
        if (region) { where.push('collection_region = ?'); params.push(region); }
        if (sector) { where.push('business_sector = ?'); params.push(sector); }

        const rows = adb.prepare(`
            SELECT collection_region, business_sector,
                   COUNT(*) AS total,
                   SUM(CASE WHEN value_level = 'high' OR asset_value_score >= 75 THEN 1 ELSE 0 END) AS high_value,
                   SUM(CASE WHEN asset_type = 'risk_pattern' THEN 1 ELSE 0 END) AS risk_count,
                   SUM(CASE WHEN asset_type = 'operation_action' THEN 1 ELSE 0 END) AS action_count,
                   SUM(CASE WHEN asset_type = 'sla_commitment' THEN 1 ELSE 0 END) AS commitment_count,
                   SUM(CASE WHEN asset_type = 'media_evidence' THEN 1 ELSE 0 END) AS media_count,
                   SUM(CASE WHEN business_region IS NOT NULL AND collection_region IS NOT NULL AND business_region != collection_region THEN 1 ELSE 0 END) AS cross_region_count,
                   ROUND(AVG(asset_value_score), 1) AS avg_value,
                   ROUND(AVG(confidence), 2) AS avg_confidence,
                   MAX(last_seen_at) AS last_seen_at
            FROM knowledge_asset_candidates
            WHERE ${where.join(' AND ')}
            GROUP BY collection_region, business_sector
            ORDER BY high_value DESC, avg_value DESC, total DESC
            LIMIT 60
        `).all(...params);

        const topStmt = adb.prepare(`
            SELECT asset_type, COUNT(*) AS count, ROUND(AVG(asset_value_score), 1) AS avg_value
            FROM knowledge_asset_candidates
            WHERE collection_region = ?
              AND business_sector = ?
              AND asset_type != 'regional_intelligence'
              AND COALESCE(last_seen_at, first_seen_at, 0) >= ?
            GROUP BY asset_type
            ORDER BY count DESC
            LIMIT 4
        `);

        res.json({
            success: true,
            data: rows.map(row => ({
                ...row,
                top_types: topStmt.all(row.collection_region, row.business_sector, since),
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/intelligence/region-dashboard', async (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || (!tableExists(adb, 'knowledge_asset_candidates') && !tableExists(adb, 'knowledge_assets'))) {
            return res.json({ success: true, data: { total: 0, view_scope: intelligenceScopeMeta(req.query.scope), matrix: [], regions: [], sectors: [], top_entities: [], top_actions: [], top_risks: [], top_assets: [] } });
        }

        const { region, sector, days } = req.query;
        const scope = normalizeIntelligenceScope(req.query.scope);
        const assets = loadKnowledgeAssetPool(adb, { region, sector, days, scope });
        const messageIntel = loadRegionalBusinessSignals({ region, sector, days, scope });
        const dashboard = summarizeRegionDashboard(assets, messageIntel, { scope });
        dashboard.days = Math.min(365, Math.max(1, parseInt(days) || 30));
        const data = await enrichRegionDashboardWithAi(dashboard, {
            enableAi: req.query.ai !== '0',
            focusKey: req.query.focusKey,
        });
        res.json({
            success: true,
            data,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/intelligence/domain-dashboard', async (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || (!tableExists(adb, 'knowledge_asset_candidates') && !tableExists(adb, 'knowledge_assets'))) {
            return res.json({ success: true, data: { profile: domainProfileFor(req.query.kind), summary: {}, cards: [], priority_actions: [], top_assets: [] } });
        }
        const profile = domainProfileFor(req.query.kind);
        const dashboard = buildDomainIntelligenceDashboard(adb, profile.key, { days: req.query.days });
        const data = await enrichDomainDashboardWithAi(profile, dashboard, { enableAi: req.query.ai !== '0' });

        res.json({
            success: true,
            data,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/entity-graph', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || (!tableExists(adb, 'knowledge_asset_candidates') && !tableExists(adb, 'knowledge_assets'))) {
            return res.json({ success: true, data: { nodes: [], edges: [], center_options: [], summary: { asset_count: 0, node_count: 0, edge_count: 0 } } });
        }

        const { region, sector, type, center, days, view } = req.query;
        const assets = loadKnowledgeAssetPool(adb, { region, sector, type, days });
        res.json({
            success: true,
            data: buildEntityGraph(assets, String(center || '').trim(), view),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/facets', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_asset_candidates')) {
            return res.json({ success: true, data: { types: [], sectors: [], regions: [], statuses: [], valueLevels: [] } });
        }

        const pick = (sql, col) => adb.prepare(sql).all().map(r => r[col]).filter(Boolean);
        res.json({
            success: true,
            data: {
                types: pick('SELECT DISTINCT asset_type FROM knowledge_asset_candidates ORDER BY asset_type', 'asset_type'),
                sectors: pick('SELECT DISTINCT business_sector FROM knowledge_asset_candidates ORDER BY business_sector', 'business_sector'),
                regions: pick('SELECT DISTINCT collection_region FROM knowledge_asset_candidates ORDER BY collection_region', 'collection_region'),
                statuses: pick('SELECT DISTINCT review_status FROM knowledge_asset_candidates ORDER BY review_status', 'review_status'),
                valueLevels: pick('SELECT DISTINCT value_level FROM knowledge_asset_candidates ORDER BY value_level', 'value_level'),
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_asset_candidates')) {
            return res.json({ success: true, data: [], total: 0, page: 1, limit: 20 });
        }

        const { keyword, type, sector, region, status, valueLevel, minValue, effective, interaction, machineDecision, manualReview, page, limit, sort } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;
        const where = ['1=1'];
        const params = [];

        if (keyword) {
            where.push('(title LIKE ? OR description LIKE ? OR group_name LIKE ? OR evidence LIKE ? OR metrics LIKE ?)');
            const kw = `%${keyword}%`;
            params.push(kw, kw, kw, kw, kw);
        }
        if (type) { where.push('asset_type = ?'); params.push(type); }
        if (sector) { where.push('business_sector = ?'); params.push(sector); }
        if (region) { where.push('collection_region = ?'); params.push(region); }
        if (status) { where.push('review_status = ?'); params.push(status); }
        if (interaction) { where.push("json_extract(metrics, '$.machine_assessment.interaction_side') = ?"); params.push(interaction); }
        if (machineDecision) { where.push("json_extract(metrics, '$.machine_assessment.decision') = ?"); params.push(machineDecision); }
        if (manualReview === '1') where.push("json_extract(metrics, '$.machine_assessment.manual_review_required') = 1");
        if (manualReview === '0') where.push("COALESCE(json_extract(metrics, '$.machine_assessment.manual_review_required'), 0) = 0");
        if (valueLevel) { where.push('value_level = ?'); params.push(valueLevel); }
        if (effective === '1') {
            where.push("asset_type = 'operation_action' AND metrics LIKE '%\"effectiveness_signal\":true%'");
        } else if (effective === '0') {
            where.push("asset_type = 'operation_action' AND metrics LIKE '%\"effect_checked\":true%' AND metrics NOT LIKE '%\"effectiveness_signal\":true%'");
        } else if (effective === 'checked') {
            where.push("asset_type = 'operation_action' AND metrics LIKE '%\"effect_checked\":true%'");
        }
        const minValueNum = Number(minValue);
        if (Number.isFinite(minValueNum) && minValueNum > 0) {
            where.push('asset_value_score >= ?');
            params.push(minValueNum);
        }

        const whereSql = where.join(' AND ');
        const total = adb.prepare(`SELECT COUNT(*) AS c FROM knowledge_asset_candidates WHERE ${whereSql}`).get(...params)?.c || 0;
        const orderMap = {
            value: 'asset_value_score DESC, confidence DESC, last_seen_at DESC',
            confidence: 'confidence DESC, asset_value_score DESC, last_seen_at DESC',
            recent: 'last_seen_at DESC, asset_value_score DESC',
            frequency: 'frequency DESC, asset_value_score DESC',
        };
        const orderBy = orderMap[sort] || orderMap.value;
        const rows = adb.prepare(`
            SELECT *
            FROM knowledge_asset_candidates
            WHERE ${whereSql}
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `).all(...params, limitNum, offset).map(mapKnowledgeAsset);

        res.json({ success: true, data: rows, total, page: pageNum, limit: limitNum });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/export', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_asset_candidates')) {
            return res.status(404).json({ success: false, error: '知识资产候选池未初始化' });
        }

        const rows = adb.prepare(`
            SELECT dedupe_key, asset_type, title, description, collection_region, business_region,
                   business_sector, value_label, group_name, source_msg_ids, evidence, metrics,
                   confidence, asset_value_score, value_level, value_reasons, review_status,
                   frequency, first_seen_at, last_seen_at
            FROM knowledge_asset_candidates
            ORDER BY asset_value_score DESC, confidence DESC, last_seen_at DESC
            LIMIT 5000
        `).all().map(mapKnowledgeAsset);
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="knowledge-assets-${stamp}.json"`);
        return res.json({ exported_at: new Date().toISOString(), total: rows.length, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/formal/summary', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_assets')) {
            return res.json({ success: true, data: { ready: false, total: 0, active: 0, byType: [], top: [] } });
        }

        const total = adb.prepare('SELECT COUNT(*) AS c FROM knowledge_assets').get()?.c || 0;
        const active = adb.prepare("SELECT COUNT(*) AS c FROM knowledge_assets WHERE status = 'active'").get()?.c || 0;
        const byType = adb.prepare(`
            SELECT asset_type, COUNT(*) AS count, ROUND(AVG(asset_value_score), 1) AS avg_value, ROUND(AVG(quality_score), 1) AS avg_quality
            FROM knowledge_assets
            GROUP BY asset_type
            ORDER BY count DESC
        `).all();
        const bySector = adb.prepare(`
            SELECT business_sector, collection_region, COUNT(*) AS count, ROUND(AVG(asset_value_score), 1) AS avg_value
            FROM knowledge_assets
            GROUP BY business_sector, collection_region
            ORDER BY count DESC
            LIMIT 20
        `).all();
        const top = adb.prepare(`
            SELECT *
            FROM knowledge_assets
            ORDER BY asset_value_score DESC, quality_score DESC, last_seen_at DESC
            LIMIT 12
        `).all().map(mapFormalKnowledgeAsset);

        res.json({ success: true, data: { ready: true, total, active, byType, bySector, top } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/formal', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_assets')) {
            return res.json({ success: true, data: [], total: 0, page: 1, limit: 20 });
        }

        const { keyword, type, sector, region, status, groupName, page, limit, sort } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;
        const where = ['1=1'];
        const params = [];

        if (keyword) {
            where.push('(title LIKE ? OR summary LIKE ? OR group_name LIKE ? OR evidence LIKE ? OR tags LIKE ?)');
            const kw = `%${keyword}%`;
            params.push(kw, kw, kw, kw, kw);
        }
        if (type) { where.push('asset_type = ?'); params.push(type); }
        if (sector) { where.push('business_sector = ?'); params.push(sector); }
        if (region) { where.push('collection_region = ?'); params.push(region); }
        if (status) { where.push('status = ?'); params.push(status); }
        if (groupName) { where.push('group_name = ?'); params.push(groupName); }

        const whereSql = where.join(' AND ');
        const total = adb.prepare(`SELECT COUNT(*) AS c FROM knowledge_assets WHERE ${whereSql}`).get(...params)?.c || 0;
        const orderMap = {
            value: 'asset_value_score DESC, quality_score DESC, last_seen_at DESC',
            quality: 'quality_score DESC, asset_value_score DESC, last_seen_at DESC',
            recent: 'last_seen_at DESC, asset_value_score DESC',
            usage: 'usage_count DESC, asset_value_score DESC',
        };
        const rows = adb.prepare(`
            SELECT *
            FROM knowledge_assets
            WHERE ${whereSql}
            ORDER BY ${orderMap[sort] || orderMap.value}
            LIMIT ? OFFSET ?
        `).all(...params, limitNum, offset).map(mapFormalKnowledgeAsset);

        res.json({ success: true, data: rows, total, page: pageNum, limit: limitNum });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/formal/library/:library', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_assets')) {
            return res.json({ success: true, data: [], total: 0, library: req.params.library, label: LIBRARY_LABELS[req.params.library] || req.params.library });
        }

        const library = String(req.params.library || '').trim();
        const allowed = new Set(Object.keys(LIBRARY_LABELS));
        if (!allowed.has(library)) {
            return res.status(400).json({ success: false, error: '未知知识库分类' });
        }

        const { keyword, sector, region, limit } = req.query;
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 12));
        const where = ["status = 'active'"];
        const params = [];
        if (sector) { where.push('business_sector = ?'); params.push(sector); }
        if (region) { where.push('collection_region = ?'); params.push(region); }
        if (keyword) {
            where.push('(title LIKE ? OR summary LIKE ? OR group_name LIKE ? OR evidence LIKE ? OR tags LIKE ?)');
            const kw = `%${keyword}%`;
            params.push(kw, kw, kw, kw, kw);
        }

        const rows = adb.prepare(`
            SELECT *
            FROM knowledge_assets
            WHERE ${where.join(' AND ')}
            ORDER BY asset_value_score DESC, quality_score DESC, last_seen_at DESC
            LIMIT 2000
        `).all(...params).map(mapFormalKnowledgeAsset);

        const filtered = rows.filter(asset => asset.target_library === library);
        const byType = {};
        for (const asset of filtered) byType[asset.asset_type] = (byType[asset.asset_type] || 0) + 1;

        res.json({
            success: true,
            library,
            label: LIBRARY_LABELS[library],
            total: filtered.length,
            byType: Object.entries(byType).map(([asset_type, count]) => ({ asset_type, count })).sort((a, b) => b.count - a.count),
            data: filtered.slice(0, limitNum),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-assets/formal/:assetUid', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_assets')) {
            return res.status(404).json({ success: false, error: '正式知识资产库未初始化' });
        }
        const row = adb.prepare('SELECT * FROM knowledge_assets WHERE asset_uid = ?').get(req.params.assetUid);
        if (!row) return res.status(404).json({ success: false, error: '正式资产不存在' });
        const links = tableExists(adb, 'knowledge_asset_links')
            ? adb.prepare('SELECT * FROM knowledge_asset_links WHERE asset_uid = ? ORDER BY created_at DESC').all(req.params.assetUid)
            : [];
        res.json({ success: true, data: { ...mapFormalKnowledgeAsset(row), links } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/knowledge-assets/formal/:assetUid/usage', (req, res) => {
    let db = null;
    try {
        db = openWritableAnalyticsDb();
        if (!db || !tableExists(db, 'knowledge_assets') || !tableExists(db, 'knowledge_asset_usage_log')) {
            return res.status(404).json({ success: false, error: '正式知识资产库未初始化' });
        }
        const row = db.prepare('SELECT asset_uid FROM knowledge_assets WHERE asset_uid = ?').get(req.params.assetUid);
        if (!row) return res.status(404).json({ success: false, error: '正式资产不存在' });

        const usedIn = String(req.body?.used_in || 'manual').slice(0, 80);
        const refId = String(req.body?.ref_id || '').slice(0, 120);
        const feedback = String(req.body?.feedback || '').slice(0, 40);
        const note = String(req.body?.note || '').slice(0, 500);
        const actor = req.user?.username || req.user?.id || 'unknown';
        db.prepare(`
            INSERT INTO knowledge_asset_usage_log (asset_uid, used_in, ref_id, feedback, note, used_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(req.params.assetUid, usedIn, refId, feedback, note, actor);
        db.prepare(`
            UPDATE knowledge_assets
            SET usage_count = COALESCE(usage_count, 0) + 1,
                last_used_at = datetime('now', '+8 hours'),
                updated_at = datetime('now', '+8 hours')
            WHERE asset_uid = ?
        `).run(req.params.assetUid);
        const updated = db.prepare('SELECT * FROM knowledge_assets WHERE asset_uid = ?').get(req.params.assetUid);
        res.json({ success: true, data: mapFormalKnowledgeAsset(updated) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (db) {
            try { db.close(); } catch (_) {}
        }
    }
});

router.post('/knowledge-assets/:dedupeKey/promote', (req, res) => {
    let db = null;
    try {
        db = openWritableAnalyticsDb();
        if (!db || !tableExists(db, 'knowledge_asset_candidates') || !tableExists(db, 'knowledge_assets')) {
            return res.status(404).json({ success: false, error: '知识资产库未初始化' });
        }
        const row = db.prepare('SELECT * FROM knowledge_asset_candidates WHERE dedupe_key = ?').get(req.params.dedupeKey);
        if (!row) return res.status(404).json({ success: false, error: '候选资产不存在' });
        const actor = req.user?.username || req.user?.id || 'unknown';
        const result = promoteCandidateToAsset(db, mapKnowledgeAsset(row), actor);
        res.json({ success: true, data: result.asset, action: result.action });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (db) {
            try { db.close(); } catch (_) {}
        }
    }
});

router.get('/knowledge-assets/:dedupeKey/sources', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        const sdb = getSourceDb();
        if (!adb || !sdb || !tableExists(adb, 'knowledge_asset_candidates')) {
            return res.json({ success: true, data: [] });
        }
        const row = adb.prepare('SELECT source_msg_ids FROM knowledge_asset_candidates WHERE dedupe_key = ?').get(req.params.dedupeKey);
        const ids = safeJson(row?.source_msg_ids, []).map(Number).filter(Number.isFinite).slice(0, 30);
        if (!ids.length) return res.json({ success: true, data: [] });

        const placeholders = ids.map(() => '?').join(',');
        const messages = sdb.prepare(`
            SELECT id, platform, receiver_account, group_name, sender_name, content,
                   has_media, media_path, timestamp
            FROM messages
            WHERE id IN (${placeholders})
            ORDER BY timestamp ASC, id ASC
        `).all(...ids).map(msg => ({
            ...msg,
            content_excerpt: redactMessageText(msg.content),
            content: undefined,
        }));
        res.json({ success: true, data: messages });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.patch('/knowledge-assets/:dedupeKey/contact-side', (req, res) => {
    const side = String(req.body?.side || '').trim();
    if (!['internal', 'external'].includes(side)) {
        return res.status(400).json({ success: false, error: 'side 只能是 internal 或 external' });
    }

    let db = null;
    try {
        db = openWritableAnalyticsDb();
        if (!db || !tableExists(db, 'knowledge_asset_candidates')) {
            return res.status(404).json({ success: false, error: '知识资产候选池未初始化' });
        }
        const row = db.prepare('SELECT * FROM knowledge_asset_candidates WHERE dedupe_key = ?').get(req.params.dedupeKey);
        if (!row) return res.status(404).json({ success: false, error: '资产不存在' });
        const asset = mapKnowledgeAsset(row);
        if (asset.asset_type !== 'contact_role') {
            return res.status(400).json({ success: false, error: '只有联系人角色资产支持身份打标' });
        }
        const contactName = contactNameFromAsset(asset);
        if (!contactName) return res.status(400).json({ success: false, error: '无法识别联系人名称' });

        const staffConfig = readStaffConfig();
        if (side === 'internal') {
            staffConfig.whitelist = Array.from(new Set([...(staffConfig.whitelist || []), contactName]));
            staffConfig.external_contacts = (staffConfig.external_contacts || []).filter(item => item !== contactName);
        } else {
            staffConfig.external_contacts = Array.from(new Set([...(staffConfig.external_contacts || []), contactName]));
        }
        writeStaffConfig(staffConfig);

        const actor = req.user?.username || req.user?.id || 'unknown';
        const allContactRows = db.prepare("SELECT * FROM knowledge_asset_candidates WHERE asset_type = 'contact_role'").all();
        const matchingRows = allContactRows.filter(item => contactNameFromAsset(mapKnowledgeAsset(item)) === contactName);
        const stmt = db.prepare(`
            UPDATE knowledge_asset_candidates
            SET title = ?,
                description = ?,
                metrics = ?,
                related_entities = ?,
                validation_status = 'identity_labeled',
                review_note = ?,
                reviewed_by = ?,
                reviewed_at = datetime('now', '+8 hours'),
                updated_at = datetime('now', '+8 hours')
            WHERE dedupe_key = ?
        `);
        const tx = db.transaction((items) => {
            let changed = 0;
            for (const item of items) {
                const mapped = mapKnowledgeAsset(item);
                const tagged = retagContactAsset(mapped, side, actor);
                changed += stmt.run(
                    tagged.title,
                    tagged.description,
                    JSON.stringify(tagged.metrics || {}),
                    JSON.stringify(tagged.related_entities || []),
                    side === 'internal' ? '已标记为我方人员' : '已标记为外部联系人',
                    actor,
                    item.dedupe_key
                ).changes;
            }
            return changed;
        });
        const updated = tx(matchingRows.length ? matchingRows : [row]);
        let syncedAssets = 0;
        const refreshedRows = db.prepare(`
            SELECT *
            FROM knowledge_asset_candidates
            WHERE asset_type = 'contact_role'
              AND dedupe_key IN (${(matchingRows.length ? matchingRows : [row]).map(() => '?').join(',')})
        `).all(...(matchingRows.length ? matchingRows : [row]).map(item => item.dedupe_key));
        const linkedStmt = db.prepare('SELECT asset_uid FROM knowledge_asset_links WHERE candidate_key = ? LIMIT 1');
        for (const item of refreshedRows) {
            if (!linkedStmt.get(item.dedupe_key)) continue;
            promoteCandidateToAsset(db, mapKnowledgeAsset(item), actor);
            syncedAssets += 1;
        }
        const refreshed = db.prepare('SELECT * FROM knowledge_asset_candidates WHERE dedupe_key = ?').get(req.params.dedupeKey);
        res.json({
            success: true,
            updated,
            synced_assets: syncedAssets,
            contact_name: contactName,
            side,
            data: mapKnowledgeAsset(refreshed),
            staff: staffConfig,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (db) {
            try { db.close(); } catch (_) {}
        }
    }
});

router.patch('/knowledge-assets/review-batch', (req, res) => {
    const allowed = new Set(['pending_review', 'confirmed', 'rejected', 'merged']);
    const status = String(req.body?.status || '').trim();
    const keys = Array.isArray(req.body?.dedupeKeys)
        ? req.body.dedupeKeys.map(k => String(k || '').trim()).filter(Boolean)
        : [];
    if (!allowed.has(status)) return res.status(400).json({ success: false, error: 'review_status 无效' });
    if (keys.length === 0) return res.status(400).json({ success: false, error: '缺少 dedupeKeys' });
    if (keys.length > 100) return res.status(400).json({ success: false, error: '单次最多审核 100 条' });

    let db = null;
    try {
        db = openWritableAnalyticsDb();
        if (!db || !tableExists(db, 'knowledge_asset_candidates')) {
            return res.status(404).json({ success: false, error: '知识资产候选池未初始化' });
        }

        const stmt = db.prepare(`
            UPDATE knowledge_asset_candidates
            SET review_status = ?,
                review_note = ?,
                reviewed_by = ?,
                reviewed_at = datetime('now', '+8 hours'),
                updated_at = datetime('now', '+8 hours')
            WHERE dedupe_key = ?
        `);
        const reviewer = req.user?.username || req.user?.id || 'unknown';
        const note = String(req.body?.note || '').slice(0, 500);
        const tx = db.transaction((items) => {
            let changed = 0;
            for (const key of items) changed += stmt.run(status, note, reviewer, key).changes;
            return changed;
        });
        const changed = tx(keys);
        let promoted = 0;
        const promotedAssets = [];
        if (status === 'confirmed' && changed > 0) {
            const placeholders = keys.map(() => '?').join(',');
            const rows = db.prepare(`
                SELECT *
                FROM knowledge_asset_candidates
                WHERE dedupe_key IN (${placeholders})
            `).all(...keys);
            for (const row of rows) {
                const result = promoteCandidateToAsset(db, mapKnowledgeAsset(row), reviewer);
                promoted += 1;
                promotedAssets.push({ asset_uid: result.asset.asset_uid, action: result.action });
            }
        }
        res.json({ success: true, updated: changed, promoted, promotedAssets });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (db) {
            try { db.close(); } catch (_) {}
        }
    }
});

router.get('/knowledge-assets/:dedupeKey', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb || !tableExists(adb, 'knowledge_asset_candidates')) {
            return res.status(404).json({ success: false, error: '知识资产候选池未初始化' });
        }
        const row = adb.prepare('SELECT * FROM knowledge_asset_candidates WHERE dedupe_key = ?').get(req.params.dedupeKey);
        if (!row) return res.status(404).json({ success: false, error: '资产不存在' });
        res.json({ success: true, data: mapKnowledgeAsset(row) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.patch('/knowledge-assets/:dedupeKey/review', (req, res) => {
    const allowed = new Set(['pending_review', 'confirmed', 'rejected', 'merged']);
    const status = String(req.body?.status || '').trim();
    if (!allowed.has(status)) return res.status(400).json({ success: false, error: 'review_status 无效' });

    let db = null;
    try {
        db = openWritableAnalyticsDb();
        if (!db || !tableExists(db, 'knowledge_asset_candidates')) {
            return res.status(404).json({ success: false, error: '知识资产候选池未初始化' });
        }
        const info = db.prepare(`
            UPDATE knowledge_asset_candidates
            SET review_status = ?,
                review_note = ?,
                reviewed_by = ?,
                reviewed_at = datetime('now', '+8 hours'),
                updated_at = datetime('now', '+8 hours')
            WHERE dedupe_key = ?
        `).run(status, String(req.body?.note || '').slice(0, 500), req.user?.username || req.user?.id || 'unknown', req.params.dedupeKey);
        if (info.changes === 0) return res.status(404).json({ success: false, error: '资产不存在' });
        const row = db.prepare('SELECT * FROM knowledge_asset_candidates WHERE dedupe_key = ?').get(req.params.dedupeKey);
        let linkedAsset = null;
        let promoteAction = null;
        if (status === 'confirmed' && row) {
            const result = promoteCandidateToAsset(db, mapKnowledgeAsset(row), req.user?.username || req.user?.id || 'unknown');
            linkedAsset = result.asset;
            promoteAction = result.action;
        }
        res.json({ success: true, data: mapKnowledgeAsset(row), linkedAsset, promoteAction });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (db) {
            try { db.close(); } catch (_) {}
        }
    }
});

router.get('/knowledge-base', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [], total: 0 });

        const { keyword, sector, page, limit } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const kw = keyword ? String(keyword).toLowerCase() : '';
        const rows = qaRowsWithFormalAssets(adb)
            .filter(r => !sector || r.business_sector === sector)
            .filter(r => !kw || [r.question_summary, r.question_type, r.answer_pattern, ...(r.question_keywords || [])].join(' ').toLowerCase().includes(kw));
        const total = rows.length;

        res.json({
            success: true,
            data: rows.slice(offset, offset + limitNum),
            total,
            page: pageNum,
            limit: limitNum,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── QA 知识库导出（支持 json / jsonl / csv）────────────────────
router.get('/knowledge-base/export', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.status(503).json({ success: false, error: '数据库不可用' });

        const fmt = (req.query.format || 'json').toLowerCase();
        const rows = qaRowsWithFormalAssets(adb);

        const timestamp = new Date().toISOString().slice(0, 10);

        if (fmt === 'jsonl') {
            // JSONL: 每行一条 {instruction, output} — RAG / fine-tune 直接可用
            res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="qa-kb-${timestamp}.jsonl"`);
            for (const r of rows) {
                const steps = Array.isArray(r.answer_steps)
                    ? r.answer_steps
                    : (r.answer_pattern || '').split('\n').filter(Boolean);
                const keywords = Array.isArray(r.question_keywords)
                    ? r.question_keywords
                    : (r.question_keywords || '').split(/[,，]/).map(k => k.trim()).filter(Boolean);
                const line = {
                    instruction: r.question_summary || '',
                    input: keywords.join(', '),
                    output: steps.join('\n'),
                    metadata: {
                        id: r.id,
                        source_type: r.source_type,
                        source_asset_uid: r.source_asset_uid,
                        sector: r.business_sector,
                        confidence: r.confidence,
                        frequency: r.frequency,
                        question_type: r.question_type,
                        created_at: r.created_at,
                    }
                };
                res.write(JSON.stringify(line) + '\n');
            }
            return res.end();
        }

        if (fmt === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="qa-kb-${timestamp}.csv"`);
            const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const headers = ['id','source_type','source_asset_uid','question_summary','question_keywords','question_type','answer_pattern','confidence','frequency','business_sector','created_at'];
            res.write('\uFEFF'); // BOM for Excel
            res.write(headers.join(',') + '\n');
            for (const r of rows) {
                const row = {
                    ...r,
                    question_keywords: Array.isArray(r.question_keywords) ? r.question_keywords.join(',') : r.question_keywords,
                    answer_pattern: r.answer_pattern || (Array.isArray(r.answer_steps) ? r.answer_steps.join('\n') : ''),
                };
                res.write(headers.map(h => escape(row[h])).join(',') + '\n');
            }
            return res.end();
        }

        // 默认 JSON
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="qa-kb-${timestamp}.json"`);
        const data = rows.map(r => ({
            ...r,
            answer_steps: Array.isArray(r.answer_steps) ? r.answer_steps : (r.answer_pattern || '').split('\n').filter(Boolean),
            question_keywords: Array.isArray(r.question_keywords) ? r.question_keywords : (r.question_keywords || '').split(/[,，]/).map(k => k.trim()).filter(Boolean),
        }));
        return res.json({ exported_at: new Date().toISOString(), total: data.length, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/knowledge-base/sectors', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const rows = adb.prepare(
            'SELECT DISTINCT business_sector FROM qa_knowledge_base WHERE business_sector IS NOT NULL ORDER BY business_sector'
        ).all();
        const flowed = formalAssetsForLibrary(adb, 'qa').map(asset => asset.business_sector).filter(Boolean);
        res.json({ success: true, data: Array.from(new Set([...rows.map(r => r.business_sector), ...flowed])).sort() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


const SUPPLIER_DISCOVERY_SECTORS = [
    '设备供应商',
    '直连供应商',
    '语音直连供应商',
    '语音供应商',
    '卡线',
];
const SUPPLIER_PROFILE_ASSET_TYPES = [
    'contact_role',
    'operation_action',
    'risk_pattern',
    'sla_commitment',
    'change_event',
    'entity_relationship',
];

function safeProfileJson(value, fallback) {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function isSupplierDiscoverySector(sector) {
    const normalized = normalizeSector(sector);
    return SUPPLIER_DISCOVERY_SECTORS.includes(normalized);
}

function addCount(map, key, count = 1) {
    const value = String(key || '').trim();
    if (!value) return;
    map.set(value, (map.get(value) || 0) + Number(count || 0));
}

function topCountKey(map, fallback = '') {
    let best = fallback;
    let bestCount = -1;
    for (const [key, count] of map.entries()) {
        if (count > bestCount) {
            best = key;
            bestCount = count;
        }
    }
    return best;
}

function mapSupplierProfile(row) {
    if (!row) return null;
    return {
        ...row,
        top_issue_types: safeProfileJson(row.top_issue_types, []),
        active_hours: safeProfileJson(row.active_hours, {}),
        ai_attitude_tags: safeProfileJson(row.ai_attitude_tags, []),
        ai_insight_tags: safeProfileJson(row.ai_insight_tags, []),
        ai_insight_summary: row.ai_insight_summary || '',
        ai_sub_scores: safeProfileJson(row.ai_sub_scores, {}),
    };
}

function ensureSupplierCoverage(map, groupName) {
    const key = String(groupName || '').trim();
    if (!key) return null;
    if (!map.has(key)) {
        map.set(key, {
            group_name: key,
            business_sector: '',
            region: '',
            platform: '',
            total_messages: 0,
            message_count: 0,
            asset_count: 0,
            contact_assets: 0,
            action_assets: 0,
            risk_assets: 0,
            sla_assets: 0,
            change_assets: 0,
            entity_assets: 0,
            reliability_score: null,
            p50_response_mins: null,
            p95_response_mins: null,
            avg_response_mins: null,
            avg_resolution_mins: null,
            total_issues: 0,
            open_issues: 0,
            commitment_rate: null,
            recurrence_rate: 0,
            profile_status: 'pending_profile',
            profile_status_label: '待画像',
            is_profiled: 0,
            last_seen_at: null,
            profile_updated_at: null,
            _sources: new Set(),
            _sectorCounts: new Map(),
            _regionCounts: new Map(),
            _platformCounts: new Map(),
        });
    }
    return map.get(key);
}

function buildSupplierCoverageRows(adb, sdb) {
    const map = new Map();

    if (adb && tableExists(adb, 'supplier_profiles')) {
        const profiles = adb.prepare('SELECT * FROM supplier_profiles').all();
        profiles.forEach(row => {
            const item = ensureSupplierCoverage(map, row.group_name);
            if (!item) return;
            const parsed = mapSupplierProfile(row);
            Object.assign(item, parsed, {
                profile_status: 'profiled',
                profile_status_label: '已画像',
                is_profiled: 1,
                message_count: Math.max(Number(item.message_count || 0), Number(row.total_messages || 0)),
                asset_count: Number(item.asset_count || 0),
            });
            item._sources.add('正式画像');
            addCount(item._sectorCounts, parsed.business_sector, Number(row.total_messages || 1));
            addCount(item._regionCounts, parsed.region, Number(row.total_messages || 1));
            addCount(item._platformCounts, parsed.platform, Number(row.total_messages || 1));
        });
    }

    if (adb && tableExists(adb, 'knowledge_assets')) {
        const placeholders = SUPPLIER_PROFILE_ASSET_TYPES.map(() => '?').join(',');
        const assets = adb.prepare(`
            SELECT group_name, business_sector, collection_region, receiver_account, asset_type,
                   COUNT(*) AS asset_count,
                   SUM(CASE WHEN asset_type = 'contact_role' THEN 1 ELSE 0 END) AS contact_assets,
                   SUM(CASE WHEN asset_type = 'operation_action' THEN 1 ELSE 0 END) AS action_assets,
                   SUM(CASE WHEN asset_type = 'risk_pattern' THEN 1 ELSE 0 END) AS risk_assets,
                   SUM(CASE WHEN asset_type = 'sla_commitment' THEN 1 ELSE 0 END) AS sla_assets,
                   SUM(CASE WHEN asset_type = 'change_event' THEN 1 ELSE 0 END) AS change_assets,
                   SUM(CASE WHEN asset_type = 'entity_relationship' THEN 1 ELSE 0 END) AS entity_assets,
                   MAX(last_seen_at) AS last_seen_at
            FROM knowledge_assets
            WHERE status = 'active'
              AND group_name IS NOT NULL
              AND group_name != ''
              AND asset_type IN (${placeholders})
            GROUP BY group_name, business_sector, collection_region, receiver_account, asset_type
        `).all(...SUPPLIER_PROFILE_ASSET_TYPES);

        const accountMap = getAccountRegionMap();
        assets.forEach(row => {
            const sector = normalizeSector(row.business_sector || accountMap.get(row.receiver_account)?.business_sector);
            if (!isSupplierDiscoverySector(sector)) return;
            const item = ensureSupplierCoverage(map, row.group_name);
            if (!item) return;
            item._sources.add('知识资产');
            item.asset_count += Number(row.asset_count || 0);
            item.contact_assets += Number(row.contact_assets || 0);
            item.action_assets += Number(row.action_assets || 0);
            item.risk_assets += Number(row.risk_assets || 0);
            item.sla_assets += Number(row.sla_assets || 0);
            item.change_assets += Number(row.change_assets || 0);
            item.entity_assets += Number(row.entity_assets || 0);
            item.last_seen_at = Math.max(Number(item.last_seen_at || 0), Number(row.last_seen_at || 0)) || item.last_seen_at;
            addCount(item._sectorCounts, sector, Number(row.asset_count || 1));
            addCount(item._regionCounts, row.collection_region || accountMap.get(row.receiver_account)?.region, Number(row.asset_count || 1));
        });
    }

    if (sdb && tableExists(sdb, 'messages')) {
        const placeholders = SUPPLIER_DISCOVERY_SECTORS.map(() => '?').join(',');
        const rows = sdb.prepare(`
            SELECT group_name, business_sector, receiver_account, platform,
                   COUNT(*) AS message_count,
                   MAX(timestamp) AS last_seen_at
            FROM messages
            WHERE group_name IS NOT NULL
              AND group_name != ''
              AND business_sector IN (${placeholders})
            GROUP BY group_name, business_sector, receiver_account, platform
        `).all(...SUPPLIER_DISCOVERY_SECTORS);
        const accountMap = getAccountRegionMap();
        rows.forEach(row => {
            const sector = normalizeSector(row.business_sector || accountMap.get(row.receiver_account)?.business_sector);
            if (!isSupplierDiscoverySector(sector)) return;
            const item = ensureSupplierCoverage(map, row.group_name);
            if (!item) return;
            const count = Number(row.message_count || 0);
            item._sources.add('消息记录');
            item.message_count += count;
            item.total_messages = Math.max(Number(item.total_messages || 0), item.message_count);
            item.last_seen_at = Math.max(Number(item.last_seen_at || 0), Number(row.last_seen_at || 0)) || item.last_seen_at;
            addCount(item._sectorCounts, sector, count || 1);
            addCount(item._regionCounts, accountMap.get(row.receiver_account)?.region, count || 1);
            addCount(item._platformCounts, row.platform, count || 1);
        });
    }

    return Array.from(map.values()).map(item => {
        const sources = Array.from(item._sources);
        const sector = item.business_sector || topCountKey(item._sectorCounts, '未分类');
        const region = item.region || topCountKey(item._regionCounts, '未知');
        const platform = item.platform || topCountKey(item._platformCounts, '');
        const statusLabel = item.is_profiled
            ? '已画像'
            : (item.asset_count > 0 ? '资产已发现' : '待画像');
        const output = {
            ...item,
            business_sector: sector,
            region,
            platform,
            total_messages: Math.max(Number(item.total_messages || 0), Number(item.message_count || 0)),
            source_coverage: sources,
            source_count: sources.length,
            profile_status_label: statusLabel,
        };
        delete output._sources;
        delete output._sectorCounts;
        delete output._regionCounts;
        delete output._platformCounts;
        return output;
    });
}

function sortSupplierCoverageRows(rows, sort) {
    const score = value => value == null ? -1 : Number(value || 0);
    const mins = value => value == null ? Number.MAX_SAFE_INTEGER : Number(value || 0);
    const updated = row => Number(row.last_seen_at || 0) || Date.parse(row.profile_updated_at || row.score_updated_at || row.created_at || '') || 0;
    const sorters = {
        issues: (a, b) => Number(b.total_issues || 0) - Number(a.total_issues || 0)
            || Number(b.open_issues || 0) - Number(a.open_issues || 0)
            || updated(b) - updated(a),
        response: (a, b) => mins(a.avg_response_mins ?? a.p50_response_mins) - mins(b.avg_response_mins ?? b.p50_response_mins)
            || Number(b.is_profiled || 0) - Number(a.is_profiled || 0)
            || updated(b) - updated(a),
        commitment: (a, b) => score(b.commitment_rate) - score(a.commitment_rate)
            || Number(b.is_profiled || 0) - Number(a.is_profiled || 0)
            || updated(b) - updated(a),
        updated: (a, b) => updated(b) - updated(a),
        coverage: (a, b) => Number(b.source_count || 0) - Number(a.source_count || 0)
            || Number(b.asset_count || 0) - Number(a.asset_count || 0)
            || Number(b.message_count || 0) - Number(a.message_count || 0)
            || Number(b.is_profiled || 0) - Number(a.is_profiled || 0),
        score: (a, b) => Number(b.is_profiled || 0) - Number(a.is_profiled || 0)
            || score(b.reliability_score) - score(a.reliability_score)
            || Number(b.asset_count || 0) - Number(a.asset_count || 0)
            || updated(b) - updated(a),
    };
    return rows.sort(sorters[sort] || sorters.score);
}

router.get('/supplier-profiles/sectors', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const rows = buildSupplierCoverageRows(adb, getSourceDb());
        const sectors = Array.from(new Set(rows.map(r => r.business_sector).filter(Boolean))).sort();
        res.json({ success: true, data: sectors });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/supplier-profiles/:groupName', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.status(503).json({ success: false, error: 'analytics 不可用' });

        const groupName = decodeURIComponent(req.params.groupName);
        const profileRow = tableExists(adb, 'supplier_profiles')
            ? adb.prepare('SELECT * FROM supplier_profiles WHERE group_name = ?').get(groupName)
            : null;
        const coverage = buildSupplierCoverageRows(adb, getSourceDb()).find(row => row.group_name === groupName);
        if (!profileRow && !coverage) return res.status(404).json({ success: false, error: '供应商未找到' });
        const profile = profileRow
            ? {
                ...(coverage || {}),
                ...mapSupplierProfile(profileRow),
                source_coverage: coverage?.source_coverage || ['正式画像'],
                message_count: coverage?.message_count || profileRow.total_messages || 0,
                asset_count: coverage?.asset_count || 0,
                contact_assets: coverage?.contact_assets || 0,
                action_assets: coverage?.action_assets || 0,
                risk_assets: coverage?.risk_assets || 0,
                sla_assets: coverage?.sla_assets || 0,
                change_assets: coverage?.change_assets || 0,
                entity_assets: coverage?.entity_assets || 0,
                profile_status: 'profiled',
                profile_status_label: '已画像',
                is_profiled: 1,
            }
            : {
                ...coverage,
                active_hours: {},
                top_issue_types: [],
                ai_attitude_tags: [],
                ai_insight_tags: ['待画像', ...(coverage.asset_count > 0 ? ['已有知识资产'] : [])],
                ai_sub_scores: {},
                ai_avg_turns: null,
                ai_fcr: null,
                ai_tech_contact: '',
                ai_tech_reply_rate: null,
                ai_planned_maintenance_pct: null,
                ai_profile_version: '',
                ai_insight_summary: `该供应商群已在${(coverage.source_coverage || []).join('、') || '消息记录'}中出现，但尚未完成正式可靠性画像；建议先查看已沉淀知识资产、近期告警和消息量，再决定是否纳入重点评分。`,
            };

        const recentAlerts = tableExists(adb, 'alert_records') ? adb.prepare(`
            SELECT alert_level, trigger_type, trigger_keywords, created_at
            FROM alert_records WHERE group_name = ? ORDER BY created_at DESC LIMIT 10
        `).all(groupName) : [];

        const qualityMetrics = tableExists(adb, 'channel_quality_metrics') ? adb.prepare(`
            SELECT metric_date, metric_type, metric_value
            FROM channel_quality_metrics
            WHERE group_name = ? AND metric_date >= ?
            ORDER BY metric_date DESC, metric_type
            LIMIT 100
        `).all(groupName, new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0]) : [];

        const relatedKnowledgeAssets = tableExists(adb, 'knowledge_assets')
            ? adb.prepare(`
                SELECT *
                FROM knowledge_assets
                WHERE group_name = ?
                  AND status = 'active'
                  AND asset_type IN ('contact_role', 'operation_action', 'risk_pattern', 'sla_commitment', 'change_event')
                ORDER BY asset_value_score DESC, quality_score DESC, last_seen_at DESC
                LIMIT 12
            `).all(groupName).map(mapFormalKnowledgeAsset)
            : [];

        res.json({
            success: true,
            data: {
                ...profile,
                top_issue_types: safeProfileJson(profile.top_issue_types, []),
                active_hours: safeProfileJson(profile.active_hours, {}),
                ai_attitude_tags: safeProfileJson(profile.ai_attitude_tags, []),
                ai_insight_tags: safeProfileJson(profile.ai_insight_tags, []),
                ai_insight_summary: profile.ai_insight_summary || '',
                ai_sub_scores: safeProfileJson(profile.ai_sub_scores, {}),
                ai_avg_turns: profile.ai_avg_turns,
                ai_fcr: profile.ai_fcr,
                ai_tech_contact: profile.ai_tech_contact,
                ai_tech_reply_rate: profile.ai_tech_reply_rate,
                ai_planned_maintenance_pct: profile.ai_planned_maintenance_pct,
                ai_profile_version: profile.ai_profile_version,
                recent_alerts: recentAlerts,
                quality_metrics: qualityMetrics,
                related_knowledge_assets: relatedKnowledgeAssets,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/supplier-profiles', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [], total: 0 });

        const { sector, region, sort, page, limit } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let rows = buildSupplierCoverageRows(adb, getSourceDb());
        if (sector) rows = rows.filter(row => row.business_sector === sector);
        if (region) rows = rows.filter(row => row.region === region);
        rows = sortSupplierCoverageRows(rows, sort);
        const total = rows.length;
        const pageRows = rows.slice(offset, offset + limitNum);

        res.json({
            success: true,
            data: pageRows.map(mapSupplierProfile),
            total, page: pageNum, limit: limitNum,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/device-kb', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [], total: 0 });
        const { keyword, category, page, limit } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        const kw = keyword ? String(keyword).toLowerCase() : '';
        const rows = deviceKbRowsWithFormalAssets(adb)
            .filter(r => !category || r.fault_category === category)
            .filter(r => !kw || [r.device_model, r.fault_symptom, r.solution_steps, r.fault_category].join(' ').toLowerCase().includes(kw));
        const total = rows.length;
        res.json({ success: true, data: rows.slice(offset, offset + limitNum), total, page: pageNum, pages: Math.ceil(total / limitNum) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/device-kb/categories', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const rows = adb.prepare(
            'SELECT DISTINCT fault_category FROM device_knowledge_graph WHERE fault_category IS NOT NULL ORDER BY fault_category'
        ).all();
        const flowed = formalAssetsForLibrary(adb, 'device').map(formalAssetToDeviceKb).map(item => item.fault_category).filter(Boolean);
        res.json({ success: true, data: Array.from(new Set([...rows.map(r => r.fault_category), ...flowed])).sort() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── 设备知识库导出（支持 json / jsonl / csv）─────────────────────
router.get('/device-kb/export', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.status(503).json({ success: false, error: '数据库不可用' });

        const fmt = (req.query.format || 'json').toLowerCase();
        const rows = deviceKbRowsWithFormalAssets(adb);

        const timestamp = new Date().toISOString().slice(0, 10);

        if (fmt === 'jsonl') {
            res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="device-kb-${timestamp}.jsonl"`);
            for (const r of rows) {
                const line = {
                    instruction: `设备 ${r.device_model} 出现故障：${r.fault_symptom}，如何处理？`,
                    input: `故障类型: ${r.fault_category || '未知'}`,
                    output: r.solution_steps || '',
                    metadata: {
                        id: r.id,
                        source_type: r.source_type,
                        source_asset_uid: r.source_asset_uid,
                        device_model: r.device_model,
                        fault_category: r.fault_category,
                        frequency: r.frequency,
                        last_seen_at: r.last_seen_at,
                    }
                };
                res.write(JSON.stringify(line) + '\n');
            }
            return res.end();
        }

        if (fmt === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="device-kb-${timestamp}.csv"`);
            const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const headers = ['id','source_type','source_asset_uid','device_model','fault_symptom','fault_category','solution_steps','frequency','last_seen_at','created_at'];
            res.write('\uFEFF');
            res.write(headers.join(',') + '\n');
            for (const r of rows) {
                res.write(headers.map(h => escape(r[h])).join(',') + '\n');
            }
            return res.end();
        }

        // 默认 JSON
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="device-kb-${timestamp}.json"`);
        return res.json({ exported_at: new Date().toISOString(), total: rows.length, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/content-templates', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [], total: 0 });
        const { keyword, customer, type, page, limit } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 20));
        const offset = (pageNum - 1) * limitNum;

        let where = 'WHERE 1=1';
        const params = [];
        if (keyword) {
            where += ' AND (template_content LIKE ? OR compliance_notes LIKE ?)';
            const kw = `%${keyword}%`;
            params.push(kw, kw);
        }
        if (customer) { where += ' AND customer_name = ?'; params.push(customer); }
        if (type) { where += ' AND template_type = ?'; params.push(type); }

        const nativeRows = adb.prepare(
            `SELECT * FROM content_template_lib ${where} ORDER BY frequency DESC, last_seen_at DESC LIMIT 5000`
        ).all(...params).map(row => ({ ...row, source_type: 'content_extractor' }));
        const kw = keyword ? String(keyword).toLowerCase() : '';
        const flowedRows = formalAssetsForLibrary(adb, 'content')
            .map(formalAssetToContentTemplate)
            .filter(r => !customer || r.customer_name === customer)
            .filter(r => !type || r.template_type === type)
            .filter(r => !kw || [r.template_content, r.compliance_notes, r.customer_name, r.template_type].join(' ').toLowerCase().includes(kw));
        const rows = [...flowedRows, ...nativeRows]
            .sort((a, b) => (Number(b.frequency || 0) - Number(a.frequency || 0)) || (Number(b.last_seen_at || 0) - Number(a.last_seen_at || 0)));
        const total = rows.length;
        res.json({ success: true, data: rows.slice(offset, offset + limitNum), total, page: pageNum, pages: Math.ceil(total / limitNum) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/content-templates/customers', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: [] });
        const rows = adb.prepare(
            'SELECT DISTINCT customer_name FROM content_template_lib WHERE customer_name IS NOT NULL ORDER BY customer_name'
        ).all();
        const flowed = formalAssetsForLibrary(adb, 'content').map(formalAssetToContentTemplate).map(item => item.customer_name).filter(Boolean);
        res.json({ success: true, data: Array.from(new Set([...rows.map(r => r.customer_name), ...flowed])).sort() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Daily Digest API
router.get('/daily-digest', (req, res) => {
    try {
        const adb = getAnalyticsDb();
        if (!adb) return res.json({ success: true, data: { digests: [], trend: null, regions: [], sectors: [] } });

        const { date, region, sector, account } = req.query;
        
        // Helper function to normalize date format to match database format (YYYY-M-D)
        function normalizeDate(dateStr) {
            if (!dateStr) return dateStr;
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        }
        
        // If no date specified, get the most recent date from database
        let targetDate = date;
        if (!targetDate) {
            const latestDate = adb.prepare('SELECT digest_date FROM daily_digests ORDER BY digest_date DESC LIMIT 1').get();
            if (latestDate) {
                targetDate = latestDate.digest_date;
            }
        }
        
        let sql = 'SELECT * FROM daily_digests WHERE 1=1';
        const params = [];
        
        if (targetDate) {
            sql += ' AND digest_date = ?';
            params.push(targetDate);
        }
        
        if (region) {
            sql += ' AND region = ?';
            params.push(region);
        }
        
        if (sector) {
            sql += ' AND business_sector = ?';
            params.push(sector);
        }

        if (account) {
            sql += ' AND receiver_account = ?';
            params.push(account);
        }
        
        sql += ' ORDER BY digest_date DESC, business_sector, msg_count DESC';
        
        const digests = adb.prepare(sql).all(...params);
        
        // Parse JSON fields
        const parsedDigests = digests.map(d => ({
            ...d,
            key_points: JSON.parse(d.key_points || '[]'),
            follow_up: JSON.parse(d.follow_up || '[]'),
        }));
        
        // Calculate trend for selected date
        let trend = null;
        if (targetDate) {
            // Parse the target date to calculate previous dates
            const targetDateObj = new Date(targetDate);
            const prevDateObj = new Date(targetDateObj.getTime() - 24 * 60 * 60 * 1000);
            const weekDateObj = new Date(targetDateObj.getTime() - 7 * 24 * 60 * 60 * 1000);
            
            const prevDate = normalizeDate(prevDateObj.toISOString().split('T')[0]);
            const weekDate = normalizeDate(weekDateObj.toISOString().split('T')[0]);
            
            // Build trend query with same filters as main query
            let trendSql = 'SELECT SUM(msg_count) as total FROM daily_digests WHERE digest_date = ?';
            const trendParams = [targetDate];
            
            if (region) {
                trendSql += ' AND region = ?';
                trendParams.push(region);
            }
            
            if (sector) {
                trendSql += ' AND business_sector = ?';
                trendParams.push(sector);
            }

            if (account) {
                trendSql += ' AND receiver_account = ?';
                trendParams.push(account);
            }
            
            const currentTotal = adb.prepare(trendSql).get(...trendParams)?.total || 0;
            
            // Previous day trend
            let prevTrendSql = trendSql.replace('?', '?', 1);
            const prevTrendParams = [prevDate];
            if (region) prevTrendParams.push(region);
            if (sector) prevTrendParams.push(sector);
            if (account) prevTrendParams.push(account);
            const prevTotal = adb.prepare(prevTrendSql).get(...prevTrendParams)?.total || 0;
            
            // Last week trend
            let weekTrendSql = trendSql.replace('?', '?', 1);
            const weekTrendParams = [weekDate];
            if (region) weekTrendParams.push(region);
            if (sector) weekTrendParams.push(sector);
            if (account) weekTrendParams.push(account);
            const weekTotal = adb.prepare(weekTrendSql).get(...weekTrendParams)?.total || 0;
            
            const trendPrevDay = prevTotal > 0 ? ((currentTotal - prevTotal) / prevTotal * 100).toFixed(0) : null;
            const trendLastWeek = weekTotal > 0 ? ((currentTotal - weekTotal) / weekTotal * 100).toFixed(0) : null;
            
            trend = {
                yesterdayTotal: currentTotal,
                prevDayCount: prevTotal,
                lastWeekCount: weekTotal,
                trendPrevDay,
                trendLastWeek
            };
        }
        
        // Get available regions and sectors
        const regions = adb.prepare('SELECT DISTINCT region FROM daily_digests WHERE region IS NOT NULL ORDER BY region').all().map(r => r.region);
        const sectors = adb.prepare('SELECT DISTINCT business_sector FROM daily_digests WHERE business_sector IS NOT NULL ORDER BY business_sector').all().map(r => r.business_sector);
        const accounts = adb.prepare('SELECT DISTINCT receiver_account FROM daily_digests WHERE receiver_account IS NOT NULL ORDER BY receiver_account').all().map(r => r.receiver_account);
        
        // Get available dates - sort by date value instead of string
        const allDates = adb.prepare('SELECT DISTINCT digest_date FROM daily_digests').all().map(r => r.digest_date);
        // Sort dates properly by parsing them
        const dates = allDates.sort((a, b) => {
            const [yearA, monthA, dayA] = a.split('-').map(Number);
            const [yearB, monthB, dayB] = b.split('-').map(Number);
            const dateA = new Date(yearA, monthA - 1, dayA);
            const dateB = new Date(yearB, monthB - 1, dayB);
            return dateB - dateA;
        }).slice(0, 7);
        
        res.json({
            success: true,
            data: {
                digests: parsedDigests,
                trend,
                regions,
                sectors,
                accounts,
                dates,
                selectedDate: targetDate || dates[0] || null
            }
        });
    } catch (err) {
        console.error('Daily digest API error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
module.exports.getAnalyticsDb = getAnalyticsDb;
