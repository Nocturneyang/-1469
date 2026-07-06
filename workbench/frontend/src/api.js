import axios from 'axios';

const api = axios.create({
  baseURL: '/api/workbench',
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  const token = window.localStorage.getItem('auth_token') || '';
  const ssoToken = window.localStorage.getItem('sso_token') || '';
  const bearer = token && token !== '__sso__' ? token : ssoToken;
  if (bearer) config.headers.Authorization = `Bearer ${bearer}`;
  return config;
});

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

export function createClientMsgId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
