import axios from 'axios'
import { useAuthStore } from '@/store/auth'
import router from '@/router'
import { ElMessage } from 'element-plus'

const api = axios.create({
  baseURL: '/',
  timeout: 30000
})

// Request Interceptor
api.interceptors.request.use(
  (config) => {
    const authStore = useAuthStore()
    if (authStore.token) {
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

    if (error.response) {
      // Handle 401/403 globally
      if (error.response.status === 401 || error.response.status === 403) {
        authStore.logout()
        router.push('/login')
        ElMessage.error(error.response.data?.error || '登录态失效或没有权限,请重新登录')
      } else {
        ElMessage.error(error.response.data?.error || '接口请求错误')
      }
    } else {
      ElMessage.error('网络请求错误，请检查连接')
    }

    return Promise.reject(error)
  }
)

export default api
