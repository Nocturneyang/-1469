<template>
  <aside class="conversation-pane">
    <div class="conversation-meta">
      <div><span>{{ scopeLabel }}</span><strong>{{ groups.length }}</strong></div>
      <button class="sort-button" type="button" @click="$emit('refresh')">按最新消息 <el-icon><Sort /></el-icon></button>
    </div>
    <div class="conversation-search">
      <el-input :model-value="search" clearable placeholder="搜索会话" @input="$emit('search-change', $event)">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
    </div>

    <div v-if="loading" class="list-state">加载中...</div>
    <div v-else-if="!groups.length" class="list-state">暂无会话</div>
    <template v-else>
      <button v-for="group in groups" :key="group.id" type="button" class="conversation-row" :class="{ selected: selectedId === group.id }" @click="$emit('select', group)">
        <div class="platform-icon" :class="platformClass(group.platform)">{{ platformShort(group.platform) }}</div>
        <div class="conversation-copy">
          <div class="row-head"><strong :title="displayName(group)">{{ displayName(group) }}</strong><time>{{ formatTime(group.last_message_time) }}</time></div>
          <div v-if="visibleLabels(group).length" class="row-tag-line">
            <span v-for="label in visibleLabels(group)" :key="labelKey(label)" class="mini-tag" :class="tagClass(label)" :title="labelText(label)">{{ labelText(label) }}</span>
            <span v-if="group.labels.length > 2" class="mini-tag tag-more">+{{ group.labels.length - 2 }}</span>
          </div>
          <div class="workflow-line"><span class="workflow-pill">{{ statusText(group.conversation_status || group.status) }}</span><em>{{ accountDisplayName(group) }}</em></div>
          <div class="preview-line"><span :title="preview(group)">{{ preview(group) }}</span></div>
        </div>
        <span v-if="group.unread_count" class="unread-badge">{{ group.unread_count }}</span>
      </button>
    </template>
  </aside>
</template>

<script setup>
import { Search, Sort } from '@element-plus/icons-vue';
import { formatTime, platformClass } from '../utils/format';

defineProps({ groups: { type: Array, default: () => [] }, loading: { type: Boolean, default: false }, selectedId: { type: String, default: '' }, scopeLabel: { type: String, default: '全部' }, search: { type: String, default: '' } });
defineEmits(['select', 'refresh', 'search-change']);
function platformShort(platform) { return platform === 'wa' ? 'W' : platform === 'tg' ? 'T' : '?'; }
function preview(group) { const sender = group.last_sender_name ? `${group.last_sender_name}: ` : ''; return `${sender}${group.last_content || (group.has_media ? '[媒体消息]' : '')}`.trim() || '[空消息]'; }
function displayName(group) { return group.internal_display_name || group.display_group_name || group.group_name; }
function accountDisplayName(group) { return group.account_display_name || group.account || ''; }
function visibleLabels(group) { return (group.labels || []).slice(0, 2); }
function labelKey(label) { return label.id || label.native_label_id || label.native_group_id || label.name; }
function isWorkbenchTag(label) { return Number(label?.is_manual) === 1 || String(label?.source || '').startsWith('manual'); }
function tagClass(label) { return isWorkbenchTag(label) ? 'workbench' : 'channel'; }
function labelText(label) { const name = label?.name || label?.native_label_id || label?.native_group_id || ''; return isWorkbenchTag(label) && label?.parent_name ? `${label.parent_name}/${name}` : name; }
function statusText(status) { return ({ pending: '待处理', in_progress: '跟进中', resolved: '已解决', paused: '暂停' })[status] || '待处理'; }
</script>
