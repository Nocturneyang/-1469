/**
 * 采集器管理 API 服务层（云端上报接口）
 * 对应路由：/api/collector（collector token 认证，由本地采集器调用）
 *
 * 注：此模块主要供本地采集器调用，前端 Web UI 一般不直接使用。
 * 前端采集器状态展示通过 accounts.js 获取。
 */

import api from '@/utils/request'

/**
 * 上报消息到云端（本地采集器使用）
 * @param {object} messageData - 消息数据对象
 */
export const reportMessage = (messageData) =>
  api.post('/api/collector/message', messageData)

/**
 * 上报媒体文件到云端（本地采集器使用）
 * @param {FormData} formData
 */
export const reportMedia = (formData) =>
  api.post('/api/collector/media', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  })
