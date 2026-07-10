<template>
  <section class="thread-pane">
    <header v-if="group" class="thread-header">
      <div class="thread-title">
        <div class="platform-icon large" :class="platformClass(group.platform)">
          {{ platformShort(group.platform) }}
        </div>
        <div>
          <div class="thread-name-line">
            <div v-if="workbenchTags.length" class="thread-title-tags" aria-label="工作台标签">
              <span
                v-for="label in workbenchTags"
                :key="label.id || label.native_group_id || label.native_label_id"
                class="group-tag workbench-tag"
                :title="labelTitle(label)"
              >
                {{ labelDisplayName(label) }}
              </span>
            </div>
            <h1 :title="group.group_name">{{ group.group_name }}</h1>
          </div>
          <p>{{ platformName(group.platform) }} <span>|</span> 通过 {{ accountDisplayName }} 观测和回复</p>
          <div class="thread-status-line">
            <em :class="canSend(group) ? 'status-ok' : 'status-warn'">
              {{ canSend(group) ? '可发送' : '只读' }}
            </em>
            <em :class="group.sync_groups_enabled ? 'status-ok' : 'status-neutral'">
              {{ group.sync_groups_enabled ? '同步渠道分组' : '工作台标签' }}
            </em>
            <em class="status-neutral">{{ accountRoleText(group.account_role) }}</em>
          </div>
        </div>
      </div>
      <div class="thread-actions">
        <el-popover placement="bottom-end" :width="360" trigger="click">
          <template #reference>
            <el-button class="thread-tag-button">工作台标签</el-button>
          </template>
          <div class="thread-tag-popover">
            <div class="section-title">工作台标签</div>
            <div class="tag-stack">
              <span
                v-for="label in workbenchTags"
                :key="label.id || label.native_group_id || label.native_label_id"
                class="group-tag workbench-tag"
                :title="labelTitle(label)"
              >
                {{ labelDisplayName(label) }}
              </span>
              <span v-if="!workbenchTags.length" class="group-tag muted">暂无标签</span>
            </div>
            <el-select
              class="manual-group-select"
              :model-value="selectedManualGroupIds"
              multiple
              clearable
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择或移除工作台标签"
              :disabled="!canManageManualGroups || savingManualGroups"
              @change="emit('manual-groups-change', $event)"
            >
              <el-option
                v-for="option in manualGroupOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              >
                <div class="manual-group-option" :class="{ child: option.level === 2 }">
                  <span>{{ option.name }}</span>
                  <small>{{ option.subtitle }}</small>
                </div>
              </el-option>
            </el-select>
            <div class="manual-create-row">
              <el-input
                v-model="manualDraft.name"
                size="small"
                clearable
                placeholder="新标签名称"
                :disabled="!canManageManualGroups || savingManualGroups"
              />
              <el-button
                size="small"
                type="primary"
                :loading="savingManualGroups"
                :disabled="!canSubmitManualGroup"
                @click="submitManualGroup"
              >
                新建并打标
              </el-button>
            </div>
            <div class="manual-tag-helper">{{ manualHelperText }}</div>
          </div>
        </el-popover>
      </div>
    </header>

    <div v-if="group" class="message-search-bar">
      <input
        v-model="localSearch.message_search"
        type="search"
        placeholder="搜索当前会话"
        @keydown.enter.prevent="applyMessageSearch"
      >
      <input
        v-model="localSearch.sender"
        type="search"
        placeholder="发送人"
        @keydown.enter.prevent="applyMessageSearch"
      >
      <input v-model="localSearch.date_from" type="date" aria-label="开始日期">
      <input v-model="localSearch.date_to" type="date" aria-label="结束日期">
      <label>
        <input v-model="localSearch.has_attachment" type="checkbox">
        附件
      </label>
      <button type="button" @click="applyMessageSearch">筛选</button>
      <button type="button" @click="clearMessageSearch">清空</button>
    </div>

    <div v-if="!group" class="thread-empty">
      <div class="empty-illustration">IN</div>
      <strong>选择一个会话查看消息</strong>
      <span>工作台线程按服务账号隔离展示，不合并不同账号看到的同群消息。</span>
    </div>
    <div v-else class="message-scroll" ref="scrollRef" @scroll="handleScroll">
      <div v-if="paging && paging.has_more" class="load-older-row">
        <el-button :loading="loadingOlder" @click="$emit('load-older')">加载更早消息</el-button>
      </div>

      <div
        v-for="message in messages"
        :key="message.id"
        class="message-row"
        :class="message.direction === 'outbound' ? 'outbound' : 'inbound'"
        :data-raw-id="message.raw_id || null"
        :data-readable="isReadableMessage(message) ? 'true' : null"
      >
        <div v-if="message.direction !== 'outbound'" class="sender-chip">客</div>
        <article class="bubble" :class="{ failed: message.status === 'failed' || message.status === 'dead' }">
          <div class="bubble-author">{{ message.direction === 'outbound' ? accountDisplayName : message.sender_name }}</div>
          <blockquote v-if="message.quote_msg_id">引用消息 {{ message.quote_msg_id }}</blockquote>
          <p>{{ message.display_text || message.text || (message.has_media ? '[媒体消息]' : '') }}</p>
          <div v-if="message.attachments && message.attachments.length" class="attachment-stack">
            <div
              v-for="attachment in message.attachments"
              :key="attachment.id || attachment.name"
              class="attachment-row"
            >
              <img
                v-if="attachmentPreview(attachment)"
                :src="attachmentPreview(attachment)"
                alt=""
              >
              <el-icon v-else><Document /></el-icon>
              <span class="attachment-name" :title="attachment.name || '附件'">
                {{ attachment.name || '附件' }}
              </span>
            </div>
          </div>
          <div v-if="message.error_display || message.error_message" class="status-detail">
            {{ message.error_display || message.error_message }}
          </div>
          <footer>
            <time>{{ formatMessageTime(message.timestamp || message.created_at) }}</time>
            <span v-if="statusText(message.status)" class="status" :class="`status-${message.status}`">
              {{ statusText(message.status) }}
            </span>
            <button
              type="button"
              class="message-action-button"
              @click="$emit('quote', message)"
            >
              引用
            </button>
            <button
              v-if="['pending', 'paused'].includes(message.status) && canSend(group)"
              type="button"
              class="message-action-button"
              @click="$emit('cancel', message)"
            >
              取消
            </button>
            <button
              v-if="['failed', 'dead', 'paused', 'canceled'].includes(message.status) && canSend(group)"
              type="button"
              class="message-action-button danger"
              @click="$emit('retry', message)"
            >
              重试
            </button>
          </footer>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { Document } from '@element-plus/icons-vue';
import { formatMessageTime, platformClass, platformName, statusText } from '../utils/format';

const props = defineProps({
  group: {
    type: Object,
    default: null,
  },
  messages: {
    type: Array,
    default: () => [],
  },
  paging: {
    type: Object,
    default: () => ({ has_more: false, before_id: null }),
  },
  loadingOlder: {
    type: Boolean,
    default: false,
  },
  stickToBottom: {
    type: Boolean,
    default: true,
  },
  currentOperatorId: {
    type: String,
    default: 'demo-operator',
  },
  messageFilters: {
    type: Object,
    default: () => ({}),
  },
  manualGroups: {
    type: Array,
    default: () => [],
  },
  savingManualGroups: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  'retry',
  'cancel',
  'load-older',
  'read-progress',
  'stick-state-change',
  'quote',
  'message-search-change',
  'manual-groups-change',
  'manual-group-create',
]);

const scrollRef = ref(null);
const localSearch = reactive({
  message_search: '',
  sender: '',
  date_from: '',
  date_to: '',
  has_attachment: false,
});
const lastStickState = ref(true);
const lastReadProgress = ref({ groupId: '', rawId: 0 });
const manualDraft = reactive({ name: '' });
const BOTTOM_THRESHOLD_PX = 96;
const READ_VISIBLE_THRESHOLD_PX = 24;

watch(
  () => [props.group && props.group.id, props.messages.length],
  async () => {
    await nextTick();
    if (props.stickToBottom && scrollRef.value) scrollToBottom();
    reportVisibleReadProgress();
  },
);

watch(
  () => props.group && props.group.id,
  () => {
    lastStickState.value = true;
  },
);

watch(
  () => props.messageFilters,
  (filters = {}) => {
    localSearch.message_search = filters.message_search || '';
    localSearch.sender = filters.sender || '';
    localSearch.date_from = filters.date_from || '';
    localSearch.date_to = filters.date_to || '';
    localSearch.has_attachment = Boolean(filters.has_attachment);
  },
  { immediate: true, deep: true },
);

const accountDisplayName = computed(() => {
  if (!props.group) return '';
  return props.group.account_display_name || props.group.account || '';
});

function platformShort(platform) {
  if (platform === 'wa') return 'W';
  if (platform === 'tg') return 'T';
  return '?';
}

function accountRoleText(role) {
  if (role === 'service') return '服务账号';
  if (role === 'both') return '双用途';
  if (role === 'collector') return '采集账号';
  return role || '服务账号';
}

function canSend(group) {
  return Boolean(
    group &&
    group.send_enabled !== false &&
    Number(group.send_enabled) !== 0 &&
    (!group.permissions || group.permissions.can_reply !== false)
  );
}

const canManageManualGroups = computed(() => (
  props.group &&
  props.group.permissions &&
  props.group.permissions.can_manage === true
));

const workbenchTags = computed(() => (
  ((props.group && props.group.labels) || []).filter(isWorkbenchTag)
));

const selectedManualGroupIds = computed(() => (
  workbenchTags.value
    .map((label) => String(label.native_group_id || label.native_label_id || '').trim())
    .filter(Boolean)
));

const accountManualGroups = computed(() => {
  if (!props.group) return [];
  return props.manualGroups.filter((item) => (
    item.platform === props.group.platform &&
    item.service_account === props.group.account
  ));
});

const levelOneManualGroups = computed(() => (
  accountManualGroups.value
    .filter((item) => Number(item.group_level || 1) === 1)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'))
));

const manualGroupOptions = computed(() => {
  const parents = new Map(levelOneManualGroups.value.map((item) => [String(item.native_group_id), item]));
  return accountManualGroups.value
    .map((item) => {
      const level = Number(item.group_level || 1);
      const parent = item.parent_native_group_id ? parents.get(String(item.parent_native_group_id)) : null;
      return {
        value: item.native_group_id,
        name: item.name,
        level,
        label: parent ? `${parent.name} / ${item.name}` : item.name,
        subtitle: parent ? '工作台标签 · 子标签' : '工作台标签',
        sortKey: `${parent ? parent.name : item.name}:${level}:${item.name}`,
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'zh-Hans-CN'));
});

const canSubmitManualGroup = computed(() => (
  canManageManualGroups.value &&
  !props.savingManualGroups &&
  Boolean(manualDraft.name.trim())
));

const manualHelperText = computed(() => (
  canManageManualGroups.value ? '标签保存在工作台自己的数据库中，不会写回 WA/TG 原生分组。' : '当前账号没有标签管理权限'
));

watch(
  () => props.group && props.group.id,
  () => {
    manualDraft.name = '';
  },
);

function submitManualGroup() {
  if (!canSubmitManualGroup.value) return;
  emit('manual-group-create', { name: manualDraft.name.trim(), group_level: 1 });
  manualDraft.name = '';
}

function isWorkbenchTag(label) {
  return Number(label?.is_manual) === 1 || String(label?.source || '').startsWith('manual');
}

function labelDisplayName(label) {
  if (!label) return '';
  const name = label.name || label.native_label_id || label.native_group_id || '';
  return isWorkbenchTag(label) && label.parent_name ? `${label.parent_name} / ${name}` : name;
}

function labelTitle(label) {
  return `工作台标签 · ${labelDisplayName(label)}`;
}

function attachmentPreview(attachment) {
  if (!attachment) return '';
  const dataUrl = attachment.preview_url || attachment.data_url;
  if (!dataUrl || typeof dataUrl !== 'string') return '';
  const type = attachment.type || '';
  if (attachment.kind === 'image' || attachment.kind === 'sticker' || type.startsWith('image/')) return dataUrl;
  return '';
}

function applyMessageSearch() {
  emit('message-search-change', { ...localSearch });
}

function clearMessageSearch() {
  localSearch.message_search = '';
  localSearch.sender = '';
  localSearch.date_from = '';
  localSearch.date_to = '';
  localSearch.has_attachment = false;
  applyMessageSearch();
}

function scrollToBottom() {
  const el = scrollRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  updateStickState(true);
}

function handleScroll() {
  const el = scrollRef.value;
  if (!el) return;
  updateStickState(isNearBottom(el));
  reportVisibleReadProgress();
}

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
}

function updateStickState(nextState) {
  if (lastStickState.value === nextState) return;
  lastStickState.value = nextState;
  emit('stick-state-change', nextState);
}

function isReadableMessage(message) {
  return Boolean(message && message.raw_id && message.direction !== 'outbound');
}

function reportVisibleReadProgress() {
  const el = scrollRef.value;
  if (!el || !props.group) return;
  const containerRect = el.getBoundingClientRect();
  const rows = Array.from(el.querySelectorAll('.message-row[data-readable="true"][data-raw-id]'));
  let maxVisibleRawId = 0;
  rows.forEach((row) => {
    const rowRect = row.getBoundingClientRect();
    const visibleHeight = Math.min(rowRect.bottom, containerRect.bottom) - Math.max(rowRect.top, containerRect.top);
    if (visibleHeight < Math.min(rowRect.height, READ_VISIBLE_THRESHOLD_PX)) return;
    maxVisibleRawId = Math.max(maxVisibleRawId, Number(row.dataset.rawId) || 0);
  });
  if (!maxVisibleRawId) return;
  const groupId = props.group.id;
  if (lastReadProgress.value.groupId === groupId && maxVisibleRawId <= lastReadProgress.value.rawId) return;
  lastReadProgress.value = { groupId, rawId: maxVisibleRawId };
  emit('read-progress', {
    groupId,
    platform: props.group.platform,
    account: props.group.account,
    group_id: props.group.group_id,
    last_read_message_id: maxVisibleRawId,
  });
}
</script>
