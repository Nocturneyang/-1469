<template>
  <div class="app-layout">
    <!-- 侧边栏 -->
    <aside class="sidebar">
      <div class="brand">
        <div class="glyph">🔮</div>
        <div class="brand-text">
          <span class="brand-name">Social Monitor</span>
          <span class="brand-tagline">Data Pipeline</span>
        </div>
      </div>
      <nav class="nav">
        <template v-for="(section, i) in navSections" :key="i">
          <div class="nav-section">{{ section.title }}</div>
          <template v-for="item in section.items" :key="item.key || item.path || item.href">
            <a
              v-if="item.href"
              :href="item.href"
              class="nav-item"
              @click="handleExternalNav(item)"
            >
              <span class="nav-icon">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
              <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
            </a>
            <router-link
              v-else
              :to="item.path"
              class="nav-item"
              :class="{ active: isActive(item.path) }"
            >
              <span class="nav-icon">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
              <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
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

    <!-- 主内容区 -->
    <main class="main">
      <header class="header">
        <div class="header-title">{{ pageTitle }}</div>
        <div class="header-actions">
          <span class="status-pill"><span class="pulse"></span> API Server 在线守护</span>
        </div>
      </header>

      <div class="content">
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
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/store/auth'
import { isSsoEnabled } from '@/utils/runtime-config'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const navSections = computed(() => {
  const sections = []
  const portalAccess = authStore.portalAccess || {}
  const portalCount = [
    portalAccess.can_monitor,
    portalAccess.can_workbench,
    portalAccess.can_admin
  ].filter(Boolean).length
  const portalItems = []

  if (portalCount > 1) {
    portalItems.push({ path: "/entry", label: "入口选择", icon: "↔", key: "portal-entry" })
  }
  if (portalAccess.can_workbench) {
    portalItems.push({
      href: "/workbench/",
      label: "客服工作台",
      icon: "☏",
      key: "workbench",
      portalChoice: "workbench"
    })
  }
  if (portalItems.length) {
    sections.push({ title: "业务入口", items: portalItems })
  }

  sections.push(
    {
      title: "实时监控",
      items: [
        { path: "/", label: "全盘态势", icon: "📊" },
        { path: "/feed", label: "原始数据流", icon: "💬", permission: "monitor:raw:view" },
        { path: "/analytics", label: "数据看板", icon: "📈" },
        { path: "/daily-digest", label: "日报汇总", icon: "📋" },
      ]
    },
    {
      title: "知识资产",
      items: [
        { path: "/assets", label: "资产发现", icon: "🧭" },
        { path: "/region-intelligence", label: "区域运营情报", icon: "🗺️" },
        { path: "/customer-service-intelligence", label: "客服运营情报", icon: "☏" },
        { path: "/device-tech-intelligence", label: "设备技术情报", icon: "⌘" },
        { path: "/entity-graph", label: "实体关系图谱", icon: "◎" },
        { path: "/knowledge", label: "QA 知识库", icon: "📖" },
        { path: "/devicekb", label: "设备知识库", icon: "🔧" },
        { path: "/templates", label: "内容模板库", icon: "📝" },
        { path: "/profiles", label: "供应商画像", icon: "🏷️" },
      ]
    }
  )

  if (authStore.canAccessAdminShell) {
    sections.push({
      title: "系统管理",
      items: [
        { path: "/admin/config", label: "系统配置", icon: "⚙️", permission: "monitor:config:write" },
        { path: "/admin/accounts", label: "帐号管理", icon: "👥", permission: "monitor:accounts:manage" },
        { path: "/admin/users", label: "用户管理", icon: "🔐", permission: "admin:users:manage" },
        { path: "/admin/roles", label: "角色管理", icon: "▣", permission: "admin:access:manage" },
        { path: "/admin/permissions", label: "权限项", icon: "☷", permission: "admin:access:manage" },
        { path: "/admin/workbench-permissions", label: "数据范围", icon: "▦", permission: "admin:access:manage" },
        { path: "/admin/logs", label: "系统日志", icon: "📋", permission: "monitor:logs:view" },
      ]
    })
  }

  return sections.map(section => ({
    ...section,
    items: section.items.filter(item => (
      (!item.adminOnly || authStore.isAdmin) &&
      (!item.workbenchSuperOnly || authStore.isWorkbenchSuperAdmin) &&
      (!item.permission || authStore.hasPermission(item.permission))
    ))
  }))
})

onMounted(() => {
  if (authStore.isAuthenticated) {
    authStore.hydrateWorkbenchAccess().catch(() => {})
  }
})

const isActive = (path) => {
  if (path === '/') return route.path === '/'
  return route.path.startsWith(path)
}

const handleExternalNav = (item) => {
  if (item.portalChoice) {
    authStore.setPortalChoice(item.portalChoice)
  }
}

const titleMap = {
  '/': '全盘态势 Dashboard',
  '/feed': '原始数据流 Raw Feed',
  '/analytics': '数据看板 Analytics',
  '/daily-digest': '日报汇总 Daily Digest',
  '/reports/daily': '日报详情 Daily Report',
  '/assets': '知识资产发现',
  '/region-intelligence': '区域运营情报',
  '/customer-service-intelligence': '客服运营情报',
  '/device-tech-intelligence': '设备技术情报',
  '/entity-graph': '实体关系图谱',
  '/admin/accounts': '帐号管理 Accounts',
  '/admin/config': '系统配置 Config',
  '/admin/workbench-permissions': '工作台权限 Workbench Access',
  '/admin/users': '用户管理 Users',
  '/admin/roles': '角色管理 Roles',
  '/admin/permissions': '权限项 Permissions',
  '/knowledge': 'QA 知识库',
  '/profiles': '供应商画像 Supplier Profiles',
  '/devicekb': '设备知识库 Device KB',
  '/templates': '内容模板库 Templates',
}

const pageTitle = computed(() => titleMap[route.path] || 'Dashboard')

const handleLogout = () => {
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
/* Styles now use global style.css */
</style>
