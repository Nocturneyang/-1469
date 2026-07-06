<template>
  <div class="app-layout admin-layout">
    <aside class="sidebar admin-sidebar">
      <div class="brand">
        <div class="glyph">权</div>
        <div class="brand-text">
          <span class="brand-name">权限配置</span>
          <span class="brand-tagline">Access Control</span>
        </div>
      </div>

      <nav class="nav">
        <template v-for="section in navSections" :key="section.title">
          <div class="nav-section">{{ section.title }}</div>
          <template v-for="item in section.items" :key="item.key || item.path || item.href">
            <a
              v-if="item.href"
              :href="item.href"
              class="nav-item"
              @click="handleNavChoice(item)"
            >
              <span class="nav-icon">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
            </a>
            <router-link
              v-else
              :to="item.path"
              class="nav-item"
              :class="{ active: isActive(item.path) }"
              @click="handleNavChoice(item)"
            >
              <span class="nav-icon">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
            </router-link>
          </template>
        </template>
      </nav>

      <div class="sidebar-footer">
        <div class="user-badge" @click="handleLogout">
          <span class="user-avatar">{{ authStore.username.charAt(0).toUpperCase() }}</span>
          <span class="user-name">{{ authStore.username }}</span>
          <span class="logout">退出</span>
        </div>
      </div>
    </aside>

    <main class="main admin-main">
      <header class="header admin-header">
        <div>
          <div class="header-kicker">Unified Portal</div>
          <div class="header-title">{{ pageTitle }}</div>
        </div>
        <div class="header-actions">
          <router-link class="admin-quick-link" to="/entry" @click="authStore.setPortalChoice('')">
            访问首页
          </router-link>
          <span class="status-pill"><span class="pulse"></span> 权限服务在线</span>
        </div>
      </header>

      <div class="content admin-content">
        <router-view v-slot="{ Component }">
          <transition name="view-fade" mode="out-in">
            <component :is="Component" class="view-enter" />
          </transition>
        </router-view>
      </div>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/store/auth'
import { isSsoEnabled } from '@/utils/runtime-config'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const navSections = computed(() => {
  const portalAccess = authStore.portalAccess || {}
  const sections = [
    {
      title: '访问入口',
      items: [
        { path: '/entry', label: '访问首页', icon: '⌂', key: 'entry' },
        portalAccess.can_monitor
          ? { path: '/monitor', label: '监控系统', icon: '监', key: 'monitor', portalChoice: 'monitor' }
          : null,
        portalAccess.can_workbench
          ? { href: '/workbench/', label: '客服工作台', icon: '客', key: 'workbench', portalChoice: 'workbench' }
          : null
      ].filter(Boolean)
    },
    {
      title: '权限配置',
      items: [
        { path: '/admin/users', label: '用户管理', icon: '用', permission: 'admin:users:manage' },
        { path: '/admin/roles', label: '角色管理', icon: '角', permission: 'admin:access:manage' },
        { path: '/admin/permissions', label: '权限项', icon: '权', permission: 'admin:access:manage' },
        { path: '/admin/workbench-permissions', label: '数据范围', icon: '域', permission: 'admin:access:manage' }
      ]
    },
    {
      title: '监控运维',
      items: [
        { path: '/admin/config', label: '系统配置', icon: '设', permission: 'monitor:config:write' },
        { path: '/admin/accounts', label: '帐号管理', icon: '号', permission: 'monitor:accounts:manage' },
        { path: '/admin/logs', label: '系统日志', icon: '志', permission: 'monitor:logs:view' }
      ]
    }
  ]

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.permission || authStore.hasPermission(item.permission))
    }))
    .filter((section) => section.items.length)
})

const titleMap = {
  '/admin': '权限配置',
  '/admin/users': '用户管理',
  '/admin/roles': '角色管理',
  '/admin/permissions': '权限项管理',
  '/admin/workbench-permissions': '数据范围配置',
  '/admin/config': '系统配置',
  '/admin/accounts': '帐号管理',
  '/admin/logs': '系统日志'
}

const pageTitle = computed(() => titleMap[route.path] || '权限配置')

onMounted(() => {
  if (authStore.isAuthenticated) {
    authStore.hydrateWorkbenchAccess().catch(() => {})
  }
})

function isActive(path) {
  if (path === '/admin') return route.path === '/admin'
  return route.path === path || route.path.startsWith(`${path}/`)
}

function handleNavChoice(item) {
  authStore.setPortalChoice(item.portalChoice || '')
}

function handleLogout() {
  if (isSsoEnabled()) {
    const loggedOutPath = `/sso-pending?logged_out=1&from=${encodeURIComponent('/entry')}`
    const loggedOutUrl = `${window.location.origin}${loggedOutPath}`
    const logoutUrl = new URL('/auth/sso/logout', window.location.origin)
    logoutUrl.searchParams.set('redirect', loggedOutUrl)
    authStore.logout({ manualSsoLogout: true })
    window.location.assign(logoutUrl.toString())
    return
  }
  authStore.logout()
  router.push('/login')
}
</script>

<style scoped>
.admin-layout {
  --p: #0f766e;
  --p-tint: rgba(15, 118, 110, 0.11);
}

.admin-sidebar {
  background: linear-gradient(180deg, #f7fbfa 0%, #eef6f3 100%);
}

.admin-sidebar .brand .glyph {
  border-radius: 8px;
  background: #0f766e;
  color: #fff;
  font-size: 17px;
  font-weight: 800;
}

.header-kicker {
  margin-bottom: 2px;
  color: var(--t3);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.admin-header {
  background: rgba(248, 250, 252, 0.92);
}

.admin-content {
  background: #f8fafc;
}

.admin-quick-link {
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  color: #0f766e;
  background: #fff;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
}

.admin-quick-link:hover {
  border-color: rgba(15, 118, 110, 0.28);
  background: #ecfdf5;
}
</style>
