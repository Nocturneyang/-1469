import axios from 'axios';

let runtimeConfigPromise = null;
let ssoHydratePromise = null;
let authRedirecting = false;

const api = axios.create({
  baseURL: '/api/workbench',
  timeout: 15000,
  withCredentials: true,
});

function boolValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getRuntimeConfig() {
  return window.__SOCIAL_WORKBENCH_CONFIG__ || window.__WORKBENCH_CONFIG__ || window.__SOCIAL_MONITOR_CONFIG__ || {};
}

async function loadRuntimeConfig() {
  if (window.__SOCIAL_WORKBENCH_CONFIG__ || window.__WORKBENCH_CONFIG__ || window.__SOCIAL_MONITOR_CONFIG__) {
    return getRuntimeConfig();
  }
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

function clearAuthStorage() {
  // Remove tokens produced by releases before server-side HttpOnly sessions.
  window.localStorage.removeItem('auth_token');
  window.localStorage.removeItem('auth_user');
  window.localStorage.removeItem('sso_token');
  window.localStorage.removeItem('sso_hydrated_at');
}

export function logoutSso() {
  clearAuthStorage();
  const url = new URL('/auth/sso/logout', window.location.origin);
  url.searchParams.set('redirect', `${window.location.origin}/`);
  window.location.assign(url.toString());
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

async function redirectToSsoOrHome() {
  const redirected = await redirectToSsoLogin();
  if (!redirected && window.location.pathname !== '/') {
    window.location.assign('/');
  }
}

export function isAuthRedirecting() {
  return authRedirecting;
}

export async function hydrateWorkbenchAuth(options = {}) {
  const redirectOnFailure = options.redirectOnFailure !== false;
  if (ssoHydratePromise) return ssoHydratePromise;
  clearAuthStorage();

  ssoHydratePromise = fetch('/token/userinfo', {
    method: 'GET',
    credentials: 'include',
  })
    .then(async (response) => {
      if (!response.ok) {
        clearAuthStorage();
        if (redirectOnFailure) await redirectToSsoOrHome();
        return null;
      }

      const payload = await response.json();
      const user = payload.user || payload.data;
      if (!user) {
        clearAuthStorage();
        if (redirectOnFailure) await redirectToSsoOrHome();
        return null;
      }

      window.localStorage.removeItem('sso_logged_out');
      return user;
    })
    .catch(async () => {
      if (redirectOnFailure) await redirectToSsoOrHome();
      return null;
    })
    .finally(() => {
      ssoHydratePromise = null;
    });

  return ssoHydratePromise;
}

api.interceptors.request.use((config) => {
  config.headers = config.headers || {};
  const csrfToken = readCookie('workbench_csrf');
  if (csrfToken && !['get', 'head', 'options'].includes(String(config.method || 'get').toLowerCase())) {
    config.headers['X-CSRF-Token'] = csrfToken;
  }
  return config;
});

function readCookie(name) {
  for (const part of String(document.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error.response && error.response.status;
    const detail = String(error.response?.data?.error || '');
    const invalidAuth = status === 401 || (
      status === 403 && /Forbidden \(Token invalid or expired\)/i.test(detail)
    );
    if (invalidAuth) {
      clearAuthStorage();
      await redirectToSsoOrHome();
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

export async function fetchCustomerTypes(platform, account, { admin = false } = {}) {
  const prefix = admin ? '/admin/accounts' : '/accounts';
  const { data } = await api.get(`${prefix}/${encodeURIComponent(platform)}/${encodeURIComponent(account)}/customer-types`);
  return data.options || [];
}

export async function updateServiceAccountSettings(platform, account, payload) {
  const { data } = await api.patch(`/admin/accounts/${encodeURIComponent(platform)}/${encodeURIComponent(account)}/settings`, payload);
  return data.settings;
}

export async function releaseServiceAccountBreaker(platform, account) {
  const { data } = await api.post(`/admin/accounts/${encodeURIComponent(platform)}/${encodeURIComponent(account)}/send-breaker/release`);
  return data;
}

export async function createCustomerType(platform, account, payload) {
  const { data } = await api.post(`/admin/accounts/${encodeURIComponent(platform)}/${encodeURIComponent(account)}/customer-types`, payload);
  return data.option;
}

export async function updateCustomerType(platform, account, id, payload) {
  const { data } = await api.patch(`/admin/accounts/${encodeURIComponent(platform)}/${encodeURIComponent(account)}/customer-types/${encodeURIComponent(id)}`, payload);
  return data.option;
}

export async function disableCustomerType(platform, account, id) {
  const { data } = await api.delete(`/admin/accounts/${encodeURIComponent(platform)}/${encodeURIComponent(account)}/customer-types/${encodeURIComponent(id)}`);
  return data.option;
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

export async function fetchServiceAccountLoginRequests(params = {}) {
  const { data } = await api.get('/service-account-logins', { params });
  return data.requests || [];
}

export async function createServiceAccountLoginRequest(payload = {}) {
  const { data } = await api.post('/service-account-logins', payload);
  return data.request;
}

export async function verifyServiceAccountLoginRequest(requestId, payload = {}) {
  const { data } = await api.post(`/service-account-logins/${encodeURIComponent(requestId)}/verify`, payload);
  return data.request;
}

export async function deleteServiceAccountLoginRequest(requestId) {
  const { data } = await api.delete(`/service-account-logins/${encodeURIComponent(requestId)}`);
  return data.request;
}

export async function deleteServiceAccount(platform, account) {
  const { data } = await api.delete(`/accounts/${encodeURIComponent(platform)}/${encodeURIComponent(account)}`);
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

export async function fetchGroupWorkspace(group) {
  const { data } = await api.get(`/groups/${encodeURIComponent(group.group_id)}/workspace`, {
    params: {
      platform: group.platform,
      account: group.account,
    },
  });
  return {
    profile: data.profile || null,
    notes: data.notes || [],
    timeline: data.timeline || [],
    presence: data.presence || [],
    notes_paging: data.notes_paging || { has_more: false, before_id: null },
    timeline_paging: data.timeline_paging || { has_more: false, before_id: null },
  };
}

export async function fetchGroupNotes(group, params = {}) {
  const { data } = await api.get(`/groups/${encodeURIComponent(group.group_id)}/notes`, {
    params: { platform: group.platform, account: group.account, ...params },
  });
  return { notes: data.notes || [], paging: data.paging || { has_more: false, before_id: null } };
}

export async function fetchGroupTimeline(group, params = {}) {
  const { data } = await api.get(`/groups/${encodeURIComponent(group.group_id)}/timeline`, {
    params: { platform: group.platform, account: group.account, ...params },
  });
  return { timeline: data.timeline || [], paging: data.paging || { has_more: false, before_id: null } };
}

export async function saveGroupWorkspace(group, payload = {}) {
  const { data } = await api.patch(`/groups/${encodeURIComponent(group.group_id)}/workspace`, {
    platform: group.platform,
    account: group.account,
    ...payload,
  });
  return data.profile || null;
}

export async function createGroupNote(group, body) {
  const { data } = await api.post(`/groups/${encodeURIComponent(group.group_id)}/notes`, {
    platform: group.platform,
    account: group.account,
    body,
  });
  return data.note || null;
}

export async function updateGroupPresence(group, mode = 'viewing', active = true) {
  const { data } = await api.post(`/groups/${encodeURIComponent(group.group_id)}/presence`, {
    platform: group.platform,
    account: group.account,
    mode,
    active,
  });
  return data.presence || [];
}

export async function bulkGroupAction(action, items = [], payload = {}) {
  const { data } = await api.post('/groups/bulk', {
    action,
    items,
    ...payload,
  });
  return data;
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

export async function deleteAdminUser(userId) {
  const { data } = await api.delete(`/admin/users/${encodeURIComponent(userId)}`);
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
