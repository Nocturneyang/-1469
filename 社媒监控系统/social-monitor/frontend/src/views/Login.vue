<template>
  <div class="login-wrapper">
    <div class="login-card panel">
      <div class="login-header">
        <h2>社媒监控系统 Login</h2>
      </div>

      <div class="login-tabs">
        <div class="tab-buttons">
          <button :class="{ active: activeTab === 'admin' }" @click="activeTab = 'admin'">管理员登录</button>
          <button v-if="guestLoginEnabled" :class="{ active: activeTab === 'view' }" @click="activeTab = 'view'">游客登录</button>
        </div>

        <div v-if="activeTab === 'admin'" class="tab-content">
          <form @submit.prevent="handleAdminLogin">
            <div class="field-group">
              <label class="field-label">Username</label>
              <input
                class="field-input"
                v-model="adminForm.username"
                placeholder="Username"
                required
              />
            </div>

            <div class="field-group">
              <label class="field-label">Password</label>
              <input
                class="field-input"
                v-model="adminForm.password"
                type="password"
                placeholder="Password"
                required
              />
            </div>

            <button type="submit" class="btn-primary" :disabled="loading">
              {{ loading ? '登录中...' : '管理员登录' }}
            </button>
          </form>
          <div class="role-info">
            <p>管理员权限：可访问所有页面，包括账号管理和系统配置</p>
          </div>
        </div>

        <div v-if="guestLoginEnabled && activeTab === 'view'" class="tab-content">
          <div class="view-login-container">
            <p class="view-login-desc">游客模式：只读权限，不包含原始消息和附件</p>
            <button class="btn-primary" @click="handleViewLogin" :disabled="loading">
              {{ loading ? '登录中...' : '游客登录' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/store/auth'
import { ElMessage } from 'element-plus'
import api from '@/utils/request'
import { isGuestLoginEnabled } from '@/utils/runtime-config'

const router = useRouter()
const authStore = useAuthStore()
const loading = ref(false)
const activeTab = ref('admin')
const guestLoginEnabled = isGuestLoginEnabled()

const adminForm = reactive({
  username: '',
  password: ''
})

const handleAdminLogin = async () => {
  if (!adminForm.username || !adminForm.password) {
    ElMessage.error('请输入账号和密码')
    return
  }
  try {
    loading.value = true
    const response = await api.post('/api/auth/login', adminForm)
    if (response.success) {
      authStore.setAuth(response.token, response.user)
      ElMessage.success(`欢迎回来, ${response.user.username}`)
      router.push('/')
    }
  } catch (err) {
    console.error('Login block:', err)
  } finally {
    loading.value = false
  }
}

const handleViewLogin = async () => {
  try {
    loading.value = true
    const response = await api.post('/api/auth/view-login')
    if (response.success) {
      authStore.setAuth(response.token, response.user)
      ElMessage.success(`欢迎, ${response.user.username}`)
      router.push('/')
    }
  } catch (err) {
    console.error('View login block:', err)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrapper {
  height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: var(--bg);
}

.login-card {
  width: 450px;
  max-width: 90vw;
}

.login-header {
  text-align: center;
  margin-bottom: 24px;
}

.login-header h2 {
  margin: 0;
  color: var(--t);
  font-weight: 600;
  font-size: 24px;
}

.login-tabs {
  margin-top: 20px;
}

.tab-buttons {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
  border-bottom: 2px solid var(--border);
  padding-bottom: 8px;
}

.tab-buttons button {
  flex: 1;
  padding: 8px 16px;
  border: none;
  background: none;
  color: var(--t3);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.tab-buttons button:hover {
  background: var(--bg-tint);
}

.tab-buttons button.active {
  background: var(--p);
  color: white;
}

.tab-content {
  padding: 16px 0;
}

.field-group {
  margin-bottom: 16px;
}

.role-info {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tint);
  border-radius: 8px;
  border-left: 3px solid var(--p);
}

.role-info p {
  margin: 0;
  font-size: 13px;
  color: var(--t2);
  line-height: 1.5;
}

.view-login-container {
  padding: 20px 0;
  text-align: center;
}

.view-login-desc {
  color: var(--t2);
  font-size: 14px;
  margin-bottom: 20px;
  line-height: 1.5;
}
</style>
