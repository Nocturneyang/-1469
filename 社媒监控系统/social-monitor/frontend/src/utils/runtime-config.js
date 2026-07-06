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

function isLocalBrowserHost() {
  return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(window.location.hostname)
}

export function isLocalDevAuthBypass() {
  const config = getRuntimeConfig()
  if (Object.prototype.hasOwnProperty.call(config, 'localDevAuthBypass')) {
    return boolValue(config.localDevAuthBypass)
  }
  return !isSsoEnabled() && isLocalBrowserHost()
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

export function buildSsoLoginUrl(options = {}) {
  const loginUrl = getSsoLoginUrl()
  if (!loginUrl) return ''

  try {
    const configuredRedirectParam = getRuntimeConfig().ssoRedirectParam || import.meta.env.VITE_SSO_REDIRECT_PARAM || ''
    return withRedirectParam(loginUrl, options.redirectTo || window.location.href, configuredRedirectParam)
  } catch (_) {
    return loginUrl
  }
}

export function buildSsoStartUrl(options = {}) {
  try {
    const url = new URL('/auth/sso/start', window.location.origin)
    url.searchParams.set('redirect', options.redirectTo || window.location.href)
    return url.toString()
  } catch (_) {
    return ''
  }
}

export function redirectToSsoLogin(options = {}) {
  if (options.viaServer !== false) {
    const startUrl = buildSsoStartUrl(options)
    if (startUrl) {
      window.location.assign(startUrl)
      return true
    }
  }

  const loginUrl = buildSsoLoginUrl(options)
  if (!loginUrl) return false

  window.location.assign(loginUrl)
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
