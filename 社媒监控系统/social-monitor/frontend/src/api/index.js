/**
 * API 服务层 - 统一入口
 *
 * 直接重导出 utils/request.js 的 axios 实例，
 * 避免双份实例。业务调用从各功能域 api 文件导入。
 *
 * 使用方式：
 *   import { getAlerts, getDashboard } from '@/api/analytics'
 *   import { getAccounts } from '@/api/accounts'
 */

export { default } from '@/utils/request'

// 统一重导出所有功能域 API，方便按需引入
export * as analyticsApi from './analytics'
export * as accountsApi from './accounts'
export * as knowledgeApi from './knowledge'
export * as configApi from './config'
export * as collectorApi from './collector'
export * as authApi from './auth'
export * as accessControlApi from './accessControl'
