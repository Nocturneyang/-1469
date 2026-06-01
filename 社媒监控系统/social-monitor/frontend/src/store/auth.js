import { defineStore } from 'pinia'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('auth_token') || null,
    user: JSON.parse(localStorage.getItem('auth_user') || 'null')
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
      if (this.user) return this.user

      const token = this.getSsoTokenFromUrl()
      const headers = {}
      if (token) headers.Authorization = `Bearer ${token}`

      const response = await fetch('/token/userinfo', {
        method: 'GET',
        credentials: 'include',
        headers
      })

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
      localStorage.setItem('auth_token', this.token)
      localStorage.setItem('auth_user', JSON.stringify(user))
      return user
    }
  }
})
