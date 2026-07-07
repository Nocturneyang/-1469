<template>
  <AccountSettings
    v-if="currentView === 'account'"
    :operator="currentOperator"
    :user="currentUser"
    :portal-access="portalAccess"
    :account-scope="accountScope"
    :accounts="accounts"
    @back="goWorkbench"
  />

  <ServiceAccountAccess
    v-else-if="currentView === 'serviceAccounts'"
    :accounts="accounts"
    :account-scope="accountScope"
    @back="goWorkbench"
  />

  <PermissionConfig v-else-if="currentView === 'admin'" @back="goWorkbench" />

  <div v-else class="app-shell" :class="{ 'rail-collapsed': serviceRailCollapsed }">
    <ServiceAccountRail
      :accounts="accounts"
      :selected-account-keys="filters.accountKeys"
      :account-scope="accountScope"
      :portal-access="portalAccess"
      :operator="currentOperator"
      :collapsed="serviceRailCollapsed"
      @select="selectServiceAccount"
      @clear="clearServiceAccount"
      @toggle-collapse="toggleServiceRail"
      @open-permissions="openWorkbenchPermissions"
      @open-account-settings="openAccountSettings"
      @open-service-access="openServiceAccounts"
    />

    <div class="workspace-shell">
      <TopFilters
        v-model="filters"
        :labels="labels"
        :accounts="accounts"
        :available-platforms="availablePlatforms"
        :account-scope="accountScope"
        :syncing="syncingChannels"
        @sync-channels="handleChannelSync"
      />

      <main class="workbench-grid">
        <ConversationList
          :groups="groups"
          :loading="loadingGroups"
          :selected-id="selectedGroup && selectedGroup.id"
          :scope-label="scopeLabel"
          @select="selectGroup"
          @refresh="loadGroups"
        />

        <div class="thread-shell">
          <MessageThread
            :group="selectedGroup"
            :messages="messages"
            :paging="messagePaging"
            :loading-older="loadingOlder"
            :stick-to-bottom="stickToBottom"
            :current-operator-id="currentOperatorId"
            @mark-read="handleMarkRead"
            @assign="handleAssign"
            @open-native="handleOpenNative"
            @retry="handleRetry"
            @cancel="handleCancel"
            @load-older="handleLoadOlder"
            @read-progress="handleReadProgress"
            @stick-state-change="handleStickStateChange"
          />
          <Composer :group="selectedGroup" :sending="sending" @send="handleSend" />
        </div>

        <ConversationInspector
          :group="selectedGroup"
          :messages="messages"
          :manual-groups="manualGroups"
          :saving-manual-groups="savingManualGroups"
          @manual-groups-change="handleManualGroupsChange"
          @manual-group-create="handleManualGroupCreate"
        />
      </main>
    </div>

    <div v-if="error" class="toast-error">{{ error }}</div>
    <div v-else-if="noServiceAccount" class="toast-warn">请在账号管理中设置至少 1 个服务账号（角色设为「服务」或「服务+采集」并开启工作台可见），工作台才能显示会话。</div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import AccountSettings from './components/AccountSettings.vue';
import PermissionConfig from './components/PermissionConfig.vue';
import ServiceAccountAccess from './components/ServiceAccountAccess.vue';
import ServiceAccountRail from './components/ServiceAccountRail.vue';
import TopFilters from './components/TopFilters.vue';
import ConversationList from './components/ConversationList.vue';
import MessageThread from './components/MessageThread.vue';
import Composer from './components/Composer.vue';
import ConversationInspector from './components/ConversationInspector.vue';
import {
  assignGroup,
  cancelOutbound,
  createClientMsgId,
  createManualGroup,
  createReply,
  fetchAccounts,
  fetchGroups,
  fetchHealth,
  fetchLabels,
  fetchManualGroups,
  fetchMe,
  fetchMessages,
  hydrateWorkbenchAuth,
  isAuthRedirecting,
  markRead,
  requestChannelSync,
  releaseGroup,
  retryOutbound,
  saveGroupManualGroups,
} from './api';

const filters = ref({
  platforms: ['wa', 'tg'],
  accountKeys: [],
  scope: 'all',
  labelId: '',
  search: '',
});
const labels = ref([]);
const manualGroups = ref([]);
const accounts = ref([]);
const groups = ref([]);
const messages = ref([]);
const messagePaging = ref({ has_more: false, before_id: null });
const accountScope = ref({ mode: 'all', active: false, accounts: [] });
const portalAccess = ref({ can_monitor: false, can_workbench: true, can_admin: false });
const currentOperator = ref(null);
const currentUser = ref(null);
const selectedGroup = ref(null);
const loadingGroups = ref(false);
const loadingOlder = ref(false);
const stickToBottom = ref(true);
const sending = ref(false);
const syncingChannels = ref(false);
const savingManualGroups = ref(false);
const error = ref('');
const noServiceAccount = ref(false);
const serviceRailCollapsed = ref(readStoredRailCollapsed());
const currentView = ref(resolveCurrentView());
const workbenchBootstrapped = ref(false);

const AUTO_REFRESH_MS = 5000;
const PENDING_REFRESH_MS = 1500;
const PENDING_REFRESH_MAX_MS = 45000;
const READ_PROGRESS_DEBOUNCE_MS = 350;
const LIVE_OUTBOUND_STATUSES = new Set(['pending', 'sending']);
const currentOperatorId = computed(() => (
  currentOperator.value && currentOperator.value.id ? currentOperator.value.id : 'demo-operator'
));

const scopeLabel = computed(() => {
  if (filters.value.scope === 'mine') return '我的会话';
  if (filters.value.scope === 'unread') return '未读';
  return '全部';
});

const activeLabelPlatform = computed(() => (
  filters.value.platforms.length === 1 ? filters.value.platforms[0] : ''
));

const selectedAccountParam = computed(() => (
  filters.value.accountKeys.length ? filters.value.accountKeys.join(',') : undefined
));

const availablePlatforms = computed(() => {
  if (!accountScope.value || !accountScope.value.active) return ['wa', 'tg'];
  return [...new Set((accountScope.value.accounts || [])
    .map((account) => account.platform)
    .filter((platform) => platform === 'wa' || platform === 'tg'))];
});

let searchTimer = null;
let autoRefreshTimer = null;
let pendingRefreshTimer = null;
let pendingRefreshStartedAt = 0;
let refreshingActive = false;
let readProgressTimer = null;
let pendingReadProgress = null;
let readProgressInFlight = false;
let labelRequestSeq = 0;
const readProgressByGroup = new Map();

function resolveCurrentView() {
  const pathname = window.location.pathname;
  if (pathname === '/account' || pathname.startsWith('/account/')) return 'account';
  if (pathname === '/service-accounts' || pathname.startsWith('/service-accounts/')) return 'serviceAccounts';
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  return 'workbench';
}

function syncRouteFromLocation() {
  currentView.value = resolveCurrentView();
  if (currentView.value !== 'admin') bootstrapWorkbench();
}

function navigateTo(path) {
  window.history.pushState({}, '', path);
  syncRouteFromLocation();
}

function goWorkbench() {
  navigateTo('/');
}

onMounted(async () => {
  window.addEventListener('popstate', syncRouteFromLocation);

  const authUser = await hydrateWorkbenchAuth();
  if (!authUser && isAuthRedirecting()) return;
  if (currentView.value === 'admin') return;
  await bootstrapWorkbench();
});

onBeforeUnmount(() => {
  window.removeEventListener('popstate', syncRouteFromLocation);
  clearTimeout(searchTimer);
  clearTimeout(readProgressTimer);
  stopAutoRefresh();
  stopPendingRefresh();
});

async function bootstrapWorkbench() {
  if (workbenchBootstrapped.value) return;
  workbenchBootstrapped.value = true;
  const me = await fetchMe().catch(() => null);
  currentUser.value = me?.user || null;
  if (me && me.operator) {
    currentOperator.value = {
      ...me.operator,
      is_super_admin: Boolean(me.operator.is_super_admin || me.is_super_admin),
    };
  }
  if (me && me.portal_access) {
    portalAccess.value = {
      ...portalAccess.value,
      ...me.portal_access,
    };
  }
  const health = await fetchHealth().catch(() => null);
  if (health && health.account_scope) {
    accountScope.value = health.account_scope;
  }
  accounts.value = await fetchAccounts().catch(() => []);
  syncPlatformFilterWithScope({ preferMessageAccounts: true });
  await loadLabels();
  await loadManualGroups();
  await loadGroups();
  startAutoRefresh();
}

watch(availablePlatforms, () => syncPlatformFilterWithScope());

watch(() => [activeLabelPlatform.value, selectedAccountParam.value || ''], async ([platform], [previousPlatform] = []) => {
  if (platform !== previousPlatform && filters.value.labelId) {
    filters.value = { ...filters.value, labelId: '' };
  }
  await loadLabels();
  await loadManualGroups();
});

watch(
  () => ({ ...filters.value, platforms: [...filters.value.platforms] }),
  () => {
    clearTimeout(searchTimer);
    selectedGroup.value = null;
    pendingReadProgress = null;
    clearTimeout(readProgressTimer);
    searchTimer = setTimeout(() => loadGroups({ clearSelectionOnMissing: true }), 180);
  },
  { deep: true },
);

watch(
  () => selectedGroup.value && selectedGroup.value.id,
  async () => {
    stickToBottom.value = true;
    if (selectedGroup.value) await loadMessages();
    else {
      messages.value = [];
      messagePaging.value = { has_more: false, before_id: null };
    }
  },
);

async function loadGroups({ silent = false, clearSelectionOnMissing = false } = {}) {
  if (!silent) loadingGroups.value = true;
  error.value = '';
  noServiceAccount.value = false;
  try {
    const { groups: nextGroups, account_scope } = await fetchGroups({
      platforms: filters.value.platforms.join(','),
      accounts: selectedAccountParam.value,
      scope: filters.value.scope,
      label_id: filters.value.labelId || undefined,
      search: filters.value.search || undefined,
    });
    // 检测无服务账号配置（mode=operator-no-workbench 或帐号列表为空）
    if (
      account_scope &&
      (account_scope.mode === 'operator-no-workbench' ||
        (account_scope.active && account_scope.accounts && account_scope.accounts.length === 0))
    ) {
      noServiceAccount.value = true;
    }
    groups.value = nextGroups;
    if (!selectedGroup.value) return;
    const currentGroup = nextGroups.find((group) => group.id === selectedGroup.value.id);
    if (currentGroup) {
      selectedGroup.value = currentGroup;
    } else if (clearSelectionOnMissing) {
      selectedGroup.value = null;
    }
  } catch (err) {
    if (isAuthRedirecting()) return;
    error.value = '工作台 API 暂不可用，请检查服务状态';
  } finally {
    if (!silent) loadingGroups.value = false;
  }
}

async function loadLabels() {
  const requestSeq = ++labelRequestSeq;
  const platform = activeLabelPlatform.value;
  labels.value = [];
  const nextLabels = await fetchLabels({
    ...(platform ? { platform } : {}),
    ...(selectedAccountParam.value ? { accounts: selectedAccountParam.value } : {}),
  }).catch(() => []);
  if (requestSeq !== labelRequestSeq) return;
  labels.value = nextLabels;
  if (filters.value.labelId && !hasLabel(nextLabels, filters.value.labelId)) {
    filters.value = { ...filters.value, labelId: '' };
  }
}

async function loadManualGroups() {
  const platform = activeLabelPlatform.value;
  manualGroups.value = await fetchManualGroups({
    ...(platform ? { platform } : {}),
    ...(selectedAccountParam.value ? { accounts: selectedAccountParam.value } : {}),
  }).catch(() => []);
}

function hasLabel(nextLabels, labelId) {
  return nextLabels.some((label) => (
    String(label.native_label_id) === String(labelId) || String(label.id) === String(labelId)
  ));
}

function syncPlatformFilterWithScope({ preferMessageAccounts = false } = {}) {
  const platforms = availablePlatforms.value;
  if (!platforms.length) {
    filters.value = { ...filters.value, platforms: [] };
    return;
  }
  const current = filters.value.platforms.filter((platform) => platforms.includes(platform));
  const platformCounts = new Map(accounts.value.map((account) => [account.platform, Number(account.message_count || 0)]));
  const preferred = platforms.filter((platform) => (platformCounts.get(platform) || 0) > 0);
  const defaultPlatform = (preferred[0] || platforms[0]);
  const next = preferMessageAccounts || !current.length ? [defaultPlatform] : current;
  if (next.length !== filters.value.platforms.length || next.some((platform, index) => platform !== filters.value.platforms[index])) {
    filters.value = { ...filters.value, platforms: next, accountKeys: [], labelId: '' };
  }
}

async function selectGroup(group) {
  selectedGroup.value = group;
}

function selectServiceAccount(account) {
  if (!account) return;
  filters.value = {
    ...filters.value,
    platforms: [account.platform],
    accountKeys: [`${account.platform}:${account.account}`],
    labelId: '',
  };
}

function clearServiceAccount() {
  filters.value = {
    ...filters.value,
    accountKeys: [],
    labelId: '',
  };
}

function toggleServiceRail() {
  serviceRailCollapsed.value = !serviceRailCollapsed.value;
  try {
    window.localStorage.setItem('workbench.serviceRailCollapsed', serviceRailCollapsed.value ? '1' : '0');
  } catch (err) {
    // Ignore storage failures; the visible toggle should still work for this session.
  }
}

function readStoredRailCollapsed() {
  try {
    return window.localStorage.getItem('workbench.serviceRailCollapsed') === '1';
  } catch (err) {
    return false;
  }
}

async function loadMessages(params = {}) {
  if (!selectedGroup.value) return;
  const page = await fetchMessages(selectedGroup.value, params);
  if (params.before_id) {
    messages.value = mergeMessages(page.messages, messages.value);
  } else {
    messages.value = page.messages;
  }
  messagePaging.value = page.paging;
}

function mergeMessages(...sets) {
  const map = new Map();
  sets.flat().forEach((message) => {
    map.set(message.id, message);
  });
  return [...map.values()].sort((a, b) => {
    if (a.sort_time === b.sort_time) return String(a.id).localeCompare(String(b.id));
    return a.sort_time - b.sort_time;
  });
}

async function handleSend(message) {
  if (!selectedGroup.value) return;
  const payload = typeof message === 'string' ? { text: message, attachments: [] } : (message || {});
  const text = String(payload.text || '').trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!text && !attachments.length) return;
  sending.value = true;
  try {
    const reply = await createReply({
      client_msg_id: createClientMsgId(),
      platform: selectedGroup.value.platform,
      account: selectedGroup.value.account,
      group_id: selectedGroup.value.group_id,
      text,
      attachments,
    });
    stickToBottom.value = true;
    await loadMessages();
    await loadGroups();
    if (LIVE_OUTBOUND_STATUSES.has(reply.status)) startPendingRefresh();
  } catch (err) {
    ElMessage.error('发送任务创建失败');
  } finally {
    sending.value = false;
  }
}

async function handleChannelSync() {
  if (syncingChannels.value) return;
  const platform = filters.value.platforms[0];
  if (!platform) return;
  syncingChannels.value = true;
  try {
    const result = await requestChannelSync({
      platform,
      accounts: filters.value.accountKeys,
      reason: 'manual',
    });
    ElMessage.success(`已请求同步 ${result.requests.length} 个账号`);
    setTimeout(() => {
      loadLabels();
      loadManualGroups();
      loadGroups({ silent: true });
    }, 2500);
  } catch (err) {
    ElMessage.error('同步请求失败');
  } finally {
    syncingChannels.value = false;
  }
}

async function handleManualGroupCreate(payload) {
  if (!selectedGroup.value || savingManualGroups.value) return;
  savingManualGroups.value = true;
  try {
    const group = await createManualGroup({
      platform: selectedGroup.value.platform,
      account: selectedGroup.value.account,
      ...payload,
    });
    await loadLabels();
    await loadManualGroups();
    if (group && group.native_group_id) {
      const currentIds = selectedManualGroupIds(selectedGroup.value);
      await persistManualGroups([...new Set([...currentIds, group.native_group_id])]);
    }
    ElMessage.success('人工分组已创建');
  } catch (err) {
    ElMessage.error('人工分组创建失败');
  } finally {
    savingManualGroups.value = false;
  }
}

async function handleManualGroupsChange(manualGroupIds) {
  if (!selectedGroup.value || savingManualGroups.value) return;
  savingManualGroups.value = true;
  try {
    await persistManualGroups(manualGroupIds);
    ElMessage.success('会话分组已更新');
  } catch (err) {
    ElMessage.error('会话分组保存失败');
  } finally {
    savingManualGroups.value = false;
  }
}

async function persistManualGroups(manualGroupIds) {
  if (!selectedGroup.value) return;
  const result = await saveGroupManualGroups(selectedGroup.value, manualGroupIds);
  patchSelectedGroup({ labels: result.labels || [] });
  await loadLabels();
  await loadManualGroups();
  await loadGroups({ silent: true, clearSelectionOnMissing: true });
}

async function handleMarkRead() {
  if (!selectedGroup.value) return;
  const lastRaw = [...messages.value].reverse().find((message) => message.raw_id);
  const lastReadMessageId = lastRaw ? lastRaw.raw_id : selectedGroup.value.last_message_id;
  const result = await markRead({
    platform: selectedGroup.value.platform,
    account: selectedGroup.value.account,
    group_id: selectedGroup.value.group_id,
    last_read_message_id: lastReadMessageId,
  });
  readProgressByGroup.set(selectedGroup.value.id, Number(lastReadMessageId) || 0);
  patchSelectedGroup({ unread_count: Number(result.unread_count || 0) });
}

async function handleAssign() {
  if (!selectedGroup.value) return;
  if (selectedGroup.value.assignment && selectedGroup.value.assignment.assigned_to === currentOperatorId.value) {
    await releaseGroup(selectedGroup.value);
    patchSelectedGroup({ assignment: null });
    ElMessage.success('已释放当前会话');
  } else {
    const result = await assignGroup(selectedGroup.value, currentOperatorId.value);
    patchSelectedGroup({ assignment: result.assignment || null });
    ElMessage.success('已认领当前会话');
  }
}

function handleOpenNative() {
  ElMessage.info('原生群入口将在 worker 同步阶段接入');
}

function openWorkbenchPermissions() {
  navigateTo('/admin');
}

function openAccountSettings() {
  navigateTo('/account');
}

function openServiceAccounts() {
  navigateTo('/service-accounts');
}

async function handleRetry(message) {
  if (!message.outbound_id) return;
  await retryOutbound(message.outbound_id);
  stickToBottom.value = true;
  await loadMessages();
  startPendingRefresh();
}

async function handleCancel(message) {
  if (!message.outbound_id) return;
  await cancelOutbound(message.outbound_id);
  ElMessage.success('已取消外发任务');
  stickToBottom.value = true;
  await loadMessages();
}

async function handleLoadOlder() {
  if (!selectedGroup.value || !messagePaging.value.has_more || loadingOlder.value) return;
  loadingOlder.value = true;
  stickToBottom.value = false;
  try {
    await loadMessages({ before_id: messagePaging.value.before_id });
  } finally {
    loadingOlder.value = false;
  }
}

function handleStickStateChange(nextState) {
  stickToBottom.value = nextState;
}

function handleReadProgress(progress) {
  if (!selectedGroup.value || progress.groupId !== selectedGroup.value.id) return;
  const lastReadMessageId = Number(progress.last_read_message_id) || 0;
  if (!lastReadMessageId) return;
  const previousReadMessageId = Number(readProgressByGroup.get(progress.groupId) || 0);
  if (lastReadMessageId <= previousReadMessageId) return;
  pendingReadProgress = {
    groupId: progress.groupId,
    platform: progress.platform,
    account: progress.account,
    group_id: progress.group_id,
    last_read_message_id: lastReadMessageId,
  };
  clearTimeout(readProgressTimer);
  readProgressTimer = setTimeout(() => {
    flushReadProgress().catch(() => {});
  }, READ_PROGRESS_DEBOUNCE_MS);
}

async function flushReadProgress() {
  if (readProgressInFlight || !pendingReadProgress) return;
  const progress = pendingReadProgress;
  pendingReadProgress = null;
  readProgressInFlight = true;
  try {
    const result = await markRead({
      platform: progress.platform,
      account: progress.account,
      group_id: progress.group_id,
      last_read_message_id: progress.last_read_message_id,
    });
    readProgressByGroup.set(
      progress.groupId,
      Math.max(Number(readProgressByGroup.get(progress.groupId) || 0), progress.last_read_message_id),
    );
    patchSelectedGroup({ unread_count: Number(result.unread_count || 0) });
  } finally {
    readProgressInFlight = false;
    if (pendingReadProgress) {
      clearTimeout(readProgressTimer);
      readProgressTimer = setTimeout(() => {
        flushReadProgress().catch(() => {});
      }, READ_PROGRESS_DEBOUNCE_MS);
    }
  }
}

function patchSelectedGroup(patch) {
  if (!selectedGroup.value) return;
  const nextGroup = { ...selectedGroup.value, ...patch };
  selectedGroup.value = nextGroup;
  groups.value = groups.value
    .map((group) => (group.id === nextGroup.id ? { ...group, ...patch } : group))
    .filter(groupMatchesActiveScope);
}

function selectedManualGroupIds(group) {
  return ((group && group.labels) || [])
    .filter((label) => label && (Number(label.is_manual) === 1 || String(label.source || '').startsWith('manual')))
    .map((label) => String(label.native_group_id || label.native_label_id || '').trim())
    .filter(Boolean);
}

function groupMatchesActiveScope(group) {
  if (filters.value.scope === 'mine') {
    return Boolean(group.assignment && group.assignment.assigned_to === currentOperatorId.value);
  }
  if (filters.value.scope === 'unread') return Number(group.unread_count || 0) > 0;
  return true;
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    refreshActiveConversation({ keepStickToBottom: false }).catch(() => {});
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

function startPendingRefresh() {
  stopPendingRefresh();
  pendingRefreshStartedAt = Date.now();
  pendingRefreshTimer = setInterval(() => {
    refreshActiveConversation({ keepStickToBottom: true }).catch(() => {});
  }, PENDING_REFRESH_MS);
}

function stopPendingRefresh() {
  if (pendingRefreshTimer) clearInterval(pendingRefreshTimer);
  pendingRefreshTimer = null;
  pendingRefreshStartedAt = 0;
}

async function refreshActiveConversation({ keepStickToBottom = false } = {}) {
  if (refreshingActive) return;
  refreshingActive = true;
  const previousStickToBottom = stickToBottom.value;
  try {
    if (keepStickToBottom && previousStickToBottom) stickToBottom.value = true;
    await loadGroups({ silent: true });
    if (selectedGroup.value) await loadMessages();
    updatePendingRefreshState();
  } finally {
    if (!keepStickToBottom) stickToBottom.value = previousStickToBottom;
    refreshingActive = false;
  }
}

function updatePendingRefreshState() {
  const hasLiveOutbound = messages.value.some((message) => (
    message.source === 'workbench' && LIVE_OUTBOUND_STATUSES.has(message.status)
  ));
  const expired = pendingRefreshStartedAt && Date.now() - pendingRefreshStartedAt > PENDING_REFRESH_MAX_MS;
  if (!hasLiveOutbound || expired) stopPendingRefresh();
}
</script>
