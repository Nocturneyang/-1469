<template>
  <aside class="conversation-pane">
    <div class="conversation-meta">
      <div>
        <span>{{ scopeLabel }}</span>
        <strong>{{ groups.length }}</strong>
      </div>
      <button class="sort-button" type="button" @click="$emit('refresh')">
        按最新消息
        <el-icon><Sort /></el-icon>
      </button>
    </div>

    <div v-if="loading" class="list-state">加载中...</div>
    <div v-else-if="!groups.length" class="list-state">暂无会话</div>

    <template v-else>
      <button
        v-for="group in groups"
        :key="group.id"
        type="button"
        class="conversation-row"
        :class="{ selected: selectedId === group.id }"
        @click="$emit('select', group)"
      >
        <div class="platform-icon" :class="platformClass(group.platform)">
          {{ platformShort(group.platform) }}
        </div>

        <div class="conversation-copy">
          <div class="row-head">
            <strong :title="displayName(group)">{{ displayName(group) }}</strong>
            <time>{{ formatTime(group.last_message_time) }}</time>
          </div>
          <div class="workflow-line">
            <span v-if="group.starred" class="workflow-pill starred">星标</span>
            <span class="workflow-pill">{{ statusText(group.conversation_status || group.status) }}</span>
            <span v-if="group.priority && group.priority !== 'normal'" class="workflow-pill priority">{{ priorityText(group.priority) }}</span>
            <span v-if="group.follow_up_at" class="workflow-pill follow">提醒 {{ formatTime(group.follow_up_at) }}</span>
          </div>
          <div class="label-line">
            <el-icon><Folder /></el-icon>
            <span v-if="group.labels.length">{{ group.labels.map(labelText).filter(Boolean).join(' / ') }}</span>
            <span v-else>暂无标签/分组</span>
          </div>
          <div class="preview-line">
            <span :title="preview(group)">{{ preview(group) }}</span>
          </div>
          <div class="row-foot">
            <em>{{ accountDisplayName(group) }}</em>
            <span>{{ assignmentText(group) }} · {{ presenceText(group) }}</span>
          </div>
        </div>

        <span v-if="group.unread_count" class="unread-badge">{{ group.unread_count }}</span>
      </button>
    </template>
  </aside>
</template>

<script setup>
import { Folder, Sort } from '@element-plus/icons-vue';
import { formatTime, platformClass } from '../utils/format';

const props = defineProps({
  groups: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  selectedId: {
    type: String,
    default: '',
  },
  scopeLabel: {
    type: String,
    default: '全部',
  },
});

defineEmits(['select', 'refresh']);

function platformShort(platform) {
  if (platform === 'wa') return 'W';
  if (platform === 'tg') return 'T';
  return '?';
}

function preview(group) {
  if (group.has_media && !group.last_content) return '[媒体消息]';
  const sender = group.last_sender_name ? `${group.last_sender_name}: ` : '';
  return `${sender}${group.last_content || ''}`.trim() || '[空消息]';
}

function displayName(group) {
  return group.internal_display_name || group.display_group_name || group.group_name;
}

function accountDisplayName(group) {
  return group.account_display_name || group.account || '';
}

function assignmentText(group) {
  if (!group.assignment) return '未认领';
  return group.assignment.assigned_to_name || group.assignment.assigned_to || '已认领';
}

function presenceText(group) {
  const rows = Array.isArray(group.presence) ? group.presence : [];
  const active = rows.filter((row) => row.operator_id && row.mode);
  if (!active.length) return '无协作占用';
  const typing = active.find((row) => row.mode === 'typing');
  if (typing) return `${typing.actor_name || typing.operator_id} 正在输入`;
  return `${active[0].actor_name || active[0].operator_id} 正在查看`;
}

function statusText(status) {
  const map = {
    pending: '待处理',
    in_progress: '跟进中',
    resolved: '已解决',
    paused: '暂停',
  };
  return map[status] || '待处理';
}

function priorityText(priority) {
  const map = {
    low: '低',
    high: '高',
    urgent: '紧急',
  };
  return map[priority] || priority;
}

function labelText(label) {
  if (!label) return '';
  if ((Number(label.is_manual) === 1 || String(label.source || '').startsWith('manual')) && label.parent_name) {
    return `${label.parent_name}/${label.name}`;
  }
  return label.name || label.native_label_id || '';
}
</script>
