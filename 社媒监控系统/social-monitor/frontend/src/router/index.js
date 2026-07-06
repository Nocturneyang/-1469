import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/store/auth'
import Login from '@/views/Login.vue'
import { isLocalDevAuthBypass, isSsoEnabled, redirectToSsoLogin } from '@/utils/runtime-config'

const monitorChildren = [
  {
    path: '',
    name: 'MonitorHome',
    component: () => import('@/views/Home.vue')
  },
  {
    path: 'analytics',
    name: 'Analytics',
    component: () => import('@/views/Analytics.vue')
  },
  {
    path: 'feed',
    name: 'Feed',
    component: () => import('@/views/Feed.vue'),
    meta: { requiresPermission: 'monitor:raw:view' }
  },
  {
    path: 'knowledge',
    name: 'KnowledgeBase',
    component: () => import('@/views/KnowledgeBase.vue')
  },
  {
    path: 'assets',
    name: 'KnowledgeAssets',
    component: () => import('@/views/KnowledgeAssets.vue')
  },
  {
    path: 'region-intelligence',
    name: 'RegionIntelligence',
    component: () => import('@/views/RegionIntelligence.vue')
  },
  {
    path: 'customer-service-intelligence',
    name: 'CustomerServiceIntelligence',
    component: () => import('@/views/DomainIntelligence.vue'),
    meta: { domainKind: 'customer_service' }
  },
  {
    path: 'device-tech-intelligence',
    name: 'DeviceTechIntelligence',
    component: () => import('@/views/DomainIntelligence.vue'),
    meta: { domainKind: 'device_tech' }
  },
  {
    path: 'entity-graph',
    name: 'EntityGraph',
    component: () => import('@/views/EntityGraph.vue')
  },
  {
    path: 'profiles',
    name: 'SupplierProfiles',
    component: () => import('@/views/SupplierProfiles.vue')
  },
  {
    path: 'devicekb',
    name: 'DeviceKB',
    component: () => import('@/views/DeviceKB.vue')
  },
  {
    path: 'templates',
    name: 'ContentTemplates',
    component: () => import('@/views/ContentTemplates.vue')
  },
  {
    path: 'daily-digest',
    name: 'DailyDigest',
    component: () => import('@/views/DailyDigest.vue')
  },
  {
    path: 'reports/daily',
    name: 'DailyReport',
    component: () => import('@/views/DailyDigest.vue')
  }
]

const legacyMonitorRedirects = [
  '/analytics',
  '/feed',
  '/knowledge',
  '/assets',
  '/region-intelligence',
  '/customer-service-intelligence',
  '/device-tech-intelligence',
  '/entity-graph',
  '/profiles',
  '/devicekb',
  '/templates',
  '/daily-digest',
  '/reports/daily'
].map((path) => ({
  path,
  redirect: `/monitor${path}`
}))

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: Login,
    meta: { public: true }
  },
  {
    path: '/sso-pending',
    name: 'SsoPending',
    component: () => import('@/views/SsoPending.vue'),
    meta: { public: true }
  },
  {
    path: '/entry',
    name: 'PortalEntry',
    component: () => import('@/views/PortalEntry.vue')
  },
  {
    path: '/admin',
    name: 'AdminShell',
    component: () => import('@/views/AdminLayout.vue'),
    meta: { requiresAdminPortal: true },
    children: [
      {
        path: '',
        name: 'AdminLanding',
        component: () => import('@/views/AdminLanding.vue')
      },
      {
        path: 'users',
        name: 'UserManagement',
        component: () => import('@/views/UserManagement.vue'),
        meta: { requiresPermission: 'admin:users:manage' }
      },
      {
        path: 'roles',
        name: 'RoleManagement',
        component: () => import('@/views/RoleManagement.vue'),
        meta: { requiresPermission: 'admin:access:manage' }
      },
      {
        path: 'permissions',
        name: 'PermissionManagement',
        component: () => import('@/views/PermissionManagement.vue'),
        meta: { requiresPermission: 'admin:access:manage' }
      },
      {
        path: 'workbench-permissions',
        name: 'WorkbenchPermissions',
        component: () => import('@/views/WorkbenchPermissions.vue'),
        meta: { requiresPermission: 'admin:access:manage' }
      },
      {
        path: 'accounts',
        name: 'AdminAccounts',
        component: () => import('@/views/Admin.vue'),
        meta: { requiresPermission: 'monitor:accounts:manage' }
      },
      {
        path: 'config',
        name: 'AdminConfig',
        component: () => import('@/views/AdminConfig.vue'),
        meta: { requiresPermission: 'monitor:config:write' }
      },
      {
        path: 'logs',
        name: 'SystemLogs',
        component: () => import('@/views/SystemLogs.vue'),
        meta: { requiresPermission: 'monitor:logs:view' }
      }
    ]
  },
  {
    path: '/',
    redirect: '/monitor'
  },
  ...legacyMonitorRedirects,
  {
    path: '/monitor',
    name: 'MonitorShell',
    component: () => import('@/views/Layout.vue'),
    meta: { requiresMonitorPortal: true },
    children: monitorChildren
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

function hasSsoTokenQuery(to) {
  return ['token', 'satoken', 'access_token'].some((key) => Object.prototype.hasOwnProperty.call(to.query || {}, key))
}

function portalRequestedPath(to) {
  const params = new URLSearchParams()
  Object.entries(to.query || {}).forEach(([key, value]) => {
    if (['token', 'satoken', 'access_token'].includes(key)) return
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item != null) params.append(key, item)
      })
    } else if (value != null) {
      params.set(key, value)
    }
  })
  const query = params.toString()
  return `${to.path}${query ? `?${query}` : ''}${to.hash || ''}`
}

function redirectToPortalDestination(destination, currentPath, next) {
  if (destination === currentPath) {
    return false
  }
  if (destination.startsWith('/workbench')) {
    window.location.assign(destination)
    return true
  }
  next(destination)
  return true
}

async function hasRequiredRouteAccess(to, authStore) {
  if (
    to.meta.requiresAdminPortal ||
    to.meta.requiresMonitorPortal ||
    to.meta.requiresWorkbenchSuperAdmin ||
    to.meta.requiresPermission
  ) {
    const access = await authStore.hydrateWorkbenchAccess()
    if (to.meta.requiresAdminPortal && !authStore.canAccessAdminShell) return false
    if (
      to.meta.requiresMonitorPortal &&
      !authStore.canAccessMonitor &&
      !authStore.isAdmin &&
      !access?.is_super_admin
    ) {
      return false
    }
    if (to.meta.requiresWorkbenchSuperAdmin && !access?.is_super_admin) return false
    if (to.meta.requiresPermission && !authStore.hasPermission(to.meta.requiresPermission)) return false
    return true
  }
  if (to.meta.requiresAdmin && !authStore.isAdmin) return false
  return true
}

function accessFallbackTarget(to, authStore) {
  if (to.path.startsWith('/admin') && to.name !== 'AdminLanding' && authStore.canAccessAdminShell) {
    return { name: 'AdminLanding' }
  }
  if ((authStore.canAccessMonitor || authStore.isAdmin) && to.name !== 'MonitorHome') {
    return { name: 'MonitorHome' }
  }
  if (authStore.canAccessWorkbench) return '/workbench/'
  return { name: 'PortalEntry' }
}

function redirectToAccessFallback(to, authStore, next) {
  const target = accessFallbackTarget(to, authStore)
  if (typeof target === 'string' && target.startsWith('/workbench')) {
    window.location.assign(target)
    return
  }
  next(target)
}

router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore()

  if (isLocalDevAuthBypass()) {
    authStore.setLocalDevAuth()
    if (to.name === 'Login' || to.name === 'SsoPending') {
      next({ name: 'PortalEntry' })
    } else if (!(await hasRequiredRouteAccess(to, authStore))) {
      redirectToAccessFallback(to, authStore, next)
    } else {
      next()
    }
  } else if (isSsoEnabled()) {
    if (to.name === 'Login') {
      next({
        name: 'SsoPending',
        query: authStore.ssoLoggedOut ? { logged_out: '1', from: '/entry' } : {}
      })
    } else if (to.name === 'SsoPending') {
      next()
    } else {
      if (authStore.ssoLoggedOut && !hasSsoTokenQuery(to)) {
        return next({ name: 'SsoPending', query: { logged_out: '1', from: to.fullPath } })
      }
      try {
        const freshSsoLogin = hasSsoTokenQuery(to) || !authStore.user
        const user = await authStore.hydrateSsoUser()
        if (!user) {
          if (redirectToSsoLogin({ redirectTo: `${window.location.origin}${to.fullPath || '/entry'}` })) return
          next({ name: 'SsoPending', query: { from: to.fullPath } })
        } else if (to.name !== 'PortalEntry') {
          const requestedPath = portalRequestedPath(to)
          const destination = await authStore.resolvePortalDestination(requestedPath, { preferLanding: freshSsoLogin })
          if (redirectToPortalDestination(destination, requestedPath, next)) return
          if (!(await hasRequiredRouteAccess(to, authStore))) {
            redirectToAccessFallback(to, authStore, next)
          } else {
            next()
          }
        } else if (!(await hasRequiredRouteAccess(to, authStore))) {
          redirectToAccessFallback(to, authStore, next)
        } else {
          next()
        }
      } catch (_) {
        if (redirectToSsoLogin({ redirectTo: `${window.location.origin}${to.fullPath || '/entry'}` })) return
        next({ name: 'SsoPending', query: { from: to.fullPath } })
      }
    }
  } else if (!to.meta.public && !authStore.isAuthenticated) {
    next({ name: 'Login' })
  } else if (to.name === 'Login' && authStore.isAuthenticated) {
    next({ name: 'PortalEntry' })
  } else if (!(await hasRequiredRouteAccess(to, authStore))) {
    redirectToAccessFallback(to, authStore, next)
  } else {
    next()
  }
})

export default router
