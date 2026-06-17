/**
 * 分析与情报 API 服务层
 * 对应路由：/api/analytics、/api/alerts、/api/knowledge-assets、
 *           /api/supplier-profiles、/api/daily-digest 等
 */

import api from '@/utils/request'

// ─── 告警 Dashboard ───────────────────────────────────────────────────────────

/**
 * 获取告警 Dashboard 汇总数据
 * @param {{ days?: number }} params
 */
export const getDashboard = (params = {}) =>
  api.get('/api/analytics/dashboard', { params })

/**
 * 获取统计摘要
 * @param {{ days?: number }} params
 */
export const getAnalyticsSummary = (params = {}) =>
  api.get('/api/analytics/summary', { params })

/**
 * 获取告警列表
 * @param {{ page?: number, limit?: number, region?: string, level?: string }} params
 */
export const getAlerts = (params = {}) =>
  api.get('/api/alerts', { params })

/**
 * 获取近期已关闭事件
 * @param {{ limit?: number }} params
 */
export const getClosedRecent = (params = {}) =>
  api.get('/api/closed-recent', { params })

// ─── 知识资产 ─────────────────────────────────────────────────────────────────

/**
 * 获取知识资产候选列表
 * @param {{ page?, limit?, type?, status?, region? }} params
 */
export const getKnowledgeAssets = (params = {}) =>
  api.get('/api/knowledge-assets', { params })

/**
 * 获取知识资产候选汇总
 */
export const getKnowledgeAssetsSummary = () =>
  api.get('/api/knowledge-assets/summary')

/**
 * 获取知识资产候选筛选维度
 */
export const getKnowledgeAssetsFacets = () =>
  api.get('/api/knowledge-assets/facets')

/**
 * 批量审核知识资产候选
 * @param {{ ids: number[], action: 'approve' | 'reject', target_type?: string }} data
 */
export const reviewKnowledgeAssetsBatch = (data) =>
  api.patch('/api/knowledge-assets/review-batch', data)

/**
 * 获取单个知识资产候选详情
 * @param {string} dedupeKey
 */
export const getKnowledgeAssetDetail = (dedupeKey) =>
  api.get(`/api/knowledge-assets/${encodeURIComponent(dedupeKey)}`)

/**
 * 获取知识资产候选来源消息列表
 * @param {string} dedupeKey
 */
export const getKnowledgeAssetSources = (dedupeKey) =>
  api.get(`/api/knowledge-assets/${encodeURIComponent(dedupeKey)}/sources`)

/**
 * 单个审核知识资产候选
 * @param {string} dedupeKey
 * @param {{ action: 'approve' | 'reject', target_type?: string }} data
 */
export const reviewKnowledgeAsset = (dedupeKey, data) =>
  api.patch(`/api/knowledge-assets/${encodeURIComponent(dedupeKey)}/review`, data)

/**
 * 标记联系人我方/外部身份
 * @param {string} dedupeKey
 * @param {{ side: 'internal' | 'external' }} data
 */
export const retagKnowledgeAssetContactSide = (dedupeKey, data) =>
  api.patch(`/api/knowledge-assets/${encodeURIComponent(dedupeKey)}/contact-side`, data)

/**
 * 强制晋升知识资产到正式库
 * @param {string} dedupeKey
 */
export const promoteKnowledgeAsset = (dedupeKey) =>
  api.post(`/api/knowledge-assets/${encodeURIComponent(dedupeKey)}/promote`)

/**
 * 获取正式知识资产列表
 * @param {{ type?, page?, limit? }} params
 */
export const getFormalAssets = (params = {}) =>
  api.get('/api/knowledge-assets/formal', { params })

/**
 * 获取正式资产汇总
 */
export const getFormalAssetsSummary = () =>
  api.get('/api/knowledge-assets/formal/summary')

// ─── 情报 Dashboard ──────────────────────────────────────────────────────────

/**
 * 获取区域情报 Dashboard
 * @param {{ region?: string, days?: number }} params
 */
export const getRegionIntelligenceDashboard = (params = {}) =>
  api.get('/api/knowledge-assets/intelligence/region-dashboard', { params })

/**
 * 获取区域列表（情报维度）
 * @param {{ days?: number }} params
 */
export const getIntelligenceRegions = (params = {}) =>
  api.get('/api/knowledge-assets/intelligence/regions', { params })

/**
 * 获取客服/设备情报 Dashboard
 * @param {{ domain?: string, days?: number }} params
 */
export const getDomainIntelligenceDashboard = (params = {}) =>
  api.get('/api/knowledge-assets/intelligence/domain-dashboard', { params })

// ─── 实体关系图谱 ─────────────────────────────────────────────────────────────

/**
 * 获取实体关系图谱数据
 * @param {{ entity_type?: string, relation_type?: string }} params
 */
export const getEntityGraph = (params = {}) =>
  api.get('/api/knowledge-assets/entity-graph', { params })

// ─── 供应商画像 ───────────────────────────────────────────────────────────────

/**
 * 获取供应商画像列表
 * @param {{ sector?, page?, limit? }} params
 */
export const getSupplierProfiles = (params = {}) =>
  api.get('/api/supplier-profiles', { params })

/**
 * 获取供应商画像业务板块列表
 */
export const getSupplierSectors = () =>
  api.get('/api/supplier-profiles/sectors')

/**
 * 更新供应商画像
 * @param {string|number} id
 * @param {object} data
 */
export const updateSupplierProfile = (id, data) =>
  api.put(`/api/supplier-profiles/${id}`, data)

/**
 * 删除供应商画像
 * @param {string|number} id
 */
export const deleteSupplierProfile = (id) =>
  api.delete(`/api/supplier-profiles/${id}`)

// ─── 日报 ─────────────────────────────────────────────────────────────────────

/**
 * 获取日报列表
 * @param {{ date?, region?, page?, limit? }} params
 */
export const getDailyDigests = (params = {}) =>
  api.get('/api/daily-digest', { params })

// ─── 知识库 ───────────────────────────────────────────────────────────────────

/**
 * 获取 QA 知识库列表
 * @param {{ sector?, keyword?, page?, limit? }} params
 */
export const getKnowledgeBase = (params = {}) =>
  api.get('/api/knowledge-base', { params })

/**
 * 获取知识库业务板块
 */
export const getKnowledgeBaseSectors = () =>
  api.get('/api/knowledge-base/sectors')

/**
 * 获取设备知识库列表
 * @param {{ category?, keyword?, page?, limit? }} params
 */
export const getDeviceKB = (params = {}) =>
  api.get('/api/device-kb', { params })

/**
 * 获取设备知识库分类
 */
export const getDeviceKBCategories = () =>
  api.get('/api/device-kb/categories')

// ─── 内容模板 ─────────────────────────────────────────────────────────────────

/**
 * 获取内容模板列表
 * @param {{ customer?, type?, page?, limit? }} params
 */
export const getContentTemplates = (params = {}) =>
  api.get('/api/content-templates', { params })

/**
 * 获取内容模板客户分类
 */
export const getContentTemplateCustomers = () =>
  api.get('/api/content-templates/customers')

// ─── 消息 & 统计 ──────────────────────────────────────────────────────────────

/**
 * 获取消息列表（Feed）
 * @param {{ platform?, group_id?, page?, limit? }} params
 */
export const getMessages = (params = {}) =>
  api.get('/api/messages', { params })

/**
 * 获取统计数据
 * @param {{ days? }} params
 */
export const getStats = (params = {}) =>
  api.get('/api/stats', { params })

// ─── AI 测试 ──────────────────────────────────────────────────────────────────

/**
 * 测试 AI 连通性
 * @param {object} data
 */
export const testAI = (data) =>
  api.post('/api/ai/test', data)
