<template>
  <div class="sso-wrapper">
    <div class="sso-panel">
      <div class="sso-title">钉钉身份认证</div>
      <p class="sso-copy">
        系统正在等待钉钉 SSO 网关注入用户信息。认证成功后会自动进入监控系统。
      </p>

      <div class="sso-actions">
        <button class="btn-primary" @click="checkAuth" :disabled="checking">
          {{ checking ? '检查中...' : '重新检查授权' }}
        </button>
        <button class="btn-secondary" @click="openSso">
          打开统一认证
        </button>
      </div>

      <div v-if="error" class="sso-hint">{{ error }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/store/auth'
import { redirectToSsoLogin } from '@/utils/runtime-config'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const checking = ref(false)
const error = ref('')

const targetPath = () => {
  const from = typeof route.query.from === 'string' ? route.query.from : '/'
  return from.startsWith('/') && !from.startsWith('//') ? from : '/'
}

const checkAuth = async () => {
  checking.value = true
  error.value = ''
  try {
    const user = await authStore.hydrateSsoUser()
    if (user) {
      router.replace(targetPath())
      return
    }
    error.value = '还没有获取到钉钉授权信息。请确认已从平台统一入口访问，或完成统一认证后再检查。'
  } catch (_) {
    error.value = '授权检查失败，请稍后重试。'
  } finally {
    checking.value = false
  }
}

const openSso = () => {
  redirectToSsoLogin()
}

onMounted(() => {
  checkAuth()
})
</script>

<style scoped>
.sso-wrapper {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: linear-gradient(135deg, #2563eb, #1d4ed8);
}

.sso-panel {
  width: min(480px, 100%);
  background: #fff;
  border-radius: 8px;
  padding: 32px;
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.24);
}

.sso-title {
  font-size: 22px;
  font-weight: 800;
  color: #1f2937;
  margin-bottom: 12px;
}

.sso-copy {
  font-size: 14px;
  color: #64748b;
  line-height: 1.7;
  margin: 0 0 24px;
}

.sso-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.sso-hint {
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  background: #fff7ed;
  color: #9a3412;
  font-size: 13px;
  line-height: 1.6;
}
</style>
