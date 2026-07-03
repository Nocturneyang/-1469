/**
 * 账号管理 API 服务层
 * 对应路由：/api/accounts、/api/tg-user、/api/teams、/api/logs
 */

import api from '@/utils/request'

// ─── 账号列表 ─────────────────────────────────────────────────────────────────

/**
 * 获取所有采集账号
 * @param {{ platform? }} params
 */
export const getAccounts = (params = {}) =>
  api.get('/api/accounts', { params })

/**
 * 创建 WhatsApp 账号
 * @param {{ account_name: string }} data
 */
export const createWaAccount = (data) =>
  api.post('/api/accounts/create', data)

/**
 * 创建 Teams 账号
 * @param {{ account_name: string, email: string }} data
 */
export const createTeamsAccount = (data) =>
  api.post('/api/accounts/create-teams', data)

/**
 * 创建 Telegram 用户账号
 * @param {{ account_name: string, phone: string }} data
 */
export const createTgUserAccount = (data) =>
  api.post('/api/accounts/create-tg-user', data)

/**
 * 重启账号采集进程
 * @param {{ account_name: string }} data
 */
export const restartAccount = (data) =>
  api.post('/api/accounts/restart', data)

/**
 * 重新登录账号（重新扫码）
 * @param {{ account_name: string }} data
 */
export const reloginAccount = (data) =>
  api.post('/api/accounts/relogin', data)

/**
 * 登出/注销账号
 * @param {{ id: string }} data
 */
export const logoutAccount = (data) =>
  api.post('/api/accounts/logout', data)

/**
 * 删除账号及其环境
 * @param {string|number} id
 */
export const deleteAccountApi = (id) =>
  api.delete(`/api/accounts/${id}`)

/**
 * 获取 WA Supervisor 状态
 */
export const getWaSupervisorStatus = () =>
  api.get('/api/accounts/wa-supervisor')

/**
 * 获取账号云端运行时状态
 * @param {string} id
 */
export const getAccountRuntime = (id) =>
  api.get(`/api/accounts/${id}/runtime`)

/**
 * 执行账号云端运行时操作
 * @param {string} id
 * @param {'start'|'stop'|'restart'|'relogin'} action
 */
export const accountRuntimeAction = (id, action) =>
  api.post(`/api/accounts/${id}/runtime/${action}`)

/**
 * 更新账号工作台用途
 * @param {string} id
 * @param {{ account_role: 'collector'|'service'|'both'|'disabled', workbench_visible?: boolean, collect_enabled?: boolean, send_enabled?: boolean, sync_groups_enabled?: boolean }} data
 */
export const updateAccountWorkbenchRole = (id, data) =>
  api.patch(`/api/accounts/${id}/workbench-role`, data)

// ─── Telegram 用户账号操作 ────────────────────────────────────────────────────

/**
 * 发起 TG 用户账号登录（发送验证码）
 * @param {{ account_name: string, phone: string }} data
 */
export const startTgUserLogin = (data) =>
  api.post('/api/tg-user/start-login', data)

/**
 * 验证 TG 登录短信验证码
 * @param {{ account_name: string, code: string }} data
 */
export const verifyTgCode = (data) =>
  api.post('/api/tg-user/verify-code', data)

/**
 * 验证 TG 两步验证密码
 * @param {{ account_name: string, password: string }} data
 */
export const verifyTg2FA = (data) =>
  api.post('/api/tg-user/verify-2fa', data)

/**
 * 获取 TG 用户账号会话列表（对话）
 * @param {string} accountName
 * @param {{ limit? }} params
 */
export const getTgUserDialogs = (accountName, params = {}) =>
  api.get(`/api/tg-user/dialogs/${accountName}`, { params })

/**
 * 获取 TG 用户账号配置
 * @param {string} accountName
 */
export const getTgUserConfig = (accountName) =>
  api.get(`/api/tg-user/config/${accountName}`)

/**
 * 更新 TG 用户账号白名单
 * @param {string} accountName
 * @param {object} data
 */
export const updateTgUserWhitelist = (accountName, data) =>
  api.post(`/api/tg-user/whitelist/${accountName}`, data)

/**
 * 发起 TG 历史回溯任务
 * @param {string} accountName
 * @param {object} data
 */
export const startTgBackfill = (accountName, data) =>
  api.post(`/api/tg-user/backfill/${accountName}`, data)

/**
 * 获取 TG 历史回溯任务列表
 * @param {string} accountName
 */
export const getTgBackfillTasks = (accountName) =>
  api.get(`/api/tg-user/backfill/${accountName}`)

/**
 * 暂停 TG 历史回溯任务
 * @param {string} accountName
 */
export const pauseTgBackfill = (accountName) =>
  api.post(`/api/tg-user/backfill/${accountName}/pause`)

/**
 * 恢复 TG 历史回溯任务
 * @param {string} accountName
 */
export const resumeTgBackfill = (accountName) =>
  api.post(`/api/tg-user/backfill/${accountName}/resume`)

/**
 * 重置 TG 某个群组的历史回溯进度
 * @param {string} accountName
 * @param {{ chat_id: string|number }} data
 */
export const resetTgBackfillTask = (accountName, data) =>
  api.post(`/api/tg-user/backfill/${accountName}/reset`, data)

/**
 * 获取 TG 限速状态
 * @param {string} accountName
 */
export const getTgRateLimit = (accountName) =>
  api.get(`/api/tg-user/ratelimit/${accountName}`)

/**
 * 更新 TG 限速配置
 * @param {string} accountName
 * @param {object} data
 */
export const updateTgRateLimit = (accountName, data) =>
  api.post(`/api/tg-user/ratelimit/${accountName}`, data)

/**
 * 撤销 TG 用户账号 Session
 * @param {string} accountName
 */
export const revokeTgUser = (accountName) =>
  api.post(`/api/tg-user/revoke/${accountName}`)

// ─── Teams 账号操作 ───────────────────────────────────────────────────────────

/**
 * 重新登录 Teams 账号
 * @param {string} accountName
 * @param {object} data
 */
export const reloginTeams = (accountName, data) =>
  api.post(`/api/teams/relogin/${accountName}`, data)

/**
 * 发起 Teams 历史回溯
 * @param {string} accountName
 * @param {object} data
 */
export const startTeamsBackfill = (accountName, data) =>
  api.post(`/api/teams/backfill/${accountName}/start`, data)

// ─── 系统日志 ─────────────────────────────────────────────────────────────────

/**
 * 获取 PM2 进程日志
 * @param {{ process_name?, lines? }} params
 */
export const getProcessLogs = (params = {}) =>
  api.get('/api/logs/processes', { params })
