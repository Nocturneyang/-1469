<template>
  <AccountSettings
    v-if="currentView === 'account'"
    :operator="currentOperator"
    :user="currentUser"
    :portal-access="portalAccess"
    :account-scope="accountScope"
    :can-manage="Boolean(portalAccess.can_admin)"
    :accounts="connectedAccounts"
    @back="goWorkbench"
  />

  <ServiceAccountAccess
    v-else-if="currentView === 'serviceAccounts'"
    :accounts="accounts"
    :account-scope="accountScope"
    :can-manage="Boolean(portalAccess.can_admin)"
    @back="goWorkbench"
    @open-login="openServiceLogin"
    @account-deleted="handleServiceAccountDeleted"
    @refresh-accounts="refreshServiceAccounts"
    @settings-change="handleServiceAccountSettingsChange"
  />

  <ServiceAccountLogin v-else-if="currentView === 'serviceLogin'" @back="goWorkbench" />

  <PermissionConfig v-else-if="currentView === 'admin'" @back="goWorkbench" />

  <div v-else class="app-shell" :class="{ 'rail-collapsed': serviceRailCollapsed }">
    <ServiceAccountRail
      :accounts="connectedAccounts"
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
        :accounts="connectedAccounts"
        :available-platforms="availablePlatforms"
        :account-scope="accountScope"
        :syncing="syncingChannels"
        :profile-open="customerProfileOpen"
        :notification-enabled="notificationsEnabled"
        :realtime-state="realtimeState"
        @sync-channels="handleChannelSync"
        @toggle-customer-profile="toggleCustomerProfile"
        @toggle-notifications="handleNotificationToggle"
      />

      <main class="workbench-grid" :class="{ 'profile-collapsed': !customerProfileOpen }">
        <ConversationList
          :groups="groups"
          :loading="loadingGroups"
          :selected-id="selectedGroup && selectedGroup.id"
          :scope-label="scopeLabel"
          :search="filters.search"
          @select="selectGroup"
          @prefetch="prefetchMessages"
          @refresh="loadGroups"
          @search-change="(search) => filters = { ...filters, search }"
        />

        <div class="thread-shell">
          <MessageThread
            :group="selectedGroup"
            :messages="messages"
            :paging="messagePaging"
            :loading-messages="loadingMessages"
            :loading-older="loadingOlder"
            :stick-to-bottom="stickToBottom"
            :manual-groups="manualGroups"
            :saving-manual-groups="savingManualGroups"
            @retry="handleRetry"
            @cancel="handleCancel"
            @load-older="handleLoadOlder"
            @read-progress="handleReadProgress"
            @stick-state-change="handleStickStateChange"
            @quote="handleQuote"
            @manual-groups-change="handleManualGroupsChange"
            @manual-group-create="handleManualGroupCreate"
          />
          <Composer
            ref="composerRef"
            :group="selectedGroup"
            :sending="sending"
            :quote-message="quoteMessage"
            :operator-id="currentOperator?.id || currentUser?.id || ''"
            @send="handleSend"
            @clear-quote="clearQuote"
            @typing-state="handleTypingState"
          />
        </div>

        <ConversationInspector
          :group="selectedGroup"
          :workspace-detail="workspaceDetail"
          :operator-id="currentOperator?.id || currentUser?.id || ''"
          @workspace-save="handleWorkspaceSave"
          @note-create="handleNoteCreate"
          @note-delete="handleNoteDelete"
          @load-more-notes="handleLoadMoreNotes"
          @load-more-timeline="handleLoadMoreTimeline"
        />
        <button
          v-if="customerProfileOpen"
          type="button"
          class="customer-profile-backdrop"
          aria-label="关闭客户资料"
          @click="toggleCustomerProfile"
        ></button>
      </main>
    </div>

    <div v-if="error" class="toast-error">{{ error }}</div>
    <div v-else-if="noServiceAccount" class="toast-warn">请先在服务账号中接入至少 1 个账号，并在权限管理中授权可见范围。</div>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ElMessage from 'element-plus/es/components/message/index.mjs';
import ServiceAccountRail from './components/ServiceAccountRail.vue';
import TopFilters from './components/TopFilters.vue';
import ConversationList from './components/ConversationList.vue';
import MessageThread from './components/MessageThread.vue';
import Composer from './components/Composer.vue';
import ConversationInspector from './components/ConversationInspector.vue';
import PermissionConfig from './components/PermissionConfig.vue';
import { useNotifier } from './composables/useNotifier';

const AccountSettings = defineAsyncComponent(() => import('./components/AccountSettings.vue'));
const ServiceAccountAccess = defineAsyncComponent(() => import('./components/ServiceAccountAccess.vue'));
const ServiceAccountLogin = defineAsyncComponent(() => import('./components/ServiceAccountLogin.vue'));
import {
  cancelOutbound,
  createClientMsgId,
  createGroupNote,
  deleteGroupNote,
  createManualGroup,
  createReply,
  fetchAccounts,
  fetchGroupWorkspace,
  fetchGroupNotes,
  fetchGroupTimeline,
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
  retryOutbound,
  saveGroupWorkspace,
  saveGroupManualGroups,
  subscribeConversationEvents,
  subscribeWorkbenchEvents,
  updateGroupPresence,
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
const workspaceDetail = ref({ profile: null, notes: [], timeline: [], presence: [], notes_paging: {}, timeline_paging: {} });
const loadingWorkspace = ref(false);
const quoteMessage = ref(null);
const loadingGroups = ref(false);
const loadingMessages = ref(false);
const loadingOlder = ref(false);
const stickToBottom = ref(true);
const sending = ref(false);
const syncingChannels = ref(false);
const savingManualGroups = ref(false);
const error = ref('');
const noServiceAccount = ref(false);
const serviceRailCollapsed = ref(readStoredRailCollapsed());
const customerProfileOpen = ref(readStoredCustomerProfileOpen());
const currentView = ref(resolveCurrentView());
const workbenchBootstrapped = ref(false);
const composerRef = ref(null);
const realtimeState = ref('connecting');
const notifier = useNotifier();
const notificationsEnabled = notifier.enabled;

const AUTO_REFRESH_MS = 30000;
const PENDING_REFRESH_MS = 30000;
const PENDING_REFRESH_MAX_MS = 120000;
const GROUP_LIVE_REFRESH_MS = 30000;
const WORKSPACE_LIVE_REFRESH_MS = 8000;
const READ_PROGRESS_DEBOUNCE_MS = 350;
const FILTER_DEBOUNCE_MS = 80;
const CHANNEL_REFRESH_MS = 700;
const CHANNEL_REFRESH_MAX_ATTEMPTS = 20;
const MESSAGE_PAGE_LIMIT = 60;
const MESSAGE_CACHE_LIMIT = 24;
const WORKBENCH_CACHE_TTL_MS = 10 * 60 * 1000;
const WORKBENCH_GROUP_CACHE_TTL_MS = 2 * 60 * 1000;
const GROUP_LIST_CACHE_LIMIT = 20;
const LIVE_OUTBOUND_STATUSES = new Set(['pending', 'sending']);
const CONNECTED_ACCOUNT_STATUSES = new Set(['online', 'authenticated', 'ready', 'monitoring', 'healthy']);
const scopeLabel = computed(() => {
  if (filters.value.scope === 'unread') return '未读';
  return '全部';
});

const activeLabelPlatform = computed(() => (
  filters.value.platforms.length === 1 ? filters.value.platforms[0] : ''
));

const selectedAccountParam = computed(() => (
  filters.value.accountKeys.length ? filters.value.accountKeys.join(',') : undefined
));

const connectedAccounts = computed(() => accounts.value.filter((account) => isConnectedAccount(account)));

const availablePlatforms = computed(() => {
  return [...new Set(connectedAccounts.value
    .map((account) => account.platform)
    .filter((platform) => platform === 'wa' || platform === 'tg'))];
});

let searchTimer = null;
let autoRefreshTimer = null;
let pendingRefreshTimer = null;
let channelRefreshTimer = null;
let channelRefreshInFlight = false;
let pendingRefreshStartedAt = 0;
let refreshingActive = false;
let lastGroupLiveRefreshAt = 0;
let lastWorkspaceLiveRefreshAt = 0;
let readProgressTimer = null;
let pendingReadProgress = null;
let readProgressInFlight = false;
let labelRequestSeq = 0;
let workspaceRequestSeq = 0;
let groupsRequestSeq = 0;
let messageRequestSeq = 0;
const messageCache = new Map();
const messagePrefetches = new Map();
const groupListCache = new Map();
let bootstrapRetryTimer = null;
let bootstrapRetryCount = 0;
let activeCacheUserId = '';
let cacheWriteTimer = null;
let restoringWorkbenchCache = false;
let presenceHeartbeatTimer = null;
let typingPresenceTimer = null;
let stopConversationEvents = null;
let conversationEventRefreshTimer = null;
let stopWorkbenchEvents = null;
let workbenchEventRefreshTimer = null;
let workbenchEventNeedsMessages = false;
const recentInboundEvents = new Map();
const readProgressByGroup = new Map();

function resolveCurrentView() {
  const pathname = window.location.pathname;
  if (pathname === '/account' || pathname.startsWith('/account/')) return 'account';
  if (pathname === '/service-accounts' || pathname.startsWith('/service-accounts/')) return 'serviceAccounts';
  if (pathname === '/service-account-login' || pathname.startsWith('/service-account-login/')) return 'serviceLogin';
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
  workbenchBootstrapped.value = false;
  navigateTo('/');
}

onMounted(async () => {
  window.addEventListener('popstate', syncRouteFromLocation);
  window.addEventListener('keydown', handleGlobalShortcut);
  window.addEventListener('focus', handleForegroundRefresh);
  document.addEventListener('visibilitychange', handleVisibilityRefresh);

  const authUser = await hydrateWorkbenchAuth();
  if (!authUser && isAuthRedirecting()) return;
  if (currentView.value === 'admin') return;
  hydrateWorkbenchCache(authUser);
  await bootstrapWorkbench();
});

onBeforeUnmount(() => {
  window.removeEventListener('popstate', syncRouteFromLocation);
  window.removeEventListener('keydown', handleGlobalShortcut);
  window.removeEventListener('focus', handleForegroundRefresh);
  document.removeEventListener('visibilitychange', handleVisibilityRefresh);
  clearTimeout(searchTimer);
  clearTimeout(readProgressTimer);
  clearTimeout(typingPresenceTimer);
  clearTimeout(bootstrapRetryTimer);
  clearTimeout(cacheWriteTimer);
  stopPresenceHeartbeat();
  clearPresence();
  stopAutoRefresh();
  stopPendingRefresh();
  stopChannelRefreshPolling();
  stopConversationEventStream();
  stopWorkbenchEventStream();
  notifier.setUnreadTotal(0);
});

async function bootstrapWorkbench() {
  if (workbenchBootstrapped.value) return;
  workbenchBootstrapped.value = true;
  const me = await fetchMe().catch(() => null);
  if (!me) {
    workbenchBootstrapped.value = false;
    if (!isAuthRedirecting() && bootstrapRetryCount < 3) {
      bootstrapRetryCount += 1;
      bootstrapRetryTimer = setTimeout(() => {
        bootstrapWorkbench().catch(() => {});
      }, 800);
    }
    return;
  }
  bootstrapRetryCount = 0;
  currentUser.value = me?.user || null;
  activeCacheUserId = cacheUserId(currentUser.value);
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
  const [health, nextAccounts] = await Promise.all([
    fetchHealth().catch(() => null),
    fetchAccounts().catch(() => null),
  ]);
  if (health && health.account_scope) accountScope.value = health.account_scope;
  if (Array.isArray(nextAccounts)) accounts.value = nextAccounts;
  syncPlatformFilterWithScope({ preferMessageAccounts: true });
  await Promise.all([
    loadLabels(),
    loadManualGroups(),
    loadGroups({ useRetry: true }),
  ]);
  scheduleWorkbenchCacheWrite();
  startWorkbenchEventStream();
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
  (nextFilters, previousFilters) => {
    if (restoringWorkbenchCache) return;
    clearTimeout(searchTimer);
    groupsRequestSeq += 1;
    applyInstantConversationFilter(nextFilters, previousFilters);
    clearPresence();
    selectedGroup.value = null;
    quoteMessage.value = null;
    pendingReadProgress = null;
    clearTimeout(readProgressTimer);
    searchTimer = setTimeout(() => loadGroups({ clearSelectionOnMissing: true }), FILTER_DEBOUNCE_MS);
  },
  { deep: true },
);

watch(
  () => selectedGroup.value && selectedGroup.value.id,
  async () => {
    stickToBottom.value = true;
    quoteMessage.value = null;
    stopConversationEventStream();
    if (selectedGroup.value) {
      const selectedGroupId = selectedGroup.value.id;
      workspaceDetail.value = { profile: null, notes: [], timeline: [], presence: [], notes_paging: {}, timeline_paging: {} };
      const restoredFromCache = hydrateCachedMessages(selectedGroup.value);
      // Returning to an already loaded conversation should keep its complete history visible.
      // Start a new request generation so a slower response from the previous conversation
      // cannot leave a stale loading state or replace the restored cache.
      if (restoredFromCache) {
        messageRequestSeq += 1;
        loadingMessages.value = false;
      }
      loadMessages(restoredFromCache ? { preserve_existing: true } : {})
        .catch(() => {})
        .finally(() => {
          if (selectedGroup.value && selectedGroup.value.id === selectedGroupId) {
            loadWorkspace().catch(() => {});
          }
        });
      startPresenceHeartbeat();
      startConversationEventStream(selectedGroup.value);
    }
    else {
      loadingMessages.value = false;
      messages.value = [];
      messagePaging.value = { has_more: false, before_id: null };
      workspaceDetail.value = { profile: null, notes: [], timeline: [], presence: [], notes_paging: {}, timeline_paging: {} };
      stopPresenceHeartbeat();
    }
  },
);

async function loadGroups({ silent = false, clearSelectionOnMissing = false, useRetry = false } = {}) {
  const requestSeq = ++groupsRequestSeq;
  const requestFilters = {
    ...filters.value,
    platforms: [...filters.value.platforms],
    accountKeys: [...filters.value.accountKeys],
  };
  const requestKey = groupFilterCacheKey(requestFilters);
  if (!silent && !groups.value.length) loadingGroups.value = true;
  error.value = '';
  noServiceAccount.value = false;
  try {
    const request = () => fetchGroups({
      platforms: requestFilters.platforms.join(','),
      accounts: requestFilters.accountKeys.length ? requestFilters.accountKeys.join(',') : undefined,
      scope: requestFilters.scope,
      label_id: requestFilters.labelId || undefined,
      search: requestFilters.search || undefined,
    });
    const { groups: nextGroups, account_scope } = useRetry
      ? await retryTransientRequest(request)
      : await request();
    if (requestSeq !== groupsRequestSeq) return;
    // 检测无服务账号配置（mode=operator-no-workbench 或帐号列表为空）
    if (
      account_scope &&
      (account_scope.mode === 'operator-no-workbench' ||
        (account_scope.active && account_scope.accounts && account_scope.accounts.length === 0))
    ) {
      noServiceAccount.value = true;
    }
    groups.value = nextGroups;
    notifier.setUnreadTotal(nextGroups.reduce((total, group) => total + Number(group.unread_count || 0), 0));
    writeGroupListCache(requestKey, nextGroups);
    scheduleWorkbenchCacheWrite();
    if (!selectedGroup.value) return;
    const currentGroup = nextGroups.find((group) => group.id === selectedGroup.value.id);
    if (currentGroup) {
      selectedGroup.value = currentGroup;
    } else if (clearSelectionOnMissing) {
      selectedGroup.value = null;
    }
  } catch (err) {
    if (isAuthRedirecting()) return;
    // 缓存仍可使用时保持作业面，不把瞬时数据锁竞争误报成整个平台不可用。
    if (!groups.value.length) error.value = '会话数据暂时无法刷新，正在自动重试';
  } finally {
    if (requestSeq === groupsRequestSeq) loadingGroups.value = false;
  }
}

async function loadLabels() {
  const requestSeq = ++labelRequestSeq;
  const platform = activeLabelPlatform.value;
  const nextLabels = await fetchLabels({
    ...(platform ? { platform } : {}),
    ...(selectedAccountParam.value ? { accounts: selectedAccountParam.value } : {}),
  }).catch(() => null);
  if (requestSeq !== labelRequestSeq) return;
  if (!Array.isArray(nextLabels)) return;
  labels.value = nextLabels;
  scheduleWorkbenchCacheWrite();
  if (filters.value.labelId && !hasLabel(nextLabels, filters.value.labelId)) {
    filters.value = { ...filters.value, labelId: '' };
  }
}

async function loadManualGroups() {
  const platform = activeLabelPlatform.value;
  const nextGroups = await fetchManualGroups({
    ...(platform ? { platform } : {}),
    ...(selectedAccountParam.value ? { accounts: selectedAccountParam.value } : {}),
  }).catch(() => null);
  if (Array.isArray(nextGroups)) manualGroups.value = nextGroups;
  scheduleWorkbenchCacheWrite();
}

function isTransientApiError(err) {
  const status = Number(err?.response?.status || 0);
  return !status || status >= 500 || ['ECONNABORTED', 'ERR_NETWORK'].includes(String(err?.code || ''));
}

async function retryTransientRequest(request, attempts = 3) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await request();
    } catch (err) {
      lastError = err;
      if (!isTransientApiError(err) || index === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 350 * (index + 1)));
    }
  }
  throw lastError;
}

function cacheUserId(user) {
  return String(user?.id || user?.username || '').trim();
}

function workbenchCacheKey(userId = activeCacheUserId) {
  return userId ? `workbench.bootstrap.v1.${userId}` : '';
}

function hydrateWorkbenchCache(user) {
  const userId = cacheUserId(user);
  const key = workbenchCacheKey(userId);
  if (!key) return;
  try {
    const snapshot = JSON.parse(window.localStorage.getItem(key) || 'null');
    if (!snapshot || Date.now() - Number(snapshot.savedAt || 0) > WORKBENCH_CACHE_TTL_MS) return;
    activeCacheUserId = userId;
    restoringWorkbenchCache = true;
    if (Array.isArray(snapshot.accounts)) accounts.value = snapshot.accounts;
    if (snapshot.accountScope) accountScope.value = snapshot.accountScope;
    if (snapshot.filters) filters.value = { ...filters.value, ...snapshot.filters };
    if (Array.isArray(snapshot.labels)) labels.value = snapshot.labels;
    if (Array.isArray(snapshot.manualGroups)) manualGroups.value = snapshot.manualGroups;
    const cachedGroups = snapshot.groupsByFilter?.[groupFilterCacheKey()];
    if (cachedGroups && Date.now() - Number(cachedGroups.savedAt || 0) <= WORKBENCH_GROUP_CACHE_TTL_MS) {
      groups.value = cachedGroups.groups;
      writeGroupListCache(groupFilterCacheKey(), cachedGroups.groups);
    }
  } catch (_) {
    // 旧格式或被清理的浏览器存储不影响正常加载。
  } finally {
    restoringWorkbenchCache = false;
  }
}

function groupFilterCacheKey(filterState = filters.value) {
  return JSON.stringify({
    platforms: filterState.platforms || [],
    accountKeys: filterState.accountKeys || [],
    scope: filterState.scope,
    labelId: filterState.labelId,
    search: filterState.search,
  });
}

function writeGroupListCache(key, nextGroups) {
  if (!key || !Array.isArray(nextGroups)) return;
  groupListCache.delete(key);
  groupListCache.set(key, [...nextGroups]);
  while (groupListCache.size > GROUP_LIST_CACHE_LIMIT) {
    groupListCache.delete(groupListCache.keys().next().value);
  }
}

function applyInstantConversationFilter(nextFilters, previousFilters = {}) {
  const exact = groupListCache.get(groupFilterCacheKey(nextFilters));
  if (exact) {
    groups.value = [...exact];
    return;
  }
  if (String(nextFilters?.labelId || '') !== String(previousFilters?.labelId || '')) {
    applyInstantLabelFilter(nextFilters, previousFilters);
    return;
  }
  groups.value = groups.value.filter((group) => groupMatchesFilterState(group, nextFilters));
}

function applyInstantLabelFilter(nextFilters, previousFilters = {}) {
  if (String(nextFilters?.labelId || '') === String(previousFilters?.labelId || '')) return;
  const exact = groupListCache.get(groupFilterCacheKey(nextFilters));
  if (exact) {
    groups.value = [...exact];
    return;
  }
  const nextBase = { ...nextFilters, labelId: '' };
  const previousBase = { ...previousFilters, labelId: '' };
  const sameBase = groupFilterCacheKey(nextBase) === groupFilterCacheKey(previousBase);
  let source = groupListCache.get(groupFilterCacheKey(nextBase));
  if (!source && sameBase && !previousFilters?.labelId) {
    source = [...groups.value];
    writeGroupListCache(groupFilterCacheKey(nextBase), source);
  }
  if (!source) return;
  if (!nextFilters.labelId) {
    groups.value = [...source];
    return;
  }
  const selectedIds = expandedLabelFilterIds(nextFilters.labelId);
  groups.value = source.filter((group) => (group.labels || []).some((label) => (
    selectedIds.has(String(label.native_label_id || label.native_group_id || label.id || ''))
  )));
}

function groupMatchesFilterState(group, filterState = filters.value) {
  const platformSet = new Set((filterState.platforms || []).filter(Boolean));
  if (platformSet.size && !platformSet.has(group.platform)) return false;
  const selectedAccounts = new Set(filterState.accountKeys || []);
  if (selectedAccounts.size && !selectedAccounts.has(accountKey(group))) return false;
  if (filterState.scope === 'unread' && Number(group.unread_count || 0) <= 0) return false;
  if (filterState.labelId) {
    const selectedIds = expandedLabelFilterIds(filterState.labelId);
    const matched = (group.labels || []).some((label) => (
      selectedIds.has(String(label.native_label_id || label.native_group_id || label.id || ''))
    ));
    if (!matched) return false;
  }
  const search = String(filterState.search || '').trim().toLowerCase();
  if (!search) return true;
  return [
    group.group_name,
    group.group_id,
    group.sender_name,
    group.content,
    group.account,
    group.account_display_name,
  ].some((value) => String(value || '').toLowerCase().includes(search));
}

function expandedLabelFilterIds(labelId) {
  const selected = String(labelId || '');
  const ids = new Set([selected]);
  labels.value.forEach((label) => {
    if (String(label.parent_native_group_id || '') === selected) {
      ids.add(String(label.native_label_id || label.native_group_id || label.id || ''));
    }
  });
  return ids;
}

function scheduleWorkbenchCacheWrite() {
  if (!activeCacheUserId) return;
  clearTimeout(cacheWriteTimer);
  cacheWriteTimer = setTimeout(() => {
    try {
      const key = workbenchCacheKey();
      const existing = JSON.parse(window.localStorage.getItem(key) || 'null') || {};
      const groupsByFilter = { ...(existing.groupsByFilter || {}) };
      groupsByFilter[groupFilterCacheKey()] = { savedAt: Date.now(), groups: groups.value };
      window.localStorage.setItem(key, JSON.stringify({
        savedAt: Date.now(),
        accounts: accounts.value,
        accountScope: accountScope.value,
        filters: filters.value,
        labels: labels.value,
        manualGroups: manualGroups.value,
        groupsByFilter,
      }));
    } catch (_) {
      // 缓存是加速层，存储配额不足时不影响工作台。
    }
  }, 80);
}

function hasLabel(nextLabels, labelId) {
  return nextLabels.some((label) => (
    String(label.native_label_id) === String(labelId) || String(label.id) === String(labelId)
  ));
}

function syncPlatformFilterWithScope({ preferMessageAccounts = false } = {}) {
  const platforms = availablePlatforms.value;
  if (!platforms.length) {
    filters.value = { ...filters.value, platforms: [], accountKeys: [], labelId: '' };
    return;
  }
  const current = filters.value.platforms.filter((platform) => platforms.includes(platform));
  const connectedKeys = new Set(connectedAccounts.value.map(accountKey));
  const accountKeys = filters.value.accountKeys.filter((key) => connectedKeys.has(key));
  const platformCounts = new Map(connectedAccounts.value.map((account) => [account.platform, Number(account.message_count || 0)]));
  const preferred = platforms.filter((platform) => (platformCounts.get(platform) || 0) > 0);
  const defaultPlatform = (preferred[0] || platforms[0]);
  const next = preferMessageAccounts || !current.length ? [defaultPlatform] : current;
  if (
    next.length !== filters.value.platforms.length ||
    next.some((platform, index) => platform !== filters.value.platforms[index]) ||
    accountKeys.length !== filters.value.accountKeys.length
  ) {
    filters.value = { ...filters.value, platforms: next, accountKeys, labelId: accountKeys.length ? filters.value.labelId : '' };
  }
}

function isConnectedAccount(account) {
  if (!account) return false;
  if (account.is_connected === true || account.is_connected === 1) return true;
  return CONNECTED_ACCOUNT_STATUSES.has(String(account.account_status || '').toLowerCase());
}

function accountKey(account) {
  return `${account.platform}:${account.account}`;
}

async function selectGroup(group) {
  if (group && selectedGroup.value && group.id === selectedGroup.value.id) return;
  if (selectedGroup.value && (!group || group.id !== selectedGroup.value.id)) {
    clearPresence(selectedGroup.value);
  }
  if (group) primeMessagePreview(group);
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

async function handleServiceAccountDeleted(account) {
  if (!account) return;
  accounts.value = accounts.value.filter((item) => accountKey(item) !== accountKey(account));
  if (filters.value.accountKeys.includes(accountKey(account))) clearServiceAccount();
  await Promise.all([loadLabels(), loadManualGroups(), loadGroups({ silent: true })]);
}

async function refreshServiceAccounts() {
  const nextAccounts = await fetchAccounts().catch(() => null);
  if (Array.isArray(nextAccounts)) accounts.value = nextAccounts;
}

function handleServiceAccountSettingsChange(account) {
  accounts.value = accounts.value.map((item) => accountKey(item) === accountKey(account) ? { ...item, ...account } : item);
  const patch = {
    send_enabled: account.send_enabled,
    global_send_enabled: account.global_send_enabled,
    send_breaker_active: account.send_breaker_active,
    account_status: account.account_status,
    is_connected: account.is_connected,
    can_send: account.can_send,
  };
  groups.value = groups.value.map((group) => accountKey(group) === accountKey(account) ? { ...group, ...patch } : group);
  if (selectedGroup.value && accountKey(selectedGroup.value) === accountKey(account)) {
    selectedGroup.value = { ...selectedGroup.value, ...patch };
  }
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
    const stored = window.localStorage.getItem('workbench.serviceRailCollapsed');
    if (stored === '0' || stored === '1') return stored === '1';
    return true;
  } catch (err) {
    return true;
  }
}

function readStoredCustomerProfileOpen() {
  try {
    const stored = window.localStorage.getItem('workbench.customerProfileOpen');
    if (stored === '0' || stored === '1') return stored === '1';
  } catch (_) {}
  return window.innerWidth >= 1180;
}

function toggleCustomerProfile() {
  customerProfileOpen.value = !customerProfileOpen.value;
  try {
    window.localStorage.setItem('workbench.customerProfileOpen', customerProfileOpen.value ? '1' : '0');
  } catch (_) {}
}

async function loadMessages(params = {}) {
  if (!selectedGroup.value) return;
  const group = selectedGroup.value;
  const preserveExisting = Boolean(params.preserve_existing);
  const requestParams = { ...params };
  delete requestParams.preserve_existing;
  // 实时刷新只能复用当前会话代次，不能让首次加载响应失效；切换会话和翻页才开启新代次。
  const requestSeq = preserveExisting ? messageRequestSeq : ++messageRequestSeq;
  const cacheKey = messageCacheKey(group);
  const showInitialLoading = !requestParams.before_id && !preserveExisting;
  if (showInitialLoading) loadingMessages.value = true;
  if (!params.before_id) hydrateCachedMessages(group);
  try {
    const prefetched = !requestParams.before_id ? messagePrefetches.get(cacheKey) : null;
    const page = await (prefetched || fetchMessages(group, {
      ...activeMessageFilterParams(),
      limit: MESSAGE_PAGE_LIMIT,
      ...requestParams,
    }));
    if (
      requestSeq !== messageRequestSeq ||
      !selectedGroup.value ||
      selectedGroup.value.id !== group.id
    ) return;
    const nextMessages = requestParams.before_id
      ? mergeMessages(page.messages, messages.value)
      : (preserveExisting ? mergeMessages(messages.value, page.messages) : page.messages);
    messages.value = nextMessages;
    const nextPaging = preserveExisting ? messagePaging.value : page.paging;
    messagePaging.value = nextPaging;
    writeMessageCache(cacheKey, nextMessages, nextPaging, { loaded: true });
  } catch (err) {
    // 保留已显示的缓存，网络抖动时不让会话窗口退回空白。
  } finally {
    if (
      showInitialLoading &&
      requestSeq === messageRequestSeq &&
      selectedGroup.value &&
      selectedGroup.value.id === group.id
    ) loadingMessages.value = false;
  }
}

function prefetchMessages(group) {
  if (!group) return;
  const cacheKey = messageCacheKey(group);
  if (messageCache.get(cacheKey)?.loaded === true || messagePrefetches.has(cacheKey)) return;
  const request = fetchMessages(group, {
    ...activeMessageFilterParams(),
    limit: MESSAGE_PAGE_LIMIT,
  }).then((page) => {
    if (messageCache.get(cacheKey)?.loaded !== true) {
      writeMessageCache(cacheKey, page.messages, page.paging, { loaded: true });
    }
    return page;
  }).finally(() => {
    if (messagePrefetches.get(cacheKey) === request) messagePrefetches.delete(cacheKey);
  });
  messagePrefetches.set(cacheKey, request);
}

function messageCacheKey(group) {
  return `${group.id}:${JSON.stringify(activeMessageFilterParams())}`;
}

function hydrateCachedMessages(group) {
  const key = messageCacheKey(group);
  const entry = messageCache.get(key);
  if (!entry) {
    messages.value = [];
    messagePaging.value = { has_more: false, before_id: null };
    return false;
  }
  messageCache.delete(key);
  messageCache.set(key, entry);
  messages.value = entry.messages;
  messagePaging.value = entry.paging;
  return entry.loaded === true;
}

function primeMessagePreview(group) {
  const key = messageCacheKey(group);
  if (messageCache.has(key) || !group.last_message_id) return;
  const hasMedia = Boolean(group.has_media);
  const text = String(group.last_content || '').trim() || (hasMedia ? '媒体消息正在加载…' : '最新消息正在加载…');
  const timestamp = Number(group.last_message_time) || Date.now();
  writeMessageCache(key, [{
    id: `preview-${group.id}-${group.last_message_id}`,
    platform: group.platform,
    account: group.account,
    group_id: group.group_id,
    message_id: group.last_native_message_id || null,
    sender_name: group.last_sender_name || group.group_name,
    direction: group.last_direction === 'outbound' ? 'outbound' : 'inbound',
    text,
    display_text: text,
    has_media: hasMedia,
    attachments: [],
    status: group.last_direction === 'outbound' ? 'sent' : 'received',
    timestamp,
    sort_time: timestamp,
    created_at: new Date(timestamp).toISOString(),
    source: 'group-preview',
    provisional: true,
  }], { has_more: false, before_id: null }, { loaded: false });
}

function writeMessageCache(key, nextMessages, paging, options = {}) {
  const previous = messageCache.get(key);
  const loaded = options.loaded === undefined ? previous?.loaded === true : options.loaded === true;
  messageCache.delete(key);
  messageCache.set(key, {
    messages: Array.isArray(nextMessages) ? [...nextMessages] : [],
    paging: paging || { has_more: false, before_id: null },
    loaded,
  });
  while (messageCache.size > MESSAGE_CACHE_LIMIT) {
    messageCache.delete(messageCache.keys().next().value);
  }
}

async function loadWorkspace({ silent = false } = {}) {
  if (!selectedGroup.value) return;
  const requestSeq = ++workspaceRequestSeq;
  if (!silent) loadingWorkspace.value = true;
  try {
    const detail = await fetchGroupWorkspace(selectedGroup.value);
    if (requestSeq !== workspaceRequestSeq) return;
    workspaceDetail.value = detail;
    patchSelectedGroup(profileToGroupPatch(detail.profile, detail));
  } catch (err) {
    if (requestSeq === workspaceRequestSeq) {
      workspaceDetail.value = { profile: null, notes: [], timeline: [], presence: [], notes_paging: {}, timeline_paging: {} };
    }
  } finally {
    if (requestSeq === workspaceRequestSeq && !silent) loadingWorkspace.value = false;
  }
}

function activeMessageFilterParams() {
  return {};
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
  const group = { ...selectedGroup.value };
  const payload = typeof message === 'string' ? { text: message, attachments: [] } : (message || {});
  const text = String(payload.text || '').trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  if (!text && !attachments.length) return;
  const clientMsgId = createClientMsgId();
  const quoteMsgId = payload.quote_msg_id || (quoteMessage.value && (
    quoteMessage.value.remote_msg_id || quoteMessage.value.message_id || quoteMessage.value.raw_id || quoteMessage.value.outbound_id
  ));
  const optimistic = createOptimisticOutbound({
    group,
    clientMsgId,
    text,
    attachments,
    quoteMsgId,
  });
  messages.value = mergeMessages(messages.value, [optimistic]);
  writeMessageCache(messageCacheKey(group), messages.value, messagePaging.value);
  stickToBottom.value = true;
  startPendingRefresh();
  sending.value = true;
  try {
    const reply = await createReply({
      client_msg_id: clientMsgId,
      platform: group.platform,
      account: group.account,
      group_id: group.group_id,
      text,
      attachments,
      quote_msg_id: quoteMsgId,
    });
    composerRef.value?.clearDraft();
    quoteMessage.value = null;
    patchOptimisticOutbound(clientMsgId, {
      id: `outbound-${reply.outbound_id}`,
      outbound_id: reply.outbound_id,
      status: reply.status,
    });
    // 外发任务已进入账本；输入框立即恢复，状态刷新在后台继续。
    sending.value = false;
    Promise.all([
      loadMessages({ preserve_existing: true }),
      loadGroups({ silent: true }),
    ]).catch(() => {});
    if (LIVE_OUTBOUND_STATUSES.has(reply.status)) startPendingRefresh();
  } catch (err) {
    patchOptimisticOutbound(clientMsgId, {
      status: 'failed',
      error_display: '发送任务创建失败，请重新发送',
    });
    updatePendingRefreshState();
    ElMessage.error('发送任务创建失败');
  } finally {
    sending.value = false;
  }
}

function createOptimisticOutbound({ group, clientMsgId, text, attachments, quoteMsgId }) {
  const now = Date.now() / 1000;
  return {
    id: `optimistic-${clientMsgId}`,
    client_msg_id: clientMsgId,
    platform: group.platform,
    account: group.account,
    group_id: group.group_id,
    direction: 'outbound',
    sender_name: group.account_display_name || group.account,
    text,
    display_text: text,
    quote_msg_id: quoteMsgId || null,
    attachments: attachments.map((attachment) => ({ ...attachment })),
    status: 'pending',
    timestamp: now,
    sort_time: now,
    created_at: new Date().toISOString(),
    source: 'workbench',
    optimistic: true,
  };
}

function patchOptimisticOutbound(clientMsgId, patch) {
  const index = messages.value.findIndex((message) => message.client_msg_id === clientMsgId);
  if (index < 0) return;
  const nextMessages = [...messages.value];
  nextMessages[index] = { ...nextMessages[index], ...patch, optimistic: false };
  messages.value = nextMessages;
  if (selectedGroup.value) {
    writeMessageCache(messageCacheKey(selectedGroup.value), nextMessages, messagePaging.value);
  }
}

async function handleChannelSync() {
  if (syncingChannels.value) return;
  const platforms = filters.value.platforms.filter((platform) => ['wa', 'tg'].includes(platform));
  if (!platforms.length) return;
  syncingChannels.value = true;
  try {
    const results = await Promise.all(platforms.map((platform) => requestChannelSync({
      platform,
      accounts: filters.value.accountKeys,
      reason: 'manual',
    })));
    const requestCount = results.reduce((count, result) => count + Number(result.requests?.length || 0), 0);
    ElMessage.success(`已请求同步 ${requestCount} 个账号，完成后自动刷新`);
    startChannelRefreshPolling();
  } catch (err) {
    ElMessage.error('同步请求失败');
  } finally {
    syncingChannels.value = false;
  }
}

function startChannelRefreshPolling() {
  stopChannelRefreshPolling();
  let attempts = 0;
  const refresh = async () => {
    if (channelRefreshInFlight) return;
    channelRefreshInFlight = true;
    attempts += 1;
    try {
      await Promise.all([
        loadLabels(),
        loadManualGroups(),
        loadGroups({ silent: true }),
      ]);
    } finally {
      channelRefreshInFlight = false;
      if (attempts >= CHANNEL_REFRESH_MAX_ATTEMPTS) stopChannelRefreshPolling();
    }
  };
  refresh().catch(() => {});
  channelRefreshTimer = setInterval(() => refresh().catch(() => {}), CHANNEL_REFRESH_MS);
}

function stopChannelRefreshPolling() {
  if (channelRefreshTimer) clearInterval(channelRefreshTimer);
  channelRefreshTimer = null;
  channelRefreshInFlight = false;
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
    await loadWorkspace({ silent: true });
    ElMessage.success('工作台标签已创建');
  } catch (err) {
    ElMessage.error('工作台标签创建失败');
  } finally {
    savingManualGroups.value = false;
  }
}

async function handleManualGroupsChange(manualGroupIds) {
  if (!selectedGroup.value || savingManualGroups.value) return;
  savingManualGroups.value = true;
  try {
    await persistManualGroups(manualGroupIds);
    await loadWorkspace({ silent: true });
    ElMessage.success('会话标签已更新');
  } catch (err) {
    ElMessage.error('会话标签保存失败');
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

async function handleWorkspaceSave(payload) {
  if (!selectedGroup.value) return;
  const targetGroup = selectedGroup.value;
  try {
    const profile = await saveGroupWorkspace(targetGroup, payload);
    if (!sameConversation(selectedGroup.value, targetGroup)) return;
    workspaceDetail.value = {
      ...workspaceDetail.value,
      profile,
    };
    patchSelectedGroup(profileToGroupPatch(profile, workspaceDetail.value));
    await loadWorkspace({ silent: true });
    await loadGroups({ silent: true, clearSelectionOnMissing: true });
  } catch (err) {
    if (!sameConversation(selectedGroup.value, targetGroup)) return;
    await loadWorkspace({ silent: true });
    ElMessage.error('会话资料保存失败');
  }
}

async function handleLoadMoreNotes() {
  if (!selectedGroup.value) return;
  const groupId = selectedGroup.value.id;
  const result = await fetchGroupNotes(selectedGroup.value, {
    limit: 20,
    before_id: workspaceDetail.value.notes_paging?.before_id || undefined,
  });
  if (!selectedGroup.value || selectedGroup.value.id !== groupId) return;
  workspaceDetail.value = {
    ...workspaceDetail.value,
    notes: [...(workspaceDetail.value.notes || []), ...result.notes],
    notes_paging: result.paging,
  };
}

async function handleLoadMoreTimeline() {
  if (!selectedGroup.value) return;
  const groupId = selectedGroup.value.id;
  const result = await fetchGroupTimeline(selectedGroup.value, {
    limit: 50,
    before_id: workspaceDetail.value.timeline_paging?.before_id || undefined,
  });
  if (!selectedGroup.value || selectedGroup.value.id !== groupId) return;
  workspaceDetail.value = {
    ...workspaceDetail.value,
    timeline: [...(workspaceDetail.value.timeline || []), ...result.timeline],
    timeline_paging: result.paging,
  };
}

async function handleNoteCreate(body) {
  if (!selectedGroup.value || !String(body || '').trim()) return;
  try {
    const note = await createGroupNote(selectedGroup.value, body);
    workspaceDetail.value = {
      ...workspaceDetail.value,
      notes: note ? [note, ...(workspaceDetail.value.notes || [])] : workspaceDetail.value.notes,
    };
    await loadWorkspace({ silent: true });
    await loadGroups({ silent: true });
    ElMessage.success('内部备注已添加');
  } catch (err) {
    ElMessage.error('内部备注添加失败');
  }
}

async function handleNoteDelete(note) {
  if (!selectedGroup.value || !note?.id) return;
  const groupId = selectedGroup.value.id;
  try {
    await deleteGroupNote(selectedGroup.value, note.id);
    if (!selectedGroup.value || selectedGroup.value.id !== groupId) return;
    workspaceDetail.value = {
      ...workspaceDetail.value,
      notes: (workspaceDetail.value.notes || []).filter((item) => String(item.id) !== String(note.id)),
    };
    await loadWorkspace({ silent: true });
    await loadGroups({ silent: true });
    ElMessage.success('内部备注已删除');
  } catch (err) {
    ElMessage.error(err?.response?.status === 403 ? '只能删除自己创建的备注' : '内部备注删除失败');
  }
}

function profileToGroupPatch(profile, detail = {}) {
  if (!profile) return {};
  return {
    conversation_status: profile.status,
    status: profile.status,
    priority: profile.priority,
    starred: Boolean(profile.starred),
    follow_up_at: profile.follow_up_at,
    internal_display_name: profile.internal_display_name,
    customer_type_id: profile.customer_type_id,
    customer_type: profile.customer_type,
    owner_note: profile.owner_note,
    notes_count: (detail.notes || workspaceDetail.value.notes || []).length,
    presence: detail.presence || workspaceDetail.value.presence || [],
  };
}

function handleQuote(message) {
  if (!message) return;
  quoteMessage.value = message;
}

function clearQuote() {
  quoteMessage.value = null;
}

async function handleTypingState(active) {
  if (!selectedGroup.value) return;
  clearTimeout(typingPresenceTimer);
  if (!active) {
    updateGroupPresence(selectedGroup.value, 'typing', false).catch(() => {});
    return;
  }
  updateGroupPresence(selectedGroup.value, 'typing', true).catch(() => {});
  typingPresenceTimer = setTimeout(() => {
    if (selectedGroup.value) updateGroupPresence(selectedGroup.value, 'typing', false).catch(() => {});
  }, 4500);
}

function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  if (!selectedGroup.value) return;
  sendPresenceHeartbeat();
  presenceHeartbeatTimer = setInterval(sendPresenceHeartbeat, 45000);
}

function stopPresenceHeartbeat() {
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
  presenceHeartbeatTimer = null;
}

function sendPresenceHeartbeat() {
  if (!selectedGroup.value) return;
  updateGroupPresence(selectedGroup.value, 'viewing', true)
    .then((presence) => {
      workspaceDetail.value = { ...workspaceDetail.value, presence };
      patchSelectedGroup({ presence });
    })
    .catch(() => {});
}

function clearPresence(group = selectedGroup.value) {
  stopPresenceHeartbeat();
  if (!group) return;
  updateGroupPresence(group, 'viewing', false).catch(() => {});
  updateGroupPresence(group, 'typing', false).catch(() => {});
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
  await loadWorkspace({ silent: true });
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

function openServiceLogin() {
  navigateTo('/service-account-login');
}

async function handleRetry(message) {
  if (!message.outbound_id) return;
  await retryOutbound(message.outbound_id);
  stickToBottom.value = true;
  await loadMessages({ preserve_existing: true });
  await loadWorkspace({ silent: true });
  startPendingRefresh();
}

async function handleCancel(message) {
  if (!message.outbound_id) return;
  await cancelOutbound(message.outbound_id);
  ElMessage.success('已取消外发任务');
  stickToBottom.value = true;
  await loadMessages({ preserve_existing: true });
  await loadWorkspace({ silent: true });
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
    .map((group) => (sameConversation(group, nextGroup) ? { ...group, ...patch } : group))
    .filter(groupMatchesActiveScope);
}

function sameConversation(left, right) {
  return Boolean(left && right &&
    String(left.platform || '') === String(right.platform || '') &&
    String(left.account || '') === String(right.account || '') &&
    String(left.group_id || '') === String(right.group_id || ''));
}

function selectedManualGroupIds(group) {
  return ((group && group.labels) || [])
    .filter((label) => label && (Number(label.is_manual) === 1 || String(label.source || '').startsWith('manual')))
    .map((label) => String(label.native_group_id || label.native_label_id || '').trim())
    .filter(Boolean);
}

function groupMatchesActiveScope(group) {
  if (filters.value.scope === 'unread') return Number(group.unread_count || 0) > 0;
  return true;
}

function handleGlobalShortcut(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const tagName = String(target && target.tagName || '').toLowerCase();
  const isEditable = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable;
  if (isEditable) return;
  if (event.key === 'Escape') {
    if (quoteMessage.value) {
      quoteMessage.value = null;
      event.preventDefault();
    }
    return;
  }
  if (!groups.value.length) return;
  if (event.key === 'j' || event.key === 'J') {
    moveSelection(1);
    event.preventDefault();
  } else if (event.key === 'k' || event.key === 'K') {
    moveSelection(-1);
    event.preventDefault();
  } else if (event.key === 'm' || event.key === 'M') {
    handleMarkRead().catch(() => {});
    event.preventDefault();
  }
}

function moveSelection(delta) {
  if (!groups.value.length) return;
  const currentIndex = selectedGroup.value
    ? groups.value.findIndex((group) => group.id === selectedGroup.value.id)
    : -1;
  const nextIndex = currentIndex < 0
    ? 0
    : Math.max(0, Math.min(groups.value.length - 1, currentIndex + delta));
  selectGroup(groups.value[nextIndex]);
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    refreshActiveConversation({ keepStickToBottom: false }).catch(() => {});
  }, AUTO_REFRESH_MS);
}

function handleForegroundRefresh() {
  if (document.hidden) return;
  refreshActiveConversation({ keepStickToBottom: true, forceAncillary: true }).catch(() => {});
}

function handleVisibilityRefresh() {
  if (!document.hidden) handleForegroundRefresh();
}

async function handleNotificationToggle() {
  const result = await notifier.toggle();
  if (result.denied) ElMessage.warning('浏览器未授予桌面通知权限');
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

async function refreshActiveConversation({ keepStickToBottom = false, forceAncillary = false } = {}) {
  if (refreshingActive || document.hidden) return;
  // 首次消息尚未返回时，暂停后台轮询，优先让用户点击触发的消息请求完成。
  if (loadingMessages.value) return;
  refreshingActive = true;
  const previousStickToBottom = stickToBottom.value;
  try {
    if (keepStickToBottom && previousStickToBottom) stickToBottom.value = true;
    const now = Date.now();
    const refreshes = [];
    if (forceAncillary || now - lastGroupLiveRefreshAt >= GROUP_LIVE_REFRESH_MS) {
      lastGroupLiveRefreshAt = now;
      refreshes.push(loadGroups({ silent: true }));
    }
    if (selectedGroup.value) refreshes.push(loadMessages({ preserve_existing: true }));
    if (selectedGroup.value && (forceAncillary || now - lastWorkspaceLiveRefreshAt >= WORKSPACE_LIVE_REFRESH_MS)) {
      lastWorkspaceLiveRefreshAt = now;
      refreshes.push(loadWorkspace({ silent: true }));
    }
    await Promise.all(refreshes);
    updatePendingRefreshState();
  } finally {
    if (!keepStickToBottom) stickToBottom.value = previousStickToBottom;
    refreshingActive = false;
  }
}

function startConversationEventStream(group) {
  if (!group) return;
  stopConversationEvents = subscribeConversationEvents(group, {
    onRefresh: () => {
      clearTimeout(conversationEventRefreshTimer);
      conversationEventRefreshTimer = setTimeout(() => {
        if (!selectedGroup.value || selectedGroup.value.id !== group.id) return;
        Promise.all([
          loadMessages({ preserve_existing: true }),
          loadGroups({ silent: true }),
        ]).catch(() => {});
      }, 40);
    },
  });
}

function stopConversationEventStream() {
  clearTimeout(conversationEventRefreshTimer);
  conversationEventRefreshTimer = null;
  if (typeof stopConversationEvents === 'function') stopConversationEvents();
  stopConversationEvents = null;
}

function startWorkbenchEventStream() {
  stopWorkbenchEventStream();
  realtimeState.value = 'connecting';
  stopWorkbenchEvents = subscribeWorkbenchEvents({
    onOpen: () => { realtimeState.value = 'connected'; },
    onReady: () => { realtimeState.value = 'connected'; },
    onError: () => { realtimeState.value = 'reconnecting'; },
    onEvent: handleWorkbenchEvent,
  });
}

function stopWorkbenchEventStream() {
  clearTimeout(workbenchEventRefreshTimer);
  workbenchEventRefreshTimer = null;
  workbenchEventNeedsMessages = false;
  if (typeof stopWorkbenchEvents === 'function') stopWorkbenchEvents();
  stopWorkbenchEvents = null;
}

function handleWorkbenchEvent(event) {
  const isSelected = selectedGroup.value && (
    String(selectedGroup.value.platform) === String(event.platform) &&
    String(selectedGroup.value.account) === String(event.account) &&
    String(selectedGroup.value.group_id) === String(event.group_id)
  );
  if (isSelected) workbenchEventNeedsMessages = true;
  if (event.event_type === 'inbound' && shouldNotifyInbound(event)) {
    const group = groups.value.find((item) => (
      String(item.platform) === String(event.platform) &&
      String(item.account) === String(event.account) &&
      String(item.group_id) === String(event.group_id)
    ));
    notifier.notifyInbound({ ...event, groupName: group?.group_name || '收到新客户消息' });
  }
  clearTimeout(workbenchEventRefreshTimer);
  workbenchEventRefreshTimer = setTimeout(() => {
    const refreshes = [loadGroups({ silent: true })];
    if (workbenchEventNeedsMessages && selectedGroup.value) {
      refreshes.push(loadMessages({ preserve_existing: true }));
    }
    workbenchEventNeedsMessages = false;
    Promise.all(refreshes).then(updatePendingRefreshState).catch(() => {});
  }, 60);
}

function shouldNotifyInbound(event) {
  const key = `${event.platform}:${event.account}:${event.group_id}`;
  const now = Date.now();
  const previous = recentInboundEvents.get(key) || 0;
  recentInboundEvents.set(key, now);
  for (const [entryKey, seenAt] of recentInboundEvents) {
    if (now - seenAt > 5000) recentInboundEvents.delete(entryKey);
  }
  return now - previous > 1500;
}

function updatePendingRefreshState() {
  const hasLiveOutbound = messages.value.some((message) => (
    message.source === 'workbench' && LIVE_OUTBOUND_STATUSES.has(message.status)
  ));
  const expired = pendingRefreshStartedAt && Date.now() - pendingRefreshStartedAt > PENDING_REFRESH_MAX_MS;
  if (!hasLiveOutbound || expired) stopPendingRefresh();
}
</script>
