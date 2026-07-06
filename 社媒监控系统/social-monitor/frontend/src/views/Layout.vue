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
              @click="handleExternalNav(item)"
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
  const portalItems = []

  portalItems.push({ path: "/entry", label: "访问首页", icon: "⌂", key: "portal-entry" })
  if (portalAccess.can_workbench) {
    portalItems.push({
      href: "/workbench/",
      label: "客服工作台",
      icon: "☏",
      key: "workbench",
      portalChoice: "workbench"
    })
  }
  if (authStore.canAccessAdminShell) {
    portalItems.push({
      path: "/admin",
      label: "权限配置",
      icon: "权",
      key: "admin",
      portalChoice: "admin"
    })
  }
  if (portalItems.length) {
    sections.push({ title: "业务入口", items: portalItems })
  }

  sections.push(
    {
      title: "实时监控",
      items: [
        { path: "/monitor", label: "全盘态势", icon: "📊" },
        { path: "/monitor/feed", label: "原始数据流", icon: "💬", permission: "monitor:raw:view" },
        { path: "/monitor/analytics", label: "数据看板", icon: "📈" },
        { path: "/monitor/daily-digest", label: "日报汇总", icon: "📋" },
      ]
    },
    {
      title: "知识资产",
      items: [
        { path: "/monitor/assets", label: "资产发现", icon: "🧭" },
        { path: "/monitor/region-intelligence", label: "区域运营情报", icon: "🗺️" },
        { path: "/monitor/customer-service-intelligence", label: "客服运营情报", icon: "☏" },
        { path: "/monitor/device-tech-intelligence", label: "设备技术情报", icon: "⌘" },
        { path: "/monitor/entity-graph", label: "实体关系图谱", icon: "◎" },
        { path: "/monitor/knowledge", label: "QA 知识库", icon: "📖" },
        { path: "/monitor/devicekb", label: "设备知识库", icon: "🔧" },
        { path: "/monitor/templates", label: "内容模板库", icon: "📝" },
        { path: "/monitor/profiles", label: "供应商画像", icon: "🏷️" },
      ]
    }
  )

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
  if (path === '/monitor') return route.path === '/monitor'
  return route.path.startsWith(path)
}

const handleExternalNav = (item) => {
  if (item.portalChoice) {
    authStore.setPortalChoice(item.portalChoice)
  }
}

const titleMap = {
  '/monitor': '全盘态势 Dashboard',
  '/monitor/feed': '原始数据流 Raw Feed',
  '/monitor/analytics': '数据看板 Analytics',
  '/monitor/daily-digest': '日报汇总 Daily Digest',
  '/monitor/reports/daily': '日报详情 Daily Report',
  '/monitor/assets': '知识资产发现',
  '/monitor/region-intelligence': '区域运营情报',
  '/monitor/customer-service-intelligence': '客服运营情报',
  '/monitor/device-tech-intelligence': '设备技术情报',
  '/monitor/entity-graph': '实体关系图谱',
  '/monitor/knowledge': 'QA 知识库',
  '/monitor/profiles': '供应商画像 Supplier Profiles',
  '/monitor/devicekb': '设备知识库 Device KB',
  '/monitor/templates': '内容模板库 Templates',
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
