/**
 * 系统配置 API 服务层
 * 对应路由：/api/config
 */

import api from '@/utils/request'

/**
 * 获取环境变量配置（脱敏）
 */
export const getEnvConfig = () =>
  api.get('/api/config/env')

/**
 * 获取区域配置列表
 */
export const getRegions = () =>
  api.get('/api/config/regions')

/**
 * 更新区域配置
 * @param {string} regionId
 * @param {object} data
 */
export const updateRegion = (regionId, data) =>
  api.put(`/api/config/regions/${regionId}`, data)

/**
 * 获取内部员工白名单
 */
export const getStaffConfig = () =>
  api.get('/api/config/staff')

/**
 * 获取价值标签配置
 */
export const getValueLabels = () =>
  api.get('/api/config/value-labels')

/**
 * 获取钉钉 Webhook 配置列表
 */
export const getWebhooks = () =>
  api.get('/api/config/webhooks')

/**
 * 更新钉钉 Webhook 配置
 * @param {string} webhookId
 * @param {object} data
 */
export const updateWebhook = (webhookId, data) =>
  api.put(`/api/config/webhooks/${webhookId}`, data)
