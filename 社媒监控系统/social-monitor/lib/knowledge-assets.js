'use strict';

const crypto = require('crypto');

const ASSET_TYPES = [
  'entity_relationship',
  'operation_action',
  'regional_intelligence',
  'risk_pattern',
  'sla_commitment',
  'contact_role',
  'change_event',
  'media_evidence',
];

const TYPE_LABELS = {
  entity_relationship: '实体关系图谱',
  operation_action: '运营处理动作',
  regional_intelligence: '区域运营情报',
  risk_pattern: '风险模式',
  sla_commitment: 'SLA承诺履约',
  contact_role: '联系人角色',
  change_event: '变更维护事件',
  media_evidence: '媒体证据',
};

const LIBRARY_LABELS = {
  qa: 'QA 知识库',
  device: '设备知识库',
  content: '内容模板库',
  supplier: '供应商画像',
  region_intelligence: '区域运营情报',
  entity_graph: '实体关系图谱',
  discovery: '资产发现',
};

const PROVIDER_SECTORS = new Set(['设备供应商', '直连供应商', '语音直连供应商', '语音供应商', '卡线']);

const LIBRARY_PATHS = {
  qa: '/knowledge',
  device: '/devicekb',
  content: '/templates',
  supplier: '/profiles',
  region_intelligence: '/region-intelligence',
  entity_graph: '/entity-graph',
  discovery: '/assets',
};

function explicitTargetLibrary(candidate) {
  const metrics = candidate?.metrics || {};
  const key = String(metrics.target_library || candidate?.target_library || '').trim();
  if (!key || !LIBRARY_LABELS[key]) return null;
  return {
    key,
    label: metrics.target_library_label || candidate?.target_library_label || LIBRARY_LABELS[key],
    path: metrics.target_library_path || candidate?.target_library_path || LIBRARY_PATHS[key] || '/assets',
  };
}

function targetLibraryForAsset(candidate) {
  const c = hydrateCandidateRow(candidate);
  const metrics = c.metrics || {};
  const sector = normalizeSector(c.business_sector);
  const entityType = metrics.entity_type || '';
  const interactionSide = metrics.machine_assessment?.interaction_side || metrics.interaction_side || '';

  if (c.asset_type === 'regional_intelligence') {
    return { key: 'region_intelligence', label: LIBRARY_LABELS.region_intelligence, path: '/region-intelligence' };
  }

  if (c.asset_type === 'entity_relationship') {
    return { key: 'entity_graph', label: LIBRARY_LABELS.entity_graph, path: '/entity-graph' };
  }

  if (c.asset_type === 'contact_role' || c.asset_type === 'sla_commitment') {
    return { key: 'supplier', label: LIBRARY_LABELS.supplier, path: '/profiles' };
  }

  if (c.asset_type === 'media_evidence') {
    return { key: 'content', label: LIBRARY_LABELS.content, path: '/templates' };
  }

  const explicitTarget = explicitTargetLibrary(c);
  if (explicitTarget) return explicitTarget;

  if (c.asset_type === 'operation_action' && (sector === '设备供应商' || entityType === 'device_model')) {
    return { key: 'device', label: LIBRARY_LABELS.device, path: '/devicekb' };
  }

  if (interactionSide === 'resource_provider' || PROVIDER_SECTORS.has(sector)) {
    if (['change_event', 'risk_pattern', 'operation_action'].includes(c.asset_type)) {
      return { key: 'supplier', label: LIBRARY_LABELS.supplier, path: '/profiles' };
    }
  }

  if (sector === '客服' || interactionSide === 'resource_user') {
    if (c.asset_type === 'media_evidence') {
      return { key: 'content', label: LIBRARY_LABELS.content, path: '/templates' };
    }
    return { key: 'qa', label: LIBRARY_LABELS.qa, path: '/knowledge' };
  }

  return { key: 'qa', label: LIBRARY_LABELS.qa, path: '/knowledge' };
}

const TYPE_WEIGHTS = {
  contact_role: 24,
  operation_action: 23,
  risk_pattern: 23,
  sla_commitment: 22,
  change_event: 18,
  entity_relationship: 16,
  regional_intelligence: 16,
  media_evidence: 12,
};

const SECTOR_WEIGHTS = {
  '设备供应商': 8,
  '直连供应商': 8,
  '客服': 7,
  '语音直连供应商': 7,
  '语音供应商': 7,
  '卡线': 6,
};

const VALUE_LABEL_WEIGHTS = {
  L0: 8,
  L1: 5,
  L2: 1,
  L3: -10,
};

function stableHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function normalizeSector(value) {
  const s = String(value || '').trim();
  if (s === '语音供应商') return '语音直连供应商';
  return s || '未分类';
}

function json(value, fallback) {
  return JSON.stringify(value == null ? fallback : value);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function uniqueArray(values, keyFn = (item) => String(item)) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    if (value === null || value === undefined || value === '') continue;
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function mergeObjects(base, next) {
  return {
    ...(base || {}),
    ...(next || {}),
  };
}

function hydrateCandidateRow(row) {
  if (!row) return null;
  return {
    ...row,
    source_msg_ids: Array.isArray(row.source_msg_ids) ? row.source_msg_ids : parseJson(row.source_msg_ids, []),
    time_range: typeof row.time_range === 'object' ? row.time_range : parseJson(row.time_range, null),
    evidence: Array.isArray(row.evidence) ? row.evidence : parseJson(row.evidence, []),
    metrics: typeof row.metrics === 'object' ? row.metrics : parseJson(row.metrics, {}),
    related_entities: Array.isArray(row.related_entities) ? row.related_entities : parseJson(row.related_entities, []),
    value_reasons: Array.isArray(row.value_reasons) ? row.value_reasons : parseJson(row.value_reasons, []),
  };
}

function timeRangeFor(candidate) {
  const range = candidate.time_range || {};
  const ids = Array.isArray(candidate.source_msg_ids) ? candidate.source_msg_ids : [];
  return {
    start: range.start || candidate.first_seen_at || null,
    end: range.end || candidate.last_seen_at || range.start || candidate.first_seen_at || null,
    sourceCount: ids.length,
  };
}

function frequencyFor(candidate) {
  const metrics = candidate.metrics || {};
  return Number(
    candidate.frequency ||
    metrics.mention_count ||
    metrics.signal_count ||
    metrics.message_count ||
    metrics.action_count ||
    metrics.close_count ||
    (candidate.source_msg_ids || []).length ||
    1
  ) || 1;
}

function scoreCandidate(candidate) {
  const typeWeight = TYPE_WEIGHTS[candidate.asset_type] || 10;
  const sectorWeight = SECTOR_WEIGHTS[normalizeSector(candidate.business_sector)] || 4;
  const valueLabelWeight = VALUE_LABEL_WEIGHTS[candidate.value_label] ?? 3;
  const confidence = Math.round((Number(candidate.confidence || 0.5)) * 25);
  const freq = Math.min(18, Math.round(Math.log10(frequencyFor(candidate) + 1) * 12));
  const source = Math.min(8, (candidate.source_msg_ids || []).length);
  const metrics = candidate.metrics || {};
  let evidence = 0;

  if (candidate.asset_type === 'operation_action' && metrics.action_playbook?.problem_summary) evidence += 10;
  if (candidate.asset_type === 'operation_action' && metrics.effectiveness_signal) evidence += 14;
  if (metrics.asset_insight?.primary_use) evidence += 4;
  if (metrics.asset_insight?.suggested_next_step) evidence += 3;
  if (metrics.machine_assessment?.decision === 'auto_ready') evidence += 5;
  if (metrics.machine_assessment?.manual_review_required) evidence += 2;
  if (candidate.asset_type === 'sla_commitment' && metrics.commitment_met !== null && metrics.commitment_met !== undefined) evidence += 12;
  if (candidate.asset_type === 'contact_role' && ['技术闭环人', '技术处理人'].includes(metrics.inferred_role)) evidence += 10;
  if (candidate.asset_type === 'risk_pattern') evidence += 6;
  if (candidate.business_region && candidate.collection_region && candidate.business_region !== candidate.collection_region) evidence += 6;

  return Math.max(1, Math.min(100, typeWeight + sectorWeight + valueLabelWeight + confidence + freq + source + evidence));
}

function valueLevelFor(score) {
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

function valueReasonsFor(candidate, score) {
  const reasons = [];
  const typeWeight = TYPE_WEIGHTS[candidate.asset_type] || 0;
  reasons.push(`${TYPE_LABELS[candidate.asset_type] || candidate.asset_type} 属于${typeWeight >= 22 ? '优先' : '补强'}资产类型`);
  if (candidate.business_sector) reasons.push(`${normalizeSector(candidate.business_sector)} 板块命中`);
  if (candidate.value_label) reasons.push(`来源群价值等级 ${candidate.value_label}`);
  if ((candidate.source_msg_ids || []).length > 1) reasons.push(`有 ${(candidate.source_msg_ids || []).length} 条来源消息`);
  if (frequencyFor(candidate) >= 5) reasons.push(`重复出现 ${frequencyFor(candidate)} 次`);
  if (candidate.asset_type === 'contact_role' && candidate.metrics?.is_internal_staff) reasons.push('命中内部员工白名单，属于我方协作角色');
  if (candidate.asset_type === 'contact_role' && candidate.metrics?.contact_side === 'external') reasons.push('非内部白名单联系人，可作为外部/供应商接口候选');
  if (candidate.asset_type === 'operation_action' && candidate.metrics?.action_playbook?.problem_summary) reasons.push('具备问题现象、动作和结果上下文');
  if (candidate.metrics?.asset_insight?.primary_use) reasons.push('已生成可读用途说明，便于人工审核');
  if (candidate.metrics?.asset_insight?.limitation) reasons.push('已标注适用边界，降低误沉淀风险');
  if (candidate.metrics?.machine_assessment?.label) reasons.push(`机器评估：${candidate.metrics.machine_assessment.label}`);
  if (candidate.metrics?.machine_assessment?.interaction_label) reasons.push(candidate.metrics.machine_assessment.interaction_label);
  if (candidate.metrics?.effectiveness_signal) reasons.push('动作后出现恢复信号');
  if (candidate.metrics?.commitment_met === 0) reasons.push('存在未兑现或待复核承诺');
  if (candidate.metrics?.commitment_met === 1) reasons.push('存在已兑现承诺');
  if (candidate.business_region && candidate.collection_region && candidate.business_region !== candidate.collection_region) reasons.push('业务指向区域与采集区域不同，具备跨区域价值');
  if (score >= 75) reasons.push('综合价值分较高，建议优先审核');
  return reasons;
}

function buildDedupeKey(candidate) {
  if (candidate.dedupe_key) return candidate.dedupe_key;
  const sourceIds = (candidate.source_msg_ids || []).slice().sort((a, b) => a - b).join(',');
  return stableHash([
    candidate.asset_type,
    candidate.asset_key || '',
    candidate.collection_region || '',
    candidate.business_region || '',
    candidate.business_sector || '',
    candidate.group_name || '',
    sourceIds,
  ].join('|'));
}

function normalizeCandidate(candidate) {
  const sourceIds = Array.from(new Set(candidate.source_msg_ids || [])).filter(Boolean).sort((a, b) => a - b);
  const timeRange = timeRangeFor({ ...candidate, source_msg_ids: sourceIds });
  const normalized = {
    dedupe_key: buildDedupeKey({ ...candidate, source_msg_ids: sourceIds }),
    asset_type: candidate.asset_type,
    asset_key: candidate.asset_key || '',
    title: candidate.title || '',
    description: candidate.description || '',
    collection_region: candidate.collection_region || candidate.region || '未知区',
    business_region: candidate.business_region || candidate.region || candidate.collection_region || '未知区',
    business_sector: normalizeSector(candidate.business_sector),
    receiver_account: candidate.receiver_account || '',
    value_label: candidate.value_label || 'L1',
    group_name: candidate.group_name || '',
    source_msg_ids: sourceIds,
    time_range: candidate.time_range || (timeRange.start ? { start: timeRange.start, end: timeRange.end } : null),
    evidence: (candidate.evidence || []).filter(Boolean).slice(0, 8),
    metrics: candidate.metrics || {},
    related_entities: candidate.related_entities || [],
    confidence: Number(candidate.confidence || 0.5),
    frequency: frequencyFor(candidate),
    first_seen_at: candidate.first_seen_at || timeRange.start,
    last_seen_at: candidate.last_seen_at || timeRange.end,
    extractor: candidate.extractor || 'knowledge-asset-analyzer',
    extractor_version: candidate.extractor_version || 'v1',
    prompt_version: candidate.prompt_version || null,
    model_name: candidate.model_name || null,
    validation_status: candidate.validation_status || 'rule_validated',
  };
  normalized.asset_value_score = Number.isFinite(candidate.asset_value_score)
    ? candidate.asset_value_score
    : scoreCandidate(normalized);
  normalized.value_level = candidate.value_level || valueLevelFor(normalized.asset_value_score);
  normalized.value_reasons = candidate.value_reasons || valueReasonsFor(normalized, normalized.asset_value_score);
  return normalized;
}

function prepareUpsert(db) {
  return db.prepare(`
    INSERT INTO knowledge_asset_candidates (
      dedupe_key, asset_type, asset_key, title, description,
      collection_region, business_region, business_sector, receiver_account, value_label, group_name,
      source_msg_ids, time_range, evidence, metrics, related_entities,
      confidence, asset_value_score, value_level, value_reasons, frequency, first_seen_at, last_seen_at,
      extractor, extractor_version, prompt_version, model_name, validation_status, updated_at
    ) VALUES (
      @dedupe_key, @asset_type, @asset_key, @title, @description,
      @collection_region, @business_region, @business_sector, @receiver_account, @value_label, @group_name,
      @source_msg_ids, @time_range, @evidence, @metrics, @related_entities,
      @confidence, @asset_value_score, @value_level, @value_reasons, @frequency, @first_seen_at, @last_seen_at,
      @extractor, @extractor_version, @prompt_version, @model_name, @validation_status, datetime('now', '+8 hours')
    )
    ON CONFLICT(dedupe_key) DO UPDATE SET
      source_msg_ids=excluded.source_msg_ids,
      time_range=excluded.time_range,
      evidence=excluded.evidence,
      metrics=excluded.metrics,
      related_entities=excluded.related_entities,
      confidence=MAX(knowledge_asset_candidates.confidence, excluded.confidence),
      asset_value_score=MAX(knowledge_asset_candidates.asset_value_score, excluded.asset_value_score),
      value_level=CASE
        WHEN MAX(knowledge_asset_candidates.asset_value_score, excluded.asset_value_score) >= 75 THEN 'high'
        WHEN MAX(knowledge_asset_candidates.asset_value_score, excluded.asset_value_score) >= 50 THEN 'medium'
        ELSE 'low'
      END,
      value_reasons=excluded.value_reasons,
      frequency=MAX(knowledge_asset_candidates.frequency, excluded.frequency),
      first_seen_at=COALESCE(MIN(knowledge_asset_candidates.first_seen_at, excluded.first_seen_at), excluded.first_seen_at, knowledge_asset_candidates.first_seen_at),
      last_seen_at=COALESCE(MAX(knowledge_asset_candidates.last_seen_at, excluded.last_seen_at), excluded.last_seen_at, knowledge_asset_candidates.last_seen_at),
      extractor=excluded.extractor,
      extractor_version=excluded.extractor_version,
      validation_status=excluded.validation_status,
      updated_at=datetime('now', '+8 hours')
  `);
}

function toDbRow(candidate) {
  const row = normalizeCandidate(candidate);
  return {
    ...row,
    source_msg_ids: json(row.source_msg_ids, []),
    time_range: json(row.time_range, null),
    evidence: json(row.evidence, []),
    metrics: json(row.metrics, {}),
    related_entities: json(row.related_entities, []),
    value_reasons: json(row.value_reasons, []),
  };
}

function upsertCandidates(db, candidates) {
  if (!candidates.length) return { inserted: 0 };
  const stmt = prepareUpsert(db);
  const tx = db.transaction((rows) => {
    for (const candidate of rows) stmt.run(toDbRow(candidate));
  });
  tx(candidates);
  return { inserted: candidates.length };
}

function assetDedupeParts(candidate) {
  const c = hydrateCandidateRow(candidate);
  return {
    asset_type: c.asset_type,
    asset_key: c.asset_key || c.title || '',
    collection_region: c.collection_region || '未知区',
    business_sector: normalizeSector(c.business_sector),
    group_name: c.group_name || '',
  };
}

function buildAssetUid(candidate) {
  const parts = assetDedupeParts(candidate);
  return `ka_${stableHash([
    parts.asset_type,
    parts.asset_key,
    parts.collection_region,
    parts.business_sector,
    parts.group_name,
  ].join('|'))}`;
}

function qualityScoreFor(candidate) {
  const c = hydrateCandidateRow(candidate);
  const confidence = Math.round((Number(c.confidence || 0.5)) * 35);
  const value = Math.round((Number(c.asset_value_score || 50)) * 0.45);
  const evidence = Math.min(15, (c.source_msg_ids || []).length + (c.evidence || []).length);
  const reviewed = c.review_status === 'confirmed' ? 8 : 0;
  return Math.max(1, Math.min(100, confidence + value + evidence + reviewed));
}

function assetFromCandidate(candidate, actor = 'system') {
  const c = hydrateCandidateRow(candidate);
  const parts = assetDedupeParts(c);
  const targetLibrary = targetLibraryForAsset(c);
  const metrics = {
    ...(c.metrics || {}),
    target_library: targetLibrary.key,
    target_library_label: targetLibrary.label,
    target_library_path: targetLibrary.path,
  };
  return {
    asset_uid: buildAssetUid(c),
    asset_type: c.asset_type,
    asset_key: c.asset_key || c.title || '',
    title: c.title || '',
    summary: c.description || '',
    status: 'active',
    collection_region: parts.collection_region,
    business_region: c.business_region || parts.collection_region,
    business_sector: parts.business_sector,
    receiver_account: c.receiver_account || '',
    value_label: c.value_label || 'L1',
    group_name: parts.group_name,
    source_candidate_keys: uniqueArray([c.dedupe_key]),
    source_msg_ids: uniqueArray(c.source_msg_ids || []).sort((a, b) => Number(a) - Number(b)),
    time_range: c.time_range || { start: c.first_seen_at || null, end: c.last_seen_at || c.first_seen_at || null },
    evidence: uniqueArray(c.evidence || []).slice(0, 20),
    metrics,
    related_entities: uniqueArray(c.related_entities || [], item => `${item.type || ''}:${item.value || JSON.stringify(item)}`).slice(0, 40),
    tags: uniqueArray([
      TYPE_LABELS[c.asset_type] || c.asset_type,
      parts.business_sector,
      c.metrics?.inferred_role,
      c.metrics?.action_label,
      c.metrics?.machine_assessment?.interaction_label,
      c.metrics?.machine_assessment?.label,
      targetLibrary.label,
      ...(Array.isArray(c.metrics?.signals) ? c.metrics.signals : []),
    ]).slice(0, 20),
    confidence: Number(c.confidence || 0.5),
    asset_value_score: Number(c.asset_value_score || 50),
    quality_score: qualityScoreFor(c),
    frequency: Number(c.frequency || 1),
    first_seen_at: c.first_seen_at || c.time_range?.start || null,
    last_seen_at: c.last_seen_at || c.time_range?.end || c.time_range?.start || null,
    created_from: 'candidate_review',
    created_by: actor,
    reviewed_by: actor,
  };
}

function toAssetDbRow(asset) {
  return {
    ...asset,
    source_candidate_keys: json(asset.source_candidate_keys, []),
    source_msg_ids: json(asset.source_msg_ids, []),
    time_range: json(asset.time_range, null),
    evidence: json(asset.evidence, []),
    metrics: json(asset.metrics, {}),
    related_entities: json(asset.related_entities, []),
    tags: json(asset.tags, []),
  };
}

function hydrateAssetRow(row) {
  if (!row) return null;
  return {
    ...row,
    source_candidate_keys: parseJson(row.source_candidate_keys, []),
    source_msg_ids: parseJson(row.source_msg_ids, []),
    time_range: parseJson(row.time_range, null),
    evidence: parseJson(row.evidence, []),
    metrics: parseJson(row.metrics, {}),
    related_entities: parseJson(row.related_entities, []),
    tags: parseJson(row.tags, []),
  };
}

function mergeAsset(existingRow, incoming) {
  const existing = hydrateAssetRow(existingRow);
  const sourceIds = uniqueArray([
    ...(existing.source_msg_ids || []),
    ...(incoming.source_msg_ids || []),
  ]).sort((a, b) => Number(a) - Number(b));
  const candidateKeys = uniqueArray([
    ...(existing.source_candidate_keys || []),
    ...(incoming.source_candidate_keys || []),
  ]);
  const firstSeen = [existing.first_seen_at, incoming.first_seen_at].filter(Boolean).sort((a, b) => a - b)[0] || null;
  const lastSeen = [existing.last_seen_at, incoming.last_seen_at].filter(Boolean).sort((a, b) => b - a)[0] || null;
  return {
    ...existing,
    summary: incoming.summary || existing.summary || '',
    receiver_account: incoming.receiver_account || existing.receiver_account || '',
    value_label: incoming.value_label || existing.value_label || 'L1',
    source_candidate_keys: candidateKeys,
    source_msg_ids: sourceIds,
    time_range: {
      start: firstSeen || existing.time_range?.start || incoming.time_range?.start || null,
      end: lastSeen || existing.time_range?.end || incoming.time_range?.end || null,
    },
    evidence: uniqueArray([...(existing.evidence || []), ...(incoming.evidence || [])]).slice(0, 20),
    metrics: mergeObjects(existing.metrics, incoming.metrics),
    related_entities: uniqueArray(
      [...(existing.related_entities || []), ...(incoming.related_entities || [])],
      item => `${item.type || ''}:${item.value || JSON.stringify(item)}`
    ).slice(0, 40),
    tags: uniqueArray([...(existing.tags || []), ...(incoming.tags || [])]).slice(0, 20),
    confidence: Math.max(Number(existing.confidence || 0), Number(incoming.confidence || 0)),
    asset_value_score: Math.max(Number(existing.asset_value_score || 0), Number(incoming.asset_value_score || 0)),
    quality_score: Math.max(Number(existing.quality_score || 0), Number(incoming.quality_score || 0)),
    frequency: Math.max(Number(existing.frequency || 0), Number(incoming.frequency || 0)),
    first_seen_at: firstSeen,
    last_seen_at: lastSeen,
    reviewed_by: incoming.reviewed_by || existing.reviewed_by,
  };
}

function promoteCandidateToAsset(db, candidate, actor = 'system') {
  const incoming = assetFromCandidate(candidate, actor);
  const existing = db.prepare(`
    SELECT *
    FROM knowledge_assets
    WHERE asset_type = ?
      AND asset_key = ?
      AND collection_region = ?
      AND business_sector = ?
      AND group_name = ?
    LIMIT 1
  `).get(
    incoming.asset_type,
    incoming.asset_key,
    incoming.collection_region,
    incoming.business_sector,
    incoming.group_name
  );

  const tx = db.transaction(() => {
    let asset = incoming;
    let action = 'created';
    if (existing) {
      asset = mergeAsset(existing, incoming);
      action = 'merged';
      db.prepare(`
        UPDATE knowledge_assets SET
          summary=@summary,
          receiver_account=@receiver_account,
          value_label=@value_label,
          source_candidate_keys=@source_candidate_keys,
          source_msg_ids=@source_msg_ids,
          time_range=@time_range,
          evidence=@evidence,
          metrics=@metrics,
          related_entities=@related_entities,
          tags=@tags,
          confidence=@confidence,
          asset_value_score=@asset_value_score,
          quality_score=@quality_score,
          frequency=@frequency,
          first_seen_at=@first_seen_at,
          last_seen_at=@last_seen_at,
          reviewed_by=@reviewed_by,
          reviewed_at=datetime('now', '+8 hours'),
          updated_at=datetime('now', '+8 hours')
        WHERE asset_uid=@asset_uid
      `).run(toAssetDbRow(asset));
    } else {
      db.prepare(`
        INSERT INTO knowledge_assets (
          asset_uid, asset_type, asset_key, title, summary, status,
          collection_region, business_region, business_sector, receiver_account, value_label, group_name,
          source_candidate_keys, source_msg_ids, time_range, evidence, metrics, related_entities, tags,
          confidence, asset_value_score, quality_score, frequency, first_seen_at, last_seen_at,
          created_from, created_by, reviewed_by, reviewed_at, updated_at
        ) VALUES (
          @asset_uid, @asset_type, @asset_key, @title, @summary, @status,
          @collection_region, @business_region, @business_sector, @receiver_account, @value_label, @group_name,
          @source_candidate_keys, @source_msg_ids, @time_range, @evidence, @metrics, @related_entities, @tags,
          @confidence, @asset_value_score, @quality_score, @frequency, @first_seen_at, @last_seen_at,
          @created_from, @created_by, @reviewed_by, datetime('now', '+8 hours'), datetime('now', '+8 hours')
        )
      `).run(toAssetDbRow(asset));
    }

    for (const candidateKey of incoming.source_candidate_keys || []) {
      db.prepare(`
        INSERT OR IGNORE INTO knowledge_asset_links (asset_uid, candidate_key, link_type, created_by)
        VALUES (?, ?, 'promoted', ?)
      `).run(asset.asset_uid, candidateKey, actor);
    }

    db.prepare(`
      UPDATE knowledge_asset_candidates
      SET review_status = 'confirmed',
          reviewed_by = COALESCE(reviewed_by, ?),
          reviewed_at = COALESCE(reviewed_at, datetime('now', '+8 hours')),
          updated_at = datetime('now', '+8 hours')
      WHERE dedupe_key = ?
    `).run(actor, candidate.dedupe_key);

    return { action, asset: hydrateAssetRow(toAssetDbRow(asset)) };
  });

  return tx();
}

module.exports = {
  ASSET_TYPES,
  LIBRARY_LABELS,
  TYPE_LABELS,
  assetFromCandidate,
  buildDedupeKey,
  buildAssetUid,
  hydrateAssetRow,
  hydrateCandidateRow,
  normalizeCandidate,
  normalizeSector,
  parseJson,
  promoteCandidateToAsset,
  scoreCandidate,
  stableHash,
  targetLibraryForAsset,
  upsertCandidates,
  valueLevelFor,
  valueReasonsFor,
};
