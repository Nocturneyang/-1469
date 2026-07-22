<template>
  <footer class="composer">
    <input
      ref="fileInputRef"
      class="file-input"
      type="file"
      multiple
      @change="handleFileChange"
    >
    <input
      ref="imageInputRef"
      class="file-input"
      type="file"
      accept="image/*"
      multiple
      @change="handleImageChange"
    >
    <input
      ref="stickerInputRef"
      class="file-input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      @change="handleStickerChange"
    >
    <div class="composer-box">
      <div class="composer-toolbar">
        <button
          ref="emojiButtonRef"
          class="icon-button"
          type="button"
          title="插入表情"
          aria-label="插入表情"
          :aria-expanded="emojiOpen"
          :disabled="disabled"
          @click="emojiOpen = !emojiOpen"
        >
          <el-icon><ChatDotRound /></el-icon>
          <span>表情</span>
        </button>
        <button
          class="icon-button"
          type="button"
          title="发送表情包"
          aria-label="发送表情包"
          :disabled="disabled"
          @click="openStickerPicker"
        >
          <el-icon><Postcard /></el-icon>
          <span>表情包</span>
        </button>
        <button
          class="icon-button"
          type="button"
          title="发送图片"
          aria-label="发送图片"
          :disabled="disabled"
          @click="openImagePicker"
        >
          <el-icon><Picture /></el-icon>
          <span>图片</span>
        </button>
        <button
          class="icon-button"
          type="button"
          title="发送文件"
          aria-label="发送文件"
          :disabled="disabled"
          @click="openFilePicker"
        >
          <el-icon><Paperclip /></el-icon>
          <span>文件</span>
        </button>
      </div>
      <div v-if="emojiOpen" ref="emojiPanelRef" class="emoji-panel" role="listbox" aria-label="选择表情">
        <button
          v-for="emoji in quickEmojis"
          :key="emoji"
          type="button"
          class="emoji-button"
          :aria-label="`插入 ${emoji}`"
          @click="insertEmoji(emoji)"
        >
          {{ emoji }}
        </button>
      </div>
      <div v-if="quoteMessage" class="quote-preview">
        <div>
          <strong>引用</strong>
          <span>{{ quoteSummary }}</span>
        </div>
        <button type="button" title="取消引用" @click="$emit('clear-quote')">
          <el-icon><Close /></el-icon>
        </button>
      </div>
      <div v-if="attachments.length" class="attachment-tray">
        <div
          v-for="attachment in attachments"
          :key="attachment.id"
          class="attachment-chip"
          :class="{ image: isImageAttachment(attachment) }"
        >
          <img
            v-if="isImageAttachment(attachment)"
            :src="attachment.data_url"
            alt=""
          >
          <el-icon v-else><Document /></el-icon>
          <div class="attachment-meta">
            <strong :title="attachment.name">{{ attachment.name }}</strong>
            <span>{{ attachment.kind === 'sticker' ? '表情包' : formatSize(attachment.size) }}</span>
          </div>
          <button
            type="button"
            class="remove-attachment"
            title="移除"
            @click="removeAttachment(attachment.id)"
          >
            <el-icon><Close /></el-icon>
          </button>
        </div>
      </div>
      <textarea
        ref="textareaRef"
        v-model="draft"
        rows="2"
        :placeholder="composerPlaceholder"
        :disabled="disabled"
        @keydown.enter="handleEnter"
        @keydown.esc.prevent="handleEscape"
        @paste="handlePaste"
      ></textarea>
      <div class="composer-foot">
        <span>{{ disabledReason || `通过当前服务账号发送：${accountDisplayName}` }}</span>
        <el-button
          type="primary"
          :icon="Position"
          :loading="sending"
          :disabled="disabled || !canSubmit"
          @click="submit"
        >
          发送
        </el-button>
      </div>
    </div>
  </footer>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ElMessage from 'element-plus/es/components/message/index.mjs';
import {
  ChatDotRound,
  Close,
  Document,
  Paperclip,
  Picture,
  Position,
  Postcard,
} from '@element-plus/icons-vue';

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const quickEmojis = [
  '😀', '😃', '😄', '😁', '😅', '😂', '😊', '🙂',
  '😉', '😍', '😘', '😎', '🤔', '😐', '😮', '😭',
  '😤', '🥳', '👍', '👎', '👌', '✌️', '🤝', '🙏',
  '👏', '💪', '👀', '✅', '❌', '⚠️', '📌', '📎',
  '🔥', '🎉', '✨', '💯', '❤️', '💙', '💚', '🚀',
];
const props = defineProps({
  group: {
    type: Object,
    default: null,
  },
  sending: {
    type: Boolean,
    default: false,
  },
  quoteMessage: {
    type: Object,
    default: null,
  },
  operatorId: {
    type: [String, Number],
    default: '',
  },
});

const emit = defineEmits(['send', 'clear-quote', 'typing-state']);
const draft = ref('');
const attachments = ref([]);
const emojiOpen = ref(false);
const emojiButtonRef = ref(null);
const emojiPanelRef = ref(null);
const fileInputRef = ref(null);
const imageInputRef = ref(null);
const stickerInputRef = ref(null);
const textareaRef = ref(null);
let typingTimer = null;
let draftSaveTimer = null;
let activeDraftKey = '';
let activeDraftStorageKey = '';
const sendAllowed = computed(() => (
  props.group &&
  props.group.send_enabled !== false &&
  Number(props.group.send_enabled) !== 0 &&
  props.group.global_send_enabled === true &&
  !props.group.send_breaker_active &&
  props.group.permissions &&
  props.group.permissions.can_reply !== false
));
const disabled = computed(() => !props.group || props.sending || !sendAllowed.value);
const canSubmit = computed(() => Boolean(draft.value.trim() || attachments.value.length));
const accountDisplayName = computed(() => {
  if (!props.group) return '';
  return props.group.account_display_name || props.group.account || '';
});
const disabledReason = computed(() => {
  if (!props.group) return '请选择会话';
  if (props.sending) return '发送任务创建中';
  if (props.group.permissions && props.group.permissions.can_reply === false) return '当前坐席没有回复权限';
  if (props.group.global_send_enabled !== true) return '生产全局发送开关已关闭';
  if (props.group.send_enabled === false || Number(props.group.send_enabled) === 0) return '当前服务账号发送开关已关闭，请管理员在“服务账号”中开启';
  if (props.group.send_breaker_active) return '当前服务账号发送已熔断，请管理员处理后重试';
  return '';
});
const composerPlaceholder = computed(() => {
  if (disabledReason.value) return disabledReason.value;
  return '输入消息，Enter 发送，Shift + Enter 换行；可直接粘贴图片';
});

const quoteSummary = computed(() => {
  if (!props.quoteMessage) return '';
  const author = props.quoteMessage.direction === 'outbound'
    ? accountDisplayName.value
    : props.quoteMessage.sender_name || '客户';
  const text = props.quoteMessage.display_text || props.quoteMessage.text || (props.quoteMessage.has_media ? '[媒体消息]' : '');
  return `${author}: ${text}`.slice(0, 120);
});

watch(
  () => `${groupDraftKey()}|${String(props.operatorId || '')}`,
  () => {
    persistDraft(activeDraftStorageKey, activeDraftKey, draft.value);
    activeDraftStorageKey = draftStorageKey();
    activeDraftKey = groupDraftKey();
    draft.value = readDraft(activeDraftStorageKey, activeDraftKey);
    attachments.value = [];
    emojiOpen.value = false;
    emit('clear-quote');
    emitTyping(false);
  },
  { immediate: true },
);

watch(draft, (value) => {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => persistDraft(activeDraftStorageKey, activeDraftKey, value), 180);
  if (!props.group || disabled.value) return;
  emitTyping(Boolean(String(value || '').trim()));
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  clearTimeout(typingTimer);
  clearTimeout(draftSaveTimer);
  persistDraft(activeDraftStorageKey, activeDraftKey, draft.value);
  emit('typing-state', false);
});

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
});

function handleEnter(event) {
  if (event.shiftKey) return;
  event.preventDefault();
  submit();
}

function handleEscape() {
  if (emojiOpen.value) {
    emojiOpen.value = false;
    return;
  }
  emit('clear-quote');
}

function handleDocumentPointerDown(event) {
  if (!emojiOpen.value) return;
  const target = event.target;
  if (emojiButtonRef.value?.contains(target) || emojiPanelRef.value?.contains(target)) return;
  emojiOpen.value = false;
}

function openFilePicker() {
  emojiOpen.value = false;
  fileInputRef.value && fileInputRef.value.click();
}

function openImagePicker() {
  emojiOpen.value = false;
  imageInputRef.value && imageInputRef.value.click();
}

function openStickerPicker() {
  emojiOpen.value = false;
  stickerInputRef.value && stickerInputRef.value.click();
}

async function handleFileChange(event) {
  await addFiles(Array.from(event.target.files || []), 'file');
  event.target.value = '';
}

async function handleImageChange(event) {
  await addFiles(Array.from(event.target.files || []), 'image');
  event.target.value = '';
}

async function handleStickerChange(event) {
  await addFiles(Array.from(event.target.files || []), 'sticker');
  event.target.value = '';
}

async function handlePaste(event) {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  await addFiles(files, 'image');
}

async function addFiles(files, defaultKind) {
  if (!files.length || disabled.value) return;
  const acceptedFiles = [];
  for (const file of files) {
    if (!canAcceptFile(file, acceptedFiles)) continue;
    acceptedFiles.push(file);
  }
  const loaded = (await Promise.all(acceptedFiles.map((file) => fileToAttachment(file, defaultKind)))).filter(Boolean);
  attachments.value = [...attachments.value, ...loaded];
}

function canAcceptFile(file, pendingFiles) {
  if (attachments.value.length + pendingFiles.length >= MAX_ATTACHMENTS) {
    ElMessage.warning(`一次最多发送 ${MAX_ATTACHMENTS} 个附件`);
    return false;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    ElMessage.warning(`${file.name} 超过 5MB，暂不支持发送`);
    return false;
  }
  const currentTotal = attachments.value.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const pendingTotal = pendingFiles.reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (currentTotal + pendingTotal + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
    ElMessage.warning('本次附件总大小不能超过 12MB');
    return false;
  }
  return true;
}

function fileToAttachment(file, defaultKind) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: createAttachmentId(),
        name: file.name || (defaultKind === 'sticker' ? 'sticker' : 'attachment'),
        type: file.type || 'application/octet-stream',
        size: file.size,
        kind: defaultKind === 'sticker' ? 'sticker' : defaultKind === 'image' ? 'image' : inferKind(file),
        data_url: String(reader.result || ''),
      });
    };
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  }).catch(() => {
    ElMessage.error(`${file.name || '附件'} 读取失败`);
    return null;
  });
}

function inferKind(file) {
  if (file.type && file.type.startsWith('image/')) return 'image';
  return 'file';
}

function createAttachmentId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isImageAttachment(attachment) {
  return attachment.kind === 'image' || attachment.kind === 'sticker';
}

function removeAttachment(id) {
  attachments.value = attachments.value.filter((attachment) => attachment.id !== id);
}

function insertEmoji(emoji) {
  const input = textareaRef.value;
  const start = input?.selectionStart ?? draft.value.length;
  const end = input?.selectionEnd ?? start;
  draft.value = `${draft.value.slice(0, start)}${emoji}${draft.value.slice(end)}`;
  emojiOpen.value = false;
  nextTick(() => {
    input?.focus();
    input?.setSelectionRange(start + emoji.length, start + emoji.length);
  });
}

function formatSize(size) {
  const bytes = Number(size || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function submit() {
  const text = draft.value.trim();
  if ((!text && !attachments.value.length) || !props.group || props.sending) return;
  emit('send', {
    text,
    attachments: attachments.value.filter(Boolean).map((attachment) => ({ ...attachment })),
    quote_msg_id: props.quoteMessage && (
      props.quoteMessage.remote_msg_id ||
      props.quoteMessage.message_id ||
      props.quoteMessage.raw_id ||
      props.quoteMessage.outbound_id ||
      props.quoteMessage.id
    ),
  });
  emojiOpen.value = false;
}

function clearDraft() {
  draft.value = '';
  attachments.value = [];
  emojiOpen.value = false;
  persistDraft(activeDraftStorageKey, activeDraftKey, '');
  emitTyping(false);
}

function groupDraftKey() {
  if (!props.group) return '';
  return [props.group.platform, props.group.account, props.group.group_id || props.group.id].map((value) => String(value || '')).join(':');
}

function draftStorageKey() {
  return `social-workbench.drafts.v1.${String(props.operatorId || 'anonymous')}`;
}

function readDraft(storageKey, key) {
  if (!storageKey || !key) return '';
  try {
    const drafts = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    return typeof drafts[key] === 'string' ? drafts[key] : '';
  } catch (_) {
    return '';
  }
}

function persistDraft(storageKey, key, value) {
  if (!storageKey || !key) return;
  try {
    const drafts = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    const text = String(value || '');
    if (text.trim()) drafts[key] = text;
    else delete drafts[key];
    if (Object.keys(drafts).length) window.localStorage.setItem(storageKey, JSON.stringify(drafts));
    else window.localStorage.removeItem(storageKey);
  } catch (_) { }
}

defineExpose({ clearDraft });

function emitTyping(active) {
  clearTimeout(typingTimer);
  emit('typing-state', active);
  if (active) {
    typingTimer = setTimeout(() => emit('typing-state', false), 2200);
  }
}
</script>
