<template>
  <div class="admin-landing">
    <div class="panel">
      <div class="panel-title">权限配置</div>
      <p v-if="loading" class="landing-text">正在进入可访问的权限配置页面...</p>
      <p v-else class="landing-text">当前账号没有可访问的权限配置项，请联系超级管理员调整角色或入口权限。</p>
      <router-link class="landing-link" to="/entry">返回访问首页</router-link>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/store/auth'

const router = useRouter()
const authStore = useAuthStore()
const loading = ref(true)

const destinations = [
  { path: '/admin/users', permission: 'admin:users:manage' },
  { path: '/admin/roles', permission: 'admin:access:manage' },
  { path: '/admin/permissions', permission: 'admin:access:manage' },
  { path: '/admin/workbench-permissions', permission: 'admin:access:manage' },
  { path: '/admin/config', permission: 'monitor:config:write' },
  { path: '/admin/accounts', permission: 'monitor:accounts:manage' },
  { path: '/admin/logs', permission: 'monitor:logs:view' }
]

onMounted(async () => {
  await authStore.hydrateWorkbenchAccess().catch(() => {})
  const target = destinations.find((item) => authStore.hasPermission(item.permission))
  if (target) {
    router.replace(target.path)
    return
  }
  loading.value = false
})
</script>

<style scoped>
.admin-landing {
  min-height: 360px;
  display: grid;
  place-items: center;
}

.landing-text {
  margin: 10px 0 18px;
  color: var(--t3);
  font-size: 14px;
}

.landing-link {
  color: #0f766e;
  font-size: 14px;
  font-weight: 700;
  text-decoration: none;
}
</style>
