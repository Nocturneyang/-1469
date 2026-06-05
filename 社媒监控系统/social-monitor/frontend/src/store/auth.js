import { defineStore } from 'pinia'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('auth_token') || null,
    user: JSON.parse(localStorage.getItem('auth_user') || 'null'),
    ssoHydratedAt: Number(localStorage.getItem('sso_hydrated_at') || 0),
    ssoHydratePromise: null
  }),

  getters: {
    isAuthenticated: (state) => !!state.token,
    isAdmin: (state) => state.user?.role === 'admin',
    username: (state) => state.user?.username || ''
  },

  actions: {
    setAuth(token, user) {
      this.token = token
      this.user = user
      localStorage.setItem('auth_token', token)
      localStorage.setItem('auth_user', JSON.stringify(user))
    },

    logout() {
      this.token = null
      this.user = null
      localStorage.removeItem('auth_token')
      localStorage.removeItem('auth_user')
      localStorage.removeItem('sso_token')
      localStorage.removeItem('sso_hydrated_at')
    },

    getSsoTokenFromUrl() {
      const params = new URLSearchParams(window.location.search)
      const token = params.get('token') || params.get('satoken') || params.get('access_token')
      if (token) {
        localStorage.setItem('sso_token', token)
        params.delete('token')
        params.delete('satoken')
        params.delete('access_token')
        const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash}`
        window.history.replaceState({}, document.title, next)
      }
      return token || localStorage.getItem('sso_token') || ''
    },

    async hydrateSsoUser() {
      const hasTokenInUrl = new URLSearchParams(window.location.search).has('token') ||
        new URLSearchParams(window.location.search).has('satoken') ||
        new URLSearchParams(window.location.search).has('access_token')
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
          localStorage.setItem('auth_token', this.token)
          localStorage.setItem('auth_user', JSON.stringify(user))
          localStorage.setItem('sso_hydrated_at', String(this.ssoHydratedAt))
          return user
        })
        .finally(() => {
          this.ssoHydratePromise = null
        })

      return this.ssoHydratePromise
    }
  }
})
