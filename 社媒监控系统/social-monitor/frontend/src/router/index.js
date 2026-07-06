import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/store/auth'
import Login from '@/views/Login.vue'
import { isLocalDevAuthBypass, isSsoEnabled, redirectToSsoLogin } from '@/utils/runtime-config'

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
    path: '/monitor',
    redirect: '/'
  },
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('@/views/Layout.vue'),
    children: [
      {
        path: 'admin',
        redirect: '/admin/users'
      },
      {
        path: '',
        name: 'Home',
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
        path: 'admin/accounts',
        name: 'AdminAccounts',
        component: () => import('@/views/Admin.vue'),
        meta: { requiresPermission: 'monitor:accounts:manage' }
      },
      {
        path: 'admin/config',
        name: 'AdminConfig',
        component: () => import('@/views/AdminConfig.vue'),
        meta: { requiresPermission: 'monitor:config:write' }
      },
      {
        path: 'admin/users',
        name: 'UserManagement',
        component: () => import('@/views/UserManagement.vue'),
        meta: { requiresPermission: 'admin:users:manage' }
      },
      {
        path: 'admin/roles',
        name: 'RoleManagement',
        component: () => import('@/views/RoleManagement.vue'),
        meta: { requiresPermission: 'admin:access:manage' }
      },
      {
        path: 'admin/permissions',
        name: 'PermissionManagement',
        component: () => import('@/views/PermissionManagement.vue'),
        meta: { requiresPermission: 'admin:access:manage' }
      },
      {
        path: 'admin/workbench-permissions',
        name: 'WorkbenchPermissions',
        component: () => import('@/views/WorkbenchPermissions.vue'),
        meta: { requiresPermission: 'admin:access:manage' }
      },
      {
        path: 'admin/logs',
        name: 'SystemLogs',
        component: () => import('@/views/SystemLogs.vue'),
        meta: { requiresPermission: 'monitor:logs:view' }
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
  if (to.meta.requiresWorkbenchSuperAdmin || to.meta.requiresPermission) {
    const access = await authStore.hydrateWorkbenchAccess()
    if (to.meta.requiresWorkbenchSuperAdmin && !access?.is_super_admin) return false
    if (to.meta.requiresPermission && !authStore.hasPermission(to.meta.requiresPermission)) return false
    return true
  }
  if (to.meta.requiresAdmin && !authStore.isAdmin) return false
  return true
}

router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore()

  if (isLocalDevAuthBypass()) {
    authStore.setLocalDevAuth()
    if (to.name === 'Login' || to.name === 'SsoPending' || to.name === 'PortalEntry') {
      next({ name: 'Home' })
    } else if (!(await hasRequiredRouteAccess(to, authStore))) {
      next({ name: 'Home' })
    } else {
      next()
    }
  } else if (isSsoEnabled()) {
    if (to.name === 'Login') {
      next({
        name: 'SsoPending',
        query: authStore.ssoLoggedOut ? { logged_out: '1', from: '/' } : {}
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
            next({ name: 'Home' })
          } else {
            next()
          }
        } else if (!(await hasRequiredRouteAccess(to, authStore))) {
          next({ name: 'Home' })
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
    next({ name: 'Home' })
  } else if (!(await hasRequiredRouteAccess(to, authStore))) {
    next({ name: 'Home' })
  } else {
    next()
  }
})

export default router
