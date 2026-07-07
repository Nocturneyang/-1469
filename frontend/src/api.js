import axios from 'axios';

const SSO_HYDRATE_TTL_MS = 60 * 1000;

let runtimeConfigPromise = null;
let ssoHydratePromise = null;
let authRedirecting = false;

const api = axios.create({
  baseURL: '/api/workbench',
  timeout: 15000,
});

function boolValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getRuntimeConfig() {
  return window.__SOCIAL_MONITOR_CONFIG__ || {};
}

async function loadRuntimeConfig() {
  if (window.__SOCIAL_MONITOR_CONFIG__) return window.__SOCIAL_MONITOR_CONFIG__;
  if (runtimeConfigPromise) return runtimeConfigPromise;

  runtimeConfigPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `/runtime-config.js?v=${Date.now()}`;
    script.async = true;
    script.onload = () => resolve(getRuntimeConfig());
    script.onerror = () => resolve({});
    document.head.appendChild(script);
  }).finally(() => {
    runtimeConfigPromise = null;
  });

  return runtimeConfigPromise;
}

function isSsoEnabledFromConfig(config) {
  return boolValue(config.ssoEnabled);
}

function getSsoTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || params.get('satoken') || params.get('access_token');
  if (token) {
    window.localStorage.removeItem('sso_logged_out');
    window.localStorage.setItem('sso_token', token);
    params.delete('token');
    params.delete('satoken');
    params.delete('access_token');
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState({}, document.title, nextUrl);
  }
  return token || window.localStorage.getItem('sso_token') || '';
}

function readStoredAuthUser() {
  try {
    return JSON.parse(window.localStorage.getItem('auth_user') || 'null');
  } catch (err) {
    return null;
  }
}

function clearAuthStorage() {
  window.localStorage.removeItem('auth_token');
  window.localStorage.removeItem('auth_user');
  window.localStorage.removeItem('sso_token');
  window.localStorage.removeItem('sso_hydrated_at');
}

async function redirectToSsoLogin() {
  if (authRedirecting) return true;
  const config = await loadRuntimeConfig();
  if (!isSsoEnabledFromConfig(config)) return false;

  try {
    const url = new URL('/auth/sso/start', window.location.origin);
    url.searchParams.set('redirect', window.location.href);
    authRedirecting = true;
    window.location.assign(url.toString());
    return true;
  } catch (err) {
    return false;
  }
}

function redirectToLocalLogin() {
  if (window.location.pathname === '/login') return;
  const url = new URL('/login', window.location.origin);
  url.searchParams.set('redirect', `${window.location.pathname}${window.location.search}${window.location.hash}`);
  window.location.assign(url.toString());
}

export function isAuthRedirecting() {
  return authRedirecting;
}

export async function hydrateWorkbenchAuth(options = {}) {
  const redirectOnFailure = options.redirectOnFailure !== false;
  if (window.location.pathname === '/login' && !window.localStorage.getItem('auth_token') && !window.localStorage.getItem('sso_token')) {
    return null;
  }
  const params = new URLSearchParams(window.location.search);
  const hasTokenInUrl = params.has('token') || params.has('satoken') || params.has('access_token');
  const hydratedAt = Number(window.localStorage.getItem('sso_hydrated_at') || 0);
  const storedUser = readStoredAuthUser();
  if (!hasTokenInUrl && storedUser && Date.now() - hydratedAt < SSO_HYDRATE_TTL_MS) {
    return storedUser;
  }
  if (ssoHydratePromise) return ssoHydratePromise;

  const token = getSsoTokenFromUrl();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  ssoHydratePromise = fetch('/token/userinfo', {
    method: 'GET',
    credentials: 'include',
    headers,
  })
    .then(async (response) => {
      if (!response.ok) {
        clearAuthStorage();
        if (redirectOnFailure) redirectToLocalLogin();
        return null;
      }

      const payload = await response.json();
      const user = payload.user || payload.data;
      if (!user) {
        clearAuthStorage();
        if (redirectOnFailure) redirectToLocalLogin();
        return null;
      }

      const authToken = token || '__sso__';
      const nextHydratedAt = Date.now();
      window.localStorage.setItem('auth_token', authToken);
      window.localStorage.setItem('auth_user', JSON.stringify(user));
      window.localStorage.setItem('sso_hydrated_at', String(nextHydratedAt));
      window.localStorage.removeItem('sso_logged_out');
      return user;
    })
    .catch(async () => {
      if (redirectOnFailure) redirectToLocalLogin();
      return null;
    })
    .finally(() => {
      ssoHydratePromise = null;
    });

  return ssoHydratePromise;
}

export async function loginLocal(username, password) {
  const { data } = await axios.post('/api/auth/login', { username, password }, { timeout: 15000 });
  if (data && data.token && data.user) {
    window.localStorage.setItem('auth_token', data.token);
    window.localStorage.setItem('auth_user', JSON.stringify(data.user));
    window.localStorage.setItem('sso_hydrated_at', String(Date.now()));
  }
  return data;
}

export async function startSsoLogin() {
  return redirectToSsoLogin();
}

export function logoutLocal() {
  clearAuthStorage();
  window.location.assign('/login');
}

api.interceptors.request.use((config) => {
  const token = window.localStorage.getItem('auth_token') || '';
  const ssoToken = window.localStorage.getItem('sso_token') || '';
  const bearer = token && token !== '__sso__' ? token : ssoToken;
  config.headers = config.headers || {};
  if (bearer) config.headers.Authorization = `Bearer ${bearer}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response && error.response.status === 401) {
      clearAuthStorage();
      redirectToLocalLogin();
    }
    return Promise.reject(error);
  },
);

export async function fetchHealth() {
  const { data } = await api.get('/health');
  return data;
}

export async function fetchMe() {
  const { data } = await api.get('/me');
  return data;
}

export async function fetchAccounts() {
  const { data } = await api.get('/accounts');
  return data.accounts || [];
}

export async function fetchLabels(params = {}) {
  const { data } = await api.get('/channel-labels', { params });
  return data.labels || [];
}

export async function fetchManualGroups(params = {}) {
  const { data } = await api.get('/manual-groups', { params });
  return data.groups || [];
}

export async function createManualGroup(payload = {}) {
  const { data } = await api.post('/manual-groups', payload);
  return data.group || null;
}

export async function fetchGroups(params = {}) {
  const { data } = await api.get('/groups', { params });
  return { groups: data.groups || [], account_scope: data.account_scope || null };
}

export async function requestChannelSync(payload = {}) {
  const { data } = await api.post('/channel-sync', payload);
  return data;
}

export async function fetchMessages(group, params = {}) {
  const { data } = await api.get(`/groups/${encodeURIComponent(group.group_id)}/messages`, {
    params: {
      platform: group.platform,
      account: group.account,
      ...params,
    },
  });
  return {
    messages: data.messages || [],
    paging: data.paging || { has_more: false, before_id: null },
  };
}

export async function createReply(payload) {
  const { data } = await api.post('/reply', payload);
  return data;
}

export async function markRead(payload) {
  const { data } = await api.post('/messages/read', payload);
  return data;
}

export async function assignGroup(group, assignedTo = 'demo-operator') {
  const { data } = await api.post(`/groups/${encodeURIComponent(group.group_id)}/assign`, {
    platform: group.platform,
    account: group.account,
    assigned_to: assignedTo,
  });
  return data;
}

export async function releaseGroup(group) {
  const { data } = await api.post(`/groups/${encodeURIComponent(group.group_id)}/release`, {
    platform: group.platform,
    account: group.account,
  });
  return data;
}

export async function saveGroupManualGroups(group, manualGroupIds = []) {
  const { data } = await api.put(`/groups/${encodeURIComponent(group.group_id)}/manual-groups`, {
    platform: group.platform,
    account: group.account,
    manual_group_ids: manualGroupIds,
  });
  return data;
}

export async function retryOutbound(outboundId) {
  const { data } = await api.post(`/outbound/${outboundId}/retry`, {
    client_msg_id: createClientMsgId(),
  });
  return data;
}

export async function cancelOutbound(outboundId) {
  const { data } = await api.post(`/outbound/${outboundId}/cancel`);
  return data;
}

export async function fetchAdminAccess() {
  const { data } = await api.get('/admin/access');
  return data;
}

export async function createAdminUser(payload) {
  const { data } = await api.post('/admin/users', payload);
  return data;
}

export async function updateAdminUser(userId, payload) {
  const { data } = await api.patch(`/admin/users/${encodeURIComponent(userId)}`, payload);
  return data;
}

export async function saveAdminUserRoles(userId, roles) {
  const { data } = await api.put(`/admin/users/${encodeURIComponent(userId)}/roles`, { roles });
  return data;
}

export async function saveAdminUserPortalAccess(userId, portalAccess) {
  const { data } = await api.put(`/admin/users/${encodeURIComponent(userId)}/portal-access`, portalAccess);
  return data;
}

export async function saveAdminUserScopes(userId, scopes) {
  const { data } = await api.put(`/admin/users/${encodeURIComponent(userId)}/scopes`, { scopes });
  return data;
}

export async function saveRolePermissions(roleCode, permissions) {
  const { data } = await api.put(`/admin/roles/${encodeURIComponent(roleCode)}/permissions`, { permissions });
  return data;
}

export function createClientMsgId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
