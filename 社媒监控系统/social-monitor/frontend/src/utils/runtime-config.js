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

export function isGuestLoginEnabled() {
  const config = getRuntimeConfig()
  return boolValue(config.guestLoginEnabled ?? import.meta.env.VITE_ALLOW_GUEST_LOGIN)
}

export function getSsoLoginUrl() {
  const config = getRuntimeConfig()
  return config.ssoLoginUrl || import.meta.env.VITE_SSO_LOGIN_URL || ''
}

export function getSsoLogoutUrl() {
  const config = getRuntimeConfig()
  return config.ssoLogoutUrl || import.meta.env.VITE_SSO_LOGOUT_URL || ''
}

function withRedirectParam(baseUrl, redirectTo, configuredParam = '') {
  const url = new URL(baseUrl, window.location.origin)
  const redirectParam = configuredParam || (url.hostname === 'skyline-ark-sso.tyhark.com' ? 'redirect' : '')
  if (redirectParam) {
    url.searchParams.set(redirectParam, redirectTo)
  }
  return url.toString()
}

export function redirectToSsoLogin(options = {}) {
  const loginUrl = getSsoLoginUrl()
  if (!loginUrl) return false

  try {
    const configuredRedirectParam = getRuntimeConfig().ssoRedirectParam || import.meta.env.VITE_SSO_REDIRECT_PARAM || ''
    window.location.assign(withRedirectParam(loginUrl, options.redirectTo || window.location.href, configuredRedirectParam))
  } catch (_) {
    window.location.assign(loginUrl)
  }

  return true
}

export function redirectToSsoLogout(options = {}) {
  const logoutUrl = getSsoLogoutUrl()
  if (!logoutUrl) return false

  try {
    const configuredRedirectParam = getRuntimeConfig().ssoLogoutRedirectParam || import.meta.env.VITE_SSO_LOGOUT_REDIRECT_PARAM || ''
    window.location.assign(withRedirectParam(logoutUrl, options.redirectTo || window.location.origin, configuredRedirectParam))
  } catch (_) {
    window.location.assign(logoutUrl)
  }

  return true
}
