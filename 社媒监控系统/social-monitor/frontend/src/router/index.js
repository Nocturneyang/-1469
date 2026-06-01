import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/store/auth'
import Login from '@/views/Login.vue'
import { isSsoEnabled } from '@/utils/runtime-config'

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
    path: '/',
    name: 'Dashboard',
    component: () => import('@/views/Layout.vue'),
    children: [
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
        component: () => import('@/views/Feed.vue')
      },
      {
        path: 'admin/accounts',
        name: 'AdminAccounts',
        component: () => import('@/views/Admin.vue'),
        meta: { requiresAdmin: true }
      },
      {
        path: 'admin/config',
        name: 'AdminConfig',
        component: () => import('@/views/AdminConfig.vue')
      },
      {
        path: 'admin/users',
        name: 'UserManagement',
        component: () => import('@/views/UserManagement.vue'),
        meta: { requiresAdmin: true }
      },
      {
        path: 'admin/logs',
        name: 'SystemLogs',
        component: () => import('@/views/SystemLogs.vue'),
        meta: { requiresAdmin: true }
      },
      {
        path: 'knowledge',
        name: 'KnowledgeBase',
        component: () => import('@/views/KnowledgeBase.vue')
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
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore()

  if (isSsoEnabled()) {
    if (to.name === 'Login') {
      next({ name: 'SsoPending' })
    } else if (to.name === 'SsoPending') {
      next()
    } else {
      try {
        const user = await authStore.hydrateSsoUser()
        if (!user) {
          next({ name: 'SsoPending', query: { from: to.fullPath } })
        } else if (to.meta.requiresAdmin && authStore.user?.role !== 'admin') {
          next({ name: 'Home' })
        } else {
          next()
        }
      } catch (_) {
        next({ name: 'SsoPending', query: { from: to.fullPath } })
      }
    }
  } else if (!to.meta.public && !authStore.isAuthenticated) {
    next({ name: 'Login' })
  } else if (to.name === 'Login' && authStore.isAuthenticated) {
    next({ name: 'Home' })
  } else if (to.meta.requiresAdmin && !authStore.isAdmin) {
    next({ name: 'Home' })
  } else {
    next()
  }
})

export default router
