import api from '@/utils/request'

export const getAccessPermissions = () =>
  api.get('/api/admin/access-control/permissions')

export const getAccessRoles = () =>
  api.get('/api/admin/access-control/roles')

export const createAccessRole = (data) =>
  api.post('/api/admin/access-control/roles', data)

export const saveRolePermissions = (roleCode, permissions) =>
  api.put(`/api/admin/access-control/roles/${encodeURIComponent(roleCode)}/permissions`, { permissions })

export const getAccessOperators = (params = {}) =>
  api.get('/api/admin/access-control/operators', { params })

export const getAccessOperator = (operatorId) =>
  api.get(`/api/admin/access-control/operators/${encodeURIComponent(operatorId)}`)

export const saveAccessOperator = (operatorId, data) =>
  api.put(`/api/admin/access-control/operators/${encodeURIComponent(operatorId)}`, data)
