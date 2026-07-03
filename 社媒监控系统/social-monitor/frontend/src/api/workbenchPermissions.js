import api from '@/utils/request'

export const getWorkbenchPermissionMe = () =>
  api.get('/api/admin/workbench-permissions/me')

export const getWorkbenchOperators = (params = {}) =>
  api.get('/api/admin/workbench-permissions/operators', { params })

export const getWorkbenchPermissionScopes = (params = {}) =>
  api.get('/api/admin/workbench-permissions/scopes', { params })

export const saveWorkbenchPermissionScopes = (data) =>
  api.put('/api/admin/workbench-permissions/scopes', data)

export const deleteWorkbenchPermissionScope = (id) =>
  api.delete(`/api/admin/workbench-permissions/scopes/${id}`)
