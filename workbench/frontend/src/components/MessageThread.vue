<template>
  <section class="thread-pane">
    <header v-if="group" class="thread-header">
      <div class="thread-title">
        <div class="platform-icon large" :class="platformClass(group.platform)">
          {{ platformShort(group.platform) }}
        </div>
        <div>
          <h1 :title="group.group_name">{{ group.group_name }}</h1>
          <p>{{ platformName(group.platform) }} <span>|</span> 通过 {{ accountDisplayName }} 观测和回复</p>
          <div class="thread-status-line">
            <em :class="canSend(group) ? 'status-ok' : 'status-warn'">
              {{ canSend(group) ? '可发送' : '只读' }}
            </em>
            <em :class="group.sync_groups_enabled ? 'status-ok' : 'status-neutral'">
              {{ group.sync_groups_enabled ? '同步分组' : '手动分组' }}
            </em>
            <em class="status-neutral">{{ accountRoleText(group.account_role) }}</em>
          </div>
        </div>
      </div>
      <div class="thread-actions">
        <el-button :icon="Check" @click="$emit('mark-read')">标记已读</el-button>
        <el-button :icon="Switch" :disabled="!canAssign(group)" @click="$emit('assign')">{{ assignmentActionText }}</el-button>
        <el-button :icon="TopRight" @click="$emit('open-native')">打开原生群</el-button>
      </div>
    </header>

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
          <div v-if="message.error_message" class="status-detail">
            {{ message.error_message }}
          </div>
          <footer>
            <time>{{ formatMessageTime(message.timestamp || message.created_at) }}</time>
            <span v-if="statusText(message.status)" class="status" :class="`status-${message.status}`">
              {{ statusText(message.status) }}
            </span>
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
import { computed, nextTick, ref, watch } from 'vue';
import { Check, Document, Switch, TopRight } from '@element-plus/icons-vue';
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
});

const emit = defineEmits([
  'mark-read',
  'assign',
  'open-native',
  'retry',
  'cancel',
  'load-older',
  'read-progress',
  'stick-state-change',
]);

const scrollRef = ref(null);
const lastStickState = ref(true);
const lastReadProgress = ref({ groupId: '', rawId: 0 });
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

const assignmentActionText = computed(() => {
  const assignment = props.group && props.group.assignment;
  if (!assignment) return '认领';
  if (assignment.assigned_to === props.currentOperatorId) return '释放';
  return '移交';
});

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

function canAssign(group) {
  return Boolean(group && (!group.permissions || group.permissions.can_assign !== false));
}

function attachmentPreview(attachment) {
  if (!attachment) return '';
  const dataUrl = attachment.preview_url || attachment.data_url;
  if (!dataUrl || typeof dataUrl !== 'string') return '';
  const type = attachment.type || '';
  if (attachment.kind === 'image' || attachment.kind === 'sticker' || type.startsWith('image/')) return dataUrl;
  return '';
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
