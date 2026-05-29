function boolValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

export function getRuntimeConfig() {
  return window.__SOCIAL_MONITOR_CONFIG__ || {}
}

export function isSsoEnabled() {
  const config = getRuntimeConfig()
  return boolValue(config.ssoEnabled ?? import.meta.env.VITE_SSO_ENABLED)
}

export function getSsoLoginUrl() {
  const config = getRuntimeConfig()
  return config.ssoLoginUrl || import.meta.env.VITE_SSO_LOGIN_URL || ''
}

export function redirectToSsoLogin() {
  const loginUrl = getSsoLoginUrl()
  if (!loginUrl) return false

  try {
    const url = new URL(loginUrl, window.location.origin)
    url.searchParams.set('redirect_uri', window.location.href)
    window.location.assign(url.toString())
  } catch (_) {
    const separator = loginUrl.includes('?') ? '&' : '?'
    window.location.assign(`${loginUrl}${separator}redirect_uri=${encodeURIComponent(window.location.href)}`)
  }

  return true
}
