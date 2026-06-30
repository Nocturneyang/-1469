/**
 * 认证 API 服务层
 * 对应路由：/api/auth
 */

import api from '@/utils/request'

/**
 * 用户名密码登录
 * @param {{ username: string, password: string }} data
 */
export const login = (data) =>
  api.post('/api/auth/login', data)

/**
 * 游客免密登录（默认由后端关闭）
 */
export const viewLogin = () =>
  api.post('/api/auth/view-login', {}, { silentError: true })

/**
 * 获取用户列表
 */
export const getUsers = () =>
  api.get('/api/auth/users')

/**
 * 获取 SSO 管理员列表
 */
export const getSsoAdmins = () =>
  api.get('/api/auth/sso-admins')
