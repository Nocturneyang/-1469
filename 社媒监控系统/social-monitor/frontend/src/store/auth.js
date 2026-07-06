import { defineStore } from 'pinia'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('auth_token') || null,
    user: JSON.parse(localStorage.getItem('auth_user') || 'null'),
    ssoHydratedAt: Number(localStorage.getItem('sso_hydrated_at') || 0),
    ssoHydratePromise: null,
    ssoLoggedOut: localStorage.getItem('sso_logged_out') === '1',
    workbenchAccess: JSON.parse(localStorage.getItem('workbench_access') || 'null'),
    workbenchAccessHydratedAt: Number(localStorage.getItem('workbench_access_hydrated_at') || 0),
    workbenchAccessPromise: null,
    portalChoice: sessionStorage.getItem('portal_choice') || ''
  }),

  getters: {
    isAuthenticated: (state) => !!state.token,
    isAdmin: (state) => state.user?.role === 'admin',
    isWorkbenchSuperAdmin: (state) => Boolean(state.workbenchAccess?.is_super_admin),
    permissions: (state) => state.workbenchAccess?.permissions || [],
    roles: (state) => state.workbenchAccess?.roles || [],
    canAccessAdminShell: (state) => state.user?.role === 'admin' ||
      Boolean(state.workbenchAccess?.is_super_admin) ||
      Boolean(state.workbenchAccess?.portal_access?.can_admin),
    hasPermission: (state) => (permission) => state.user?.role === 'admin' ||
      Boolean(state.workbenchAccess?.is_super_admin) ||
      (state.workbenchAccess?.permissions || []).includes(permission),
    portalAccess: (state) => state.workbenchAccess?.portal_access || {
      can_monitor: false,
      can_workbench: false,
      can_admin: false,
      default_entry: 'auto',
      landing: '/entry'
    },
    canAccessMonitor: (state) => Boolean(state.workbenchAccess?.portal_access?.can_monitor),
    canAccessWorkbench: (state) => Boolean(state.workbenchAccess?.portal_access?.can_workbench),
    username: (state) => state.user?.username || ''
  },

  actions: {
    setAuth(token, user) {
      this.token = token
      this.user = user
      localStorage.setItem('auth_token', token)
      localStorage.setItem('auth_user', JSON.stringify(user))
    },

    setLocalDevAuth() {
      if (this.token === '__local_dev__' && this.user?.role === 'admin') return
      this.setAuth('__local_dev__', {
        id: '1469',
        username: 'admin',
        display_name: '本地开发管理员',
        role: 'admin'
      })
    },

    logout(options = {}) {
      const manualSsoLogout = Boolean(options.manualSsoLogout)
      this.token = null
      this.user = null
      this.ssoHydratedAt = 0
      this.ssoHydratePromise = null
      this.workbenchAccessPromise = null
      localStorage.removeItem('auth_token')
      localStorage.removeItem('auth_user')
      localStorage.removeItem('sso_token')
      localStorage.removeItem('sso_hydrated_at')
      localStorage.removeItem('workbench_access')
      localStorage.removeItem('workbench_access_hydrated_at')
      sessionStorage.removeItem('portal_choice')
      this.workbenchAccess = null
      this.workbenchAccessHydratedAt = 0
      this.portalChoice = ''
      if (manualSsoLogout) {
        this.markSsoLoggedOut()
      } else {
        this.clearSsoLoggedOut()
      }
    },

    markSsoLoggedOut() {
      this.ssoLoggedOut = true
      localStorage.setItem('sso_logged_out', '1')
    },

    clearSsoLoggedOut() {
      this.ssoLoggedOut = false
      localStorage.removeItem('sso_logged_out')
    },

    setPortalChoice(choice) {
      const normalized = ['monitor', 'workbench', 'admin'].includes(choice) ? choice : ''
      this.portalChoice = normalized
      if (normalized) {
        sessionStorage.setItem('portal_choice', normalized)
      } else {
        sessionStorage.removeItem('portal_choice')
      }
    },

    getSsoTokenFromUrl() {
      const params = new URLSearchParams(window.location.search)
      const token = params.get('token') || params.get('satoken') || params.get('access_token')
      if (token) {
        this.clearSsoLoggedOut()
        localStorage.setItem('sso_token', token)
        params.delete('token')
        params.delete('satoken')
        params.delete('access_token')
        const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash}`
        window.history.replaceState({}, document.title, next)
      }
      return token || localStorage.getItem('sso_token') || ''
    },

    async hydrateSsoUser(options = {}) {
      const hasTokenInUrl = new URLSearchParams(window.location.search).has('token') ||
        new URLSearchParams(window.location.search).has('satoken') ||
        new URLSearchParams(window.location.search).has('access_token')
      if (this.ssoLoggedOut && !hasTokenInUrl && !options.force) {
        return null
      }
      const freshEnough = Date.now() - this.ssoHydratedAt < 60000
      if (!hasTokenInUrl && this.user && freshEnough) {
        return this.user
      }
      if (this.ssoHydratePromise) {
        return this.ssoHydratePromise
      }

      const token = this.getSsoTokenFromUrl()
      const headers = {}
      if (token) headers.Authorization = `Bearer ${token}`

      this.ssoHydratePromise = fetch('/token/userinfo', {
          method: 'GET',
          credentials: 'include',
          headers
        })
        .then(async (response) => {
          if (!response.ok) {
            this.logout()
            return null
          }

          const payload = await response.json()
          const user = payload.user || payload.data
          if (!user) {
            this.logout()
            return null
          }

          this.token = token || '__sso__'
          this.user = user
          this.ssoHydratedAt = Date.now()
          this.clearSsoLoggedOut()
          localStorage.setItem('auth_token', this.token)
          localStorage.setItem('auth_user', JSON.stringify(user))
          localStorage.setItem('sso_hydrated_at', String(this.ssoHydratedAt))
          return user
        })
        .finally(() => {
          this.ssoHydratePromise = null
        })

      return this.ssoHydratePromise
    },

    async hydrateWorkbenchAccess() {
      const freshEnough = Date.now() - this.workbenchAccessHydratedAt < 60000
      if (this.workbenchAccess && freshEnough) return this.workbenchAccess
      if (this.workbenchAccessPromise) return this.workbenchAccessPromise

      const headers = {}
      if (this.token && this.token !== '__sso__') headers.Authorization = `Bearer ${this.token}`

      this.workbenchAccessPromise = fetch('/api/admin/workbench-permissions/me', {
        method: 'GET',
        credentials: 'include',
        headers
      })
        .then(async (response) => {
          if (!response.ok) {
            this.workbenchAccess = { is_super_admin: false }
            this.workbenchAccessHydratedAt = Date.now()
            return this.workbenchAccess
          }
          const payload = await response.json()
          this.workbenchAccess = payload.data || { is_super_admin: false }
          this.workbenchAccessHydratedAt = Date.now()
          localStorage.setItem('workbench_access', JSON.stringify(this.workbenchAccess))
          localStorage.setItem('workbench_access_hydrated_at', String(this.workbenchAccessHydratedAt))
          return this.workbenchAccess
        })
        .finally(() => {
          this.workbenchAccessPromise = null
        })

      return this.workbenchAccessPromise
    },

    async resolvePortalDestination(requestedPath = '/', options = {}) {
      const accessPayload = await this.hydrateWorkbenchAccess()
      const portalAccess = accessPayload?.portal_access || {}
      const canMonitor = Boolean(portalAccess.can_monitor)
      const canWorkbench = Boolean(portalAccess.can_workbench)
      const canAdmin = Boolean(portalAccess.can_admin)
      const landing = portalAccess.landing || '/entry'
      const defaultEntry = portalAccess.default_entry || 'auto'
      const preferLanding = Boolean(options.preferLanding)
      const portalChoice = this.portalChoice || sessionStorage.getItem('portal_choice') || ''
      const requested = typeof requestedPath === 'string' && requestedPath.startsWith('/') && !requestedPath.startsWith('//')
        ? requestedPath
        : '/'

      const landingDestination = () => {
        if (landing === '/workbench/' || landing === '/workbench') return '/workbench/'
        if (landing === '/admin/users' || landing === '/admin') return '/admin/users'
        if (landing === '/') return '/'
        const allowedCount = [canMonitor, canWorkbench, canAdmin].filter(Boolean).length
        if (allowedCount > 1) return '/entry'
        if (canAdmin) return '/admin/users'
        if (canWorkbench) return '/workbench/'
        if (canMonitor) return '/'
        return '/entry'
      }

      if (preferLanding && !portalChoice && (defaultEntry !== 'auto' || [canMonitor, canWorkbench, canAdmin].filter(Boolean).length > 1)) {
        return landingDestination()
      }
      if (requested.startsWith('/workbench')) return canWorkbench ? requested : (canMonitor ? '/' : '/entry')
      if (requested.startsWith('/admin')) return canAdmin ? requested : (canMonitor ? '/' : '/entry')
      if (requested === '/' && portalChoice === 'monitor' && canMonitor) return '/'
      if (requested !== '/' && requested !== '/entry') {
        if (canMonitor) return requested
        if (canWorkbench) return '/workbench/'
      }
      return landingDestination()
    }
  }
})
