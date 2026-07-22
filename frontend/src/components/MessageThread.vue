<template>
  <section class="thread-pane">
    <header v-if="group" class="thread-header">
      <div class="thread-title">
        <div class="platform-icon large" :class="platformClass(group.platform)">{{ platformShort(group.platform) }}</div>
        <div class="thread-name-line">
          <h1 :title="group.group_name">{{ group.internal_display_name || group.group_name }}</h1>
          <span class="thread-separator">·</span>
          <span class="thread-platform-badge" :class="platformClass(group.platform)">{{ platformShort(group.platform) }}</span>
          <span class="thread-separator">·</span>
          <span class="thread-account" :title="accountDisplayName">{{ accountDisplayName }}</span>
        </div>
      </div>

      <div
        class="thread-label-zone"
        :class="{ 'is-empty': !visibleHeaderTags.length && !hiddenTagCount && !canManageManualGroups }"
      >
        <div class="thread-label-row">
          <span v-for="label in visibleHeaderTags" :key="labelKey(label)" class="header-tag" :class="isWorkbenchTag(label) ? 'workbench' : 'channel'" :title="labelTitle(label)">
            {{ headerLabelText(label) }}
          </span>
          <el-popover v-if="hiddenTagCount" placement="bottom-end" :width="280" trigger="click">
            <template #reference><button type="button" class="header-tag more">+{{ hiddenTagCount }}</button></template>
            <div class="tag-popover-list">
              <strong>全部标签</strong>
              <span v-for="label in headerTags" :key="`all-${labelKey(label)}`" class="header-tag" :class="isWorkbenchTag(label) ? 'workbench' : 'channel'">{{ headerLabelText(label) }}</span>
            </div>
          </el-popover>
          <el-popover v-if="canManageManualGroups" placement="bottom-end" :width="312" trigger="click" popper-class="tag-editor-popper" :teleported="true">
            <template #reference><el-button circle text class="header-tag-edit" aria-label="编辑工作台标签"><el-icon><EditPen /></el-icon></el-button></template>
            <div class="thread-tag-popover">
              <div class="tag-popover-heading"><strong>工作台标签</strong><span>仅在工作台内生效</span></div>
              <el-select
                :model-value="selectedManualGroupIds"
                multiple
                filterable
                clearable
                collapse-tags
                collapse-tags-tooltip
                placeholder="选择已有标签"
                :disabled="savingManualGroups"
                @change="$emit('manual-groups-change', $event)"
              >
                <el-option v-for="option in manualGroupOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <div class="new-tag-row">
                <el-input v-model.trim="manualDraft.name" maxlength="40" placeholder="新建工作台标签" @keydown.enter.prevent="submitManualGroup" />
                <el-button type="primary" :disabled="!canSubmitManualGroup" :loading="savingManualGroups" @click="submitManualGroup">添加</el-button>
              </div>
            </div>
          </el-popover>
        </div>
      </div>
    </header>

    <div v-if="!group" class="thread-empty">
      <div class="empty-illustration">IN</div>
      <strong>选择一个会话查看消息</strong>
      <span>从左侧会话列表开始处理消息。</span>
    </div>
    <div v-else class="message-scroll" ref="scrollRef" @scroll="handleScroll">
      <div v-if="loadingMessages" class="message-loading-banner" role="status" aria-live="polite">
        <span class="message-loading-spinner" aria-hidden="true"></span>
        <span>{{ messages.length ? '正在加载完整消息记录…' : '正在读取最近消息…' }}</span>
      </div>
      <div v-if="loadingMessages && !messages.length" class="message-loading-skeleton" aria-hidden="true">
        <span v-for="index in 3" :key="index"></span>
      </div>
      <div v-if="!loadingMessages && paging && paging.has_more" class="load-older-row"><el-button :loading="loadingOlder" @click="requestOlderMessages">{{ loadingOlder ? '正在加载更早消息' : '加载更早消息' }}</el-button></div>
      <div v-if="!loadingMessages && !messages.length" class="message-empty-state">暂无可展示的消息记录</div>
      <template v-for="(message, index) in messages" :key="message.id">
        <div v-if="shouldShowDateSeparator(message, index)" class="message-date"><span>{{ formatMessageDateLabel(messageTimeValue(message)) }}</span></div>
        <div class="message-row" :class="message.direction === 'outbound' ? 'outbound' : 'inbound'" :data-raw-id="message.raw_id || null" :data-readable="isReadableMessage(message) ? 'true' : null">
          <div class="sender-chip">{{ message.direction === 'outbound' ? '我' : '客' }}</div>
          <div class="message-content">
            <div class="bubble-author"><span>{{ message.direction === 'outbound' ? '您' : (message.sender_name || group.group_name) }}<small v-if="message.sender_username">@{{ message.sender_username }}</small></span><time :title="fullMessageTime(messageTimeValue(message))">{{ formatMessageTime(messageTimeValue(message)) }}</time></div>
            <article class="bubble" :class="{ failed: message.status === 'failed' || message.status === 'dead' }">
              <div v-if="message.forwarded_from" class="forwarded-line">转发自 {{ message.forwarded_from }}</div>
              <blockquote v-if="message.quote_msg_id">{{ message.quote_text || `引用消息 ${message.quote_msg_id}` }}</blockquote>
              <p v-if="message.display_text || message.text">{{ message.display_text || message.text }}</p>
              <div v-if="message.attachments && message.attachments.length" class="attachment-stack">
                <div v-for="attachment in message.attachments" :key="attachment.id || attachment.name" class="attachment-row" :class="{ 'has-preview': attachmentPreview(attachment) }">
                  <a v-if="attachmentPreview(attachment) && attachment.media_url" class="attachment-preview" :href="attachment.media_url" target="_blank" rel="noopener">
                    <img :src="attachmentPreview(attachment)" :alt="attachment.name || '媒体预览'" loading="lazy" @error="hideBrokenPreview">
                  </a>
                  <img v-else-if="attachmentPreview(attachment)" :src="attachmentPreview(attachment)" :alt="attachment.name || '媒体预览'" loading="lazy" @error="hideBrokenPreview">
                  <el-icon v-else><Document /></el-icon>
                  <div class="attachment-info">
                    <a v-if="attachment.media_url" class="attachment-name" :href="attachment.media_url" :download="attachment.kind === 'image' || attachment.kind === 'sticker' ? null : (attachment.name || '附件')" target="_blank" rel="noopener">{{ attachment.name || '附件' }}</a>
                    <span v-else class="attachment-name" :title="attachment.name || '附件'">{{ attachment.name || '附件' }}</span>
                    <small>{{ attachmentMeta(attachment) }}</small>
                  </div>
                  <a
                    v-if="attachment.media_url && !attachmentPreview(attachment)"
                    class="attachment-download"
                    :href="attachment.media_url"
                    :download="attachment.name || '附件'"
                    :aria-label="`下载 ${attachment.name || '附件'}`"
                    :title="`下载 ${attachment.name || '附件'}`"
                  ><el-icon><Download /></el-icon><span>下载</span></a>
                </div>
              </div>
              <div class="message-metadata">
                <span v-if="message.message_id">消息 #{{ nativeMessageId(message.message_id) }}</span>
                <span v-if="message.edited_at">已编辑</span>
                <span v-if="message.views">{{ message.views }} 次查看</span>
                <span v-if="message.forwards">{{ message.forwards }} 次转发</span>
              </div>
              <div v-if="message.error_display || message.error_message" class="status-detail">{{ message.error_display || message.error_message }}</div>
            </article>
            <footer class="message-footer">
              <span
                v-if="receiptStatus(message.status)"
                class="delivery-receipt"
                :class="`receipt-${receiptStatus(message.status)}`"
                :title="receiptTitle(message.status)"
                :aria-label="receiptTitle(message.status)"
              >
                <span>✓</span><span v-if="receiptStatus(message.status) !== 'sent'">✓</span>
              </span>
              <span v-else-if="statusText(message.status)" class="status" :class="`status-${message.status}`">{{ statusText(message.status) }}</span>
              <button type="button" class="message-action-button" @click="$emit('quote', message)">引用</button>
              <button v-if="['pending', 'paused'].includes(message.status) && canSend(group)" type="button" class="message-action-button" @click="$emit('cancel', message)">取消</button>
              <button v-if="message.outbound_id && ['failed', 'dead', 'paused', 'canceled'].includes(message.status) && canSend(group)" type="button" class="message-action-button danger" @click="$emit('retry', message)">重试</button>
            </footer>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { Document, Download, EditPen } from '@element-plus/icons-vue';
import { formatMessageDateLabel, formatMessageTime, messageDayKey, platformClass, statusText } from '../utils/format';

const props = defineProps({
  group: { type: Object, default: null }, messages: { type: Array, default: () => [] }, paging: { type: Object, default: () => ({ has_more: false, before_id: null }) }, loadingMessages: { type: Boolean, default: false }, loadingOlder: { type: Boolean, default: false }, stickToBottom: { type: Boolean, default: true }, manualGroups: { type: Array, default: () => [] }, savingManualGroups: { type: Boolean, default: false },
});
const emit = defineEmits(['retry', 'cancel', 'load-older', 'read-progress', 'stick-state-change', 'quote', 'manual-groups-change', 'manual-group-create']);
const scrollRef = ref(null);
const lastStickState = ref(true);
const lastReadProgress = ref({ groupId: '', rawId: 0 });
const pendingOlderScroll = ref(null);
const olderRequestInFlight = ref(false);
const manualDraft = reactive({ name: '' });
const BOTTOM_THRESHOLD_PX = 96;
const TOP_LOAD_THRESHOLD_PX = 72;
const READ_VISIBLE_THRESHOLD_PX = 24;

watch(() => [props.group?.id, props.messages.length], async ([groupId], [previousGroupId] = []) => {
  await nextTick();
  if (groupId === previousGroupId) restoreOlderScrollPosition();
  if (props.stickToBottom && scrollRef.value) scrollToBottom();
  reportVisibleReadProgress();
});
watch(() => props.loadingOlder, async (loading, wasLoading) => {
  if (loading) olderRequestInFlight.value = true;
  if (!loading && wasLoading) {
    await nextTick();
    restoreOlderScrollPosition();
    olderRequestInFlight.value = false;
  }
});
watch(() => props.group?.id, () => { lastStickState.value = true; pendingOlderScroll.value = null; olderRequestInFlight.value = false; manualDraft.name = ''; });

const accountDisplayName = computed(() => props.group?.account_display_name || props.group?.account || '');
const canManageManualGroups = computed(() => props.group?.permissions?.can_manage === true);
const workbenchTags = computed(() => (props.group?.labels || []).filter(isWorkbenchTag));
const channelGroupTags = computed(() => (props.group?.labels || []).filter((label) => label && !isWorkbenchTag(label)));
const headerTags = computed(() => [...channelGroupTags.value, ...workbenchTags.value]);
const visibleHeaderTags = computed(() => headerTags.value.slice(0, 5));
const hiddenTagCount = computed(() => Math.max(0, headerTags.value.length - visibleHeaderTags.value.length));
const selectedManualGroupIds = computed(() => workbenchTags.value.map((label) => String(label.native_group_id || label.native_label_id || '')).filter(Boolean));
const manualGroupOptions = computed(() => props.manualGroups
  .filter((item) => item.platform === props.group?.platform && item.service_account === props.group?.account)
  .map((item) => ({ value: item.native_group_id, label: item.parent_name ? `${item.parent_name} / ${item.name}` : item.name })));
const canSubmitManualGroup = computed(() => canManageManualGroups.value && !props.savingManualGroups && Boolean(manualDraft.name.trim()));

function platformShort(platform) { return platform === 'wa' ? 'W' : platform === 'tg' ? 'T' : '?'; }
function canSend(group) { return Boolean(group && group.send_enabled !== false && Number(group.send_enabled) !== 0 && (!group.permissions || group.permissions.can_reply !== false)); }
function receiptStatus(status) { return ['sent', 'delivered', 'read'].includes(status) ? status : ''; }
function receiptTitle(status) { return ({ sent: '已发送到渠道', delivered: '客户设备已收到', read: '客户已读' })[status] || ''; }
function isWorkbenchTag(label) { return Number(label?.is_manual) === 1 || String(label?.source || '').startsWith('manual'); }
function labelKey(label) { return label.id || label.native_label_id || label.native_group_id || label.name; }
function labelDisplayName(label) { const name = label?.name || label?.native_label_id || label?.native_group_id || ''; return isWorkbenchTag(label) && label?.parent_name ? `${label.parent_name} / ${name}` : name; }
function headerLabelText(label) { return isWorkbenchTag(label) ? labelDisplayName(label) : `${String(label?.platform || props.group?.platform || '').toUpperCase()}：${labelDisplayName(label)}`; }
function labelTitle(label) { return `${isWorkbenchTag(label) ? '工作台标签' : '渠道分组'} · ${headerLabelText(label)}`; }
function submitManualGroup() { if (!canSubmitManualGroup.value) return; emit('manual-group-create', { name: manualDraft.name.trim(), group_level: 1 }); manualDraft.name = ''; }
function attachmentPreview(attachment) { const url = attachment?.preview_url || attachment?.data_url || attachment?.media_url; const type = attachment?.type || ''; return (attachment?.kind === 'image' || attachment?.kind === 'sticker' || type.startsWith('image/')) ? url : ''; }
function attachmentMeta(attachment) { return [mediaKindText(attachment?.media_kind || attachment?.kind), attachment?.type, formatBytes(attachment?.size), attachment?.duration ? `${Math.round(Number(attachment.duration))} 秒` : '', attachment?.detail].filter(Boolean).join(' · '); }
function mediaKindText(kind) { return ({ photo: '图片', image: '图片', sticker: '贴纸', video: '视频', voice: '语音', document: '文件', contact: '联系人', location: '位置', poll: '投票', webpage: '网页' })[kind] || '附件'; }
function formatBytes(value) { const bytes = Number(value); if (!Number.isFinite(bytes) || bytes <= 0) return ''; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function nativeMessageId(value) { const text = String(value || ''); return text.includes(':') ? text.split(':').pop() : text; }
function fullMessageTime(value) { const numeric = Number(value); const date = new Date(Number.isFinite(numeric) && numeric > 0 ? (numeric > 1000000000000 ? numeric : numeric * 1000) : value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false }); }
function messageTimeValue(message) { return message?.timestamp || message?.created_at; }
function shouldShowDateSeparator(message, index) { return index === 0 || messageDayKey(messageTimeValue(message)) !== messageDayKey(messageTimeValue(props.messages[index - 1])); }
function hideBrokenPreview(event) { if (event?.target) event.target.hidden = true; }
function scrollToBottom() { const el = scrollRef.value; if (!el) return; el.scrollTop = el.scrollHeight; updateStickState(true); }
function handleScroll() { const el = scrollRef.value; if (!el) return; updateStickState(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX); if (el.scrollTop <= TOP_LOAD_THRESHOLD_PX) requestOlderMessages(); reportVisibleReadProgress(); }
function requestOlderMessages() {
  const el = scrollRef.value;
  if (!el || props.loadingMessages || props.loadingOlder || olderRequestInFlight.value || !props.paging?.has_more) return;
  olderRequestInFlight.value = true;
  pendingOlderScroll.value = { groupId: props.group?.id, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
  emit('load-older');
}
function restoreOlderScrollPosition() {
  const el = scrollRef.value;
  const snapshot = pendingOlderScroll.value;
  if (!el || !snapshot || snapshot.groupId !== props.group?.id) return;
  el.scrollTop = snapshot.scrollTop + Math.max(0, el.scrollHeight - snapshot.scrollHeight);
  pendingOlderScroll.value = null;
}
function updateStickState(nextState) { if (lastStickState.value === nextState) return; lastStickState.value = nextState; emit('stick-state-change', nextState); }
function isReadableMessage(message) { return Boolean(message?.raw_id && message.direction !== 'outbound'); }
function reportVisibleReadProgress() {
  const el = scrollRef.value; if (!el || !props.group) return;
  const containerRect = el.getBoundingClientRect(); let maxVisibleRawId = 0;
  Array.from(el.querySelectorAll('.message-row[data-readable="true"][data-raw-id]')).forEach((row) => {
    const rect = row.getBoundingClientRect(); const visibleHeight = Math.min(rect.bottom, containerRect.bottom) - Math.max(rect.top, containerRect.top);
    if (visibleHeight >= Math.min(rect.height, READ_VISIBLE_THRESHOLD_PX)) maxVisibleRawId = Math.max(maxVisibleRawId, Number(row.dataset.rawId) || 0);
  });
  if (!maxVisibleRawId || (lastReadProgress.value.groupId === props.group.id && maxVisibleRawId <= lastReadProgress.value.rawId)) return;
  lastReadProgress.value = { groupId: props.group.id, rawId: maxVisibleRawId };
  emit('read-progress', { groupId: props.group.id, platform: props.group.platform, account: props.group.account, group_id: props.group.group_id, last_read_message_id: maxVisibleRawId });
}
</script>
