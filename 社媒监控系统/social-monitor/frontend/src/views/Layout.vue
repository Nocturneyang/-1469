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
          <router-link
            v-for="item in section.items"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ active: isActive(item.path) }"
          >
            <span class="nav-icon">{{ item.icon }}</span>
            <span>{{ item.label }}</span>
            <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
          </router-link>
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
  const sections = [
    {
      title: "实时监控",
      items: [
        { path: "/", label: "全盘态势", icon: "📊" },
        { path: "/feed", label: "原始数据流", icon: "💬", adminOnly: true },
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
  ]

  if (authStore.canAccessAdminShell) {
    sections.push({
      title: "系统管理",
      items: [
        { path: "/admin/config", label: "系统配置", icon: "⚙️", adminOnly: true },
        { path: "/admin/accounts", label: "帐号管理", icon: "👥", adminOnly: true },
        { path: "/admin/workbench-permissions", label: "工作台权限", icon: "▦", workbenchSuperOnly: true },
        { path: "/admin/users", label: "权限管理", icon: "🔐", adminOnly: true },
        { path: "/admin/logs", label: "系统日志", icon: "📋", adminOnly: true },
      ]
    })
  }

  return sections.map(section => ({
    ...section,
    items: section.items.filter(item => (
      (!item.adminOnly || authStore.isAdmin) &&
      (!item.workbenchSuperOnly || authStore.isWorkbenchSuperAdmin)
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
  '/admin/users': '权限管理 Access',
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
