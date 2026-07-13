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
    @delete-account="handleDeleteServiceAccount"
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
        @sync-channels="handleChannelSync"
        @toggle-customer-profile="toggleCustomerProfile"
      />

      <main class="workbench-grid" :class="{ 'profile-collapsed': !customerProfileOpen }">
        <ConversationList
          :groups="groups"
          :loading="loadingGroups"
          :selected-id="selectedGroup && selectedGroup.id"
          :scope-label="scopeLabel"
          :search="filters.search"
          @select="selectGroup"
          @refresh="loadGroups"
          @search-change="(search) => filters = { ...filters, search }"
        />

        <div class="thread-shell">
          <MessageThread
            :group="selectedGroup"
            :messages="messages"
            :paging="messagePaging"
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
            :group="selectedGroup"
            :sending="sending"
            :quote-message="quoteMessage"
            @send="handleSend"
            @clear-quote="clearQuote"
            @typing-state="handleTypingState"
          />
        </div>

        <ConversationInspector
          :group="selectedGroup"
          :workspace-detail="workspaceDetail"
          @workspace-save="handleWorkspaceSave"
          @note-create="handleNoteCreate"
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
import ElMessageBox from 'element-plus/es/components/message-box/index.mjs';
import ServiceAccountRail from './components/ServiceAccountRail.vue';
import TopFilters from './components/TopFilters.vue';
import ConversationList from './components/ConversationList.vue';
import MessageThread from './components/MessageThread.vue';
import Composer from './components/Composer.vue';
import ConversationInspector from './components/ConversationInspector.vue';

const AccountSettings = defineAsyncComponent(() => import('./components/AccountSettings.vue'));
const PermissionConfig = defineAsyncComponent(() => import('./components/PermissionConfig.vue'));
const ServiceAccountAccess = defineAsyncComponent(() => import('./components/ServiceAccountAccess.vue'));
const ServiceAccountLogin = defineAsyncComponent(() => import('./components/ServiceAccountLogin.vue'));
import {
  cancelOutbound,
  createClientMsgId,
  createGroupNote,
  createManualGroup,
  createReply,
  deleteServiceAccount,
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

const AUTO_REFRESH_MS = 5000;
const PENDING_REFRESH_MS = 1500;
const PENDING_REFRESH_MAX_MS = 45000;
const READ_PROGRESS_DEBOUNCE_MS = 350;
const FILTER_DEBOUNCE_MS = 80;
const CHANNEL_REFRESH_MS = 700;
const CHANNEL_REFRESH_MAX_ATTEMPTS = 20;
const MESSAGE_PAGE_LIMIT = 60;
const MESSAGE_CACHE_LIMIT = 24;
const WORKBENCH_CACHE_TTL_MS = 10 * 60 * 1000;
const WORKBENCH_GROUP_CACHE_TTL_MS = 2 * 60 * 1000;
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
let readProgressTimer = null;
let pendingReadProgress = null;
let readProgressInFlight = false;
let labelRequestSeq = 0;
let workspaceRequestSeq = 0;
let groupsRequestSeq = 0;
let messageRequestSeq = 0;
const messageCache = new Map();
let bootstrapRetryTimer = null;
let bootstrapRetryCount = 0;
let activeCacheUserId = '';
let cacheWriteTimer = null;
let restoringWorkbenchCache = false;
let presenceHeartbeatTimer = null;
let typingPresenceTimer = null;
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

  const authUser = await hydrateWorkbenchAuth();
  if (!authUser && isAuthRedirecting()) return;
  if (currentView.value === 'admin') return;
  hydrateWorkbenchCache(authUser);
  await bootstrapWorkbench();
});

onBeforeUnmount(() => {
  window.removeEventListener('popstate', syncRouteFromLocation);
  window.removeEventListener('keydown', handleGlobalShortcut);
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
    if (restoringWorkbenchCache) return;
    clearTimeout(searchTimer);
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
    if (selectedGroup.value) {
      hydrateCachedMessages(selectedGroup.value);
      loadMessages().catch(() => {});
      loadWorkspace().catch(() => {});
      startPresenceHeartbeat();
    }
    else {
      messages.value = [];
      messagePaging.value = { has_more: false, before_id: null };
      workspaceDetail.value = { profile: null, notes: [], timeline: [], presence: [], notes_paging: {}, timeline_paging: {} };
      stopPresenceHeartbeat();
    }
  },
);

async function loadGroups({ silent = false, clearSelectionOnMissing = false, useRetry = false } = {}) {
  const requestSeq = ++groupsRequestSeq;
  if (!silent && !groups.value.length) loadingGroups.value = true;
  error.value = '';
  noServiceAccount.value = false;
  try {
    const request = () => fetchGroups({
      platforms: filters.value.platforms.join(','),
      accounts: selectedAccountParam.value,
      scope: filters.value.scope,
      label_id: filters.value.labelId || undefined,
      search: filters.value.search || undefined,
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
    }
  } catch (_) {
    // 旧格式或被清理的浏览器存储不影响正常加载。
  } finally {
    restoringWorkbenchCache = false;
  }
}

function groupFilterCacheKey() {
  return JSON.stringify({
    platforms: filters.value.platforms,
    accountKeys: filters.value.accountKeys,
    scope: filters.value.scope,
    labelId: filters.value.labelId,
    search: filters.value.search,
  });
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

async function handleDeleteServiceAccount(account) {
  if (!account || isConnectedAccount(account)) return;
  const label = account.account_display_name || account.account;
  try {
    await ElMessageBox.confirm(
      `将永久删除 ${label}（${account.account}）及其登录任务、会话数据和本地 session。此操作不可恢复。`,
      '删除未接入账号',
      { confirmButtonText: '永久删除', cancelButtonText: '取消', type: 'warning' },
    );
    await deleteServiceAccount(account.platform, account.account);
    accounts.value = accounts.value.filter((item) => accountKey(item) !== accountKey(account));
    if (filters.value.accountKeys.includes(accountKey(account))) clearServiceAccount();
    await Promise.all([loadLabels(), loadManualGroups(), loadGroups({ silent: true })]);
    ElMessage.success('残留服务账号已删除');
  } catch (err) {
    if (err === 'cancel' || err === 'close') return;
    ElMessage.error('删除失败，请稍后重试');
  }
}

function handleServiceAccountSettingsChange(account) {
  accounts.value = accounts.value.map((item) => accountKey(item) === accountKey(account) ? { ...item, ...account } : item);
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
  const requestSeq = ++messageRequestSeq;
  const cacheKey = messageCacheKey(group);
  if (!params.before_id) hydrateCachedMessages(group);
  try {
    const page = await fetchMessages(group, {
      ...activeMessageFilterParams(),
      limit: MESSAGE_PAGE_LIMIT,
      ...params,
    });
    if (
      requestSeq !== messageRequestSeq ||
      !selectedGroup.value ||
      selectedGroup.value.id !== group.id
    ) return;
    const nextMessages = params.before_id
      ? mergeMessages(page.messages, messages.value)
      : page.messages;
    messages.value = nextMessages;
    messagePaging.value = page.paging;
    writeMessageCache(cacheKey, nextMessages, page.paging);
  } catch (err) {
    // 保留已显示的缓存，网络抖动时不让会话窗口退回空白。
  }
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
    return;
  }
  messageCache.delete(key);
  messageCache.set(key, entry);
  messages.value = entry.messages;
  messagePaging.value = entry.paging;
}

function writeMessageCache(key, nextMessages, paging) {
  messageCache.delete(key);
  messageCache.set(key, {
    messages: Array.isArray(nextMessages) ? [...nextMessages] : [],
    paging: paging || { has_more: false, before_id: null },
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
      quote_msg_id: payload.quote_msg_id || (quoteMessage.value && (
        quoteMessage.value.remote_msg_id || quoteMessage.value.message_id || quoteMessage.value.raw_id || quoteMessage.value.outbound_id
      )),
    });
    stickToBottom.value = true;
    quoteMessage.value = null;
    // 外发任务已经写入工作台账本后立即恢复输入，消息/列表刷新放到后台并行执行。
    sending.value = false;
    await Promise.all([
      loadMessages(),
      loadGroups({ silent: true }),
    ]);
    if (LIVE_OUTBOUND_STATUSES.has(reply.status)) startPendingRefresh();
  } catch (err) {
    ElMessage.error('发送任务创建失败');
  } finally {
    sending.value = false;
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
  const groupId = selectedGroup.value.id;
  try {
    const profile = await saveGroupWorkspace(selectedGroup.value, payload);
    if (!selectedGroup.value || selectedGroup.value.id !== groupId) return;
    workspaceDetail.value = {
      ...workspaceDetail.value,
      profile,
    };
    patchSelectedGroup(profileToGroupPatch(profile, workspaceDetail.value));
    await loadWorkspace({ silent: true });
    await loadGroups({ silent: true, clearSelectionOnMissing: true });
  } catch (err) {
    if (!selectedGroup.value || selectedGroup.value.id !== groupId) return;
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
  await loadMessages();
  await loadWorkspace({ silent: true });
  startPendingRefresh();
}

async function handleCancel(message) {
  if (!message.outbound_id) return;
  await cancelOutbound(message.outbound_id);
  ElMessage.success('已取消外发任务');
  stickToBottom.value = true;
  await loadMessages();
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
    if (selectedGroup.value) {
      await loadMessages();
      await loadWorkspace({ silent: true });
    }
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
