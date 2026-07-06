import axios from 'axios'
import { useAuthStore } from '@/store/auth'
import router from '@/router'
import { ElMessage } from 'element-plus'
import { isSsoEnabled, redirectToSsoLogin } from '@/utils/runtime-config'

const api = axios.create({
  baseURL: '/',
  timeout: 30000
})

// Request Interceptor
api.interceptors.request.use(
  (config) => {
    const authStore = useAuthStore()
    if (authStore.token && !(isSsoEnabled() && authStore.token === '__sso__')) {
      config.headers.Authorization = `Bearer ${authStore.token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response Interceptor
api.interceptors.response.use(
  (response) => {
    return response.data
  },
  (error) => {
    const authStore = useAuthStore()
    const silentError = Boolean(error.config?.silentError)

    if (error.response) {
      if (error.response.status === 401 && isSsoEnabled()) {
        const wasSsoLoggedOut = authStore.ssoLoggedOut
        const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
        authStore.logout(wasSsoLoggedOut ? { manualSsoLogout: true } : {})
        if (!wasSsoLoggedOut && redirectToSsoLogin({
          redirectTo: `${window.location.origin}${currentPath || '/entry'}`
        })) {
          return Promise.reject(error)
        }
        router.push({
          name: 'SsoPending',
          query: wasSsoLoggedOut ? { logged_out: '1', from: '/entry' } : { from: currentPath || '/' }
        })
      } else if (error.response.status === 401 || error.response.status === 403) {
        authStore.logout()
        router.push('/login')
        if (!silentError) ElMessage.error(error.response.data?.error || '登录态失效或没有权限,请重新登录')
      } else {
        if (!silentError) ElMessage.error(error.response.data?.error || '接口请求错误')
      }
    } else {
      if (!silentError) ElMessage.error('网络请求错误，请检查连接')
    }

    return Promise.reject(error)
  }
)

export default api
