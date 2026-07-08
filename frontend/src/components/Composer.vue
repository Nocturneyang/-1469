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
      ref="stickerInputRef"
      class="file-input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      @change="handleStickerChange"
    >
    <div class="composer-box">
      <div class="composer-toolbar">
        <button
          class="icon-button"
          type="button"
          title="插入表情"
          :disabled="disabled"
          @click="emojiOpen = !emojiOpen"
        >
          <el-icon><ChatDotRound /></el-icon>
        </button>
        <button
          class="icon-button"
          type="button"
          title="发送表情包/图片"
          :disabled="disabled"
          @click="openStickerPicker"
        >
          <el-icon><Picture /></el-icon>
        </button>
        <button
          class="icon-button"
          type="button"
          title="发送文件"
          :disabled="disabled"
          @click="openFilePicker"
        >
          <el-icon><Paperclip /></el-icon>
        </button>
      </div>
      <div v-if="emojiOpen" class="emoji-panel">
        <button
          v-for="emoji in quickEmojis"
          :key="emoji"
          type="button"
          class="emoji-button"
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
        @keydown.esc.prevent="$emit('clear-quote')"
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
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  ChatDotRound,
  Close,
  Document,
  Paperclip,
  Picture,
  Position,
} from '@element-plus/icons-vue';

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const quickEmojis = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
  '😊', '😇', '🙂', '🙃', '😉', '😍', '😘', '😎',
  '🤔', '🤨', '😐', '😑', '😶', '🙄', '😬', '😮‍💨',
  '😴', '🤒', '😵‍💫', '😭', '😤', '😡', '🤯', '🥳',
  '👍', '👎', '👌', '✌️', '🤞', '🤝', '🙏', '👏',
  '💪', '👀', '✅', '☑️', '❌', '⚠️', '📌', '📎',
  '🔥', '🎉', '✨', '💯', '❤️', '💙', '💚', '💛',
  '🚀', '⏳', '⌛', '🕐', '📣', '💬', '📷', '📄',
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
});

const emit = defineEmits(['send', 'clear-quote', 'typing-state']);
const draft = ref('');
const attachments = ref([]);
const emojiOpen = ref(false);
const fileInputRef = ref(null);
const stickerInputRef = ref(null);
const textareaRef = ref(null);
let typingTimer = null;
const sendAllowed = computed(() => (
  props.group &&
  props.group.send_enabled !== false &&
  Number(props.group.send_enabled) !== 0 &&
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
  if (!sendAllowed.value) return '当前服务账号禁止发送';
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
  () => props.group && props.group.id,
  () => {
    draft.value = '';
    attachments.value = [];
    emojiOpen.value = false;
    emit('clear-quote');
    emitTyping(false);
  },
);

watch(draft, (value) => {
  if (!props.group || disabled.value) return;
  emitTyping(Boolean(String(value || '').trim()));
});

onBeforeUnmount(() => {
  clearTimeout(typingTimer);
  emit('typing-state', false);
});

function handleEnter(event) {
  if (event.shiftKey) return;
  event.preventDefault();
  submit();
}

function openFilePicker() {
  fileInputRef.value && fileInputRef.value.click();
}

function openStickerPicker() {
  stickerInputRef.value && stickerInputRef.value.click();
}

async function handleFileChange(event) {
  await addFiles(Array.from(event.target.files || []), 'file');
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
        kind: defaultKind === 'sticker' ? 'sticker' : inferKind(file),
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
  if (!input) {
    draft.value += emoji;
    return;
  }
  const start = input.selectionStart ?? draft.value.length;
  const end = input.selectionEnd ?? start;
  draft.value = `${draft.value.slice(0, start)}${emoji}${draft.value.slice(end)}`;
  emojiOpen.value = false;
  nextTick(() => {
    input.focus();
    input.setSelectionRange(start + emoji.length, start + emoji.length);
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
      props.quoteMessage.message_id ||
      props.quoteMessage.raw_id ||
      props.quoteMessage.outbound_id ||
      props.quoteMessage.id
    ),
  });
  draft.value = '';
  attachments.value = [];
  emojiOpen.value = false;
  emitTyping(false);
}

function emitTyping(active) {
  clearTimeout(typingTimer);
  emit('typing-state', active);
  if (active) {
    typingTimer = setTimeout(() => emit('typing-state', false), 2200);
  }
}
</script>
