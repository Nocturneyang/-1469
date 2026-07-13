<template>
  <aside class="inspector-pane customer-profile-pane">
    <template v-if="group">
      <header class="customer-profile-header">
        <div class="profile-avatar" :class="platformClass(group.platform)">{{ platformShort(group.platform) }}</div>
        <div class="profile-copy">
          <input
            v-if="canManage"
            v-model="profileDraft.internal_display_name"
            class="profile-name-input"
            maxlength="120"
            :placeholder="group.group_name"
            @input="scheduleNameSave"
          >
          <h2 v-else :title="displayGroupName">{{ displayGroupName }}</h2>
          <p :title="group.group_name">{{ group.group_name }}</p>
          <small>{{ platformName(group.platform) }} · {{ group.account_display_name || group.account }}</small>
        </div>
      </header>
      <el-button class="open-native-profile-button" plain size="small" @click="$emit('open-native', group)">打开原生会话</el-button>

      <section class="inspector-section customer-core-section">
        <div class="section-title">客户资料 <small>逐项自动保存</small></div>
        <label>
          客户类型
          <el-select
            v-model="profileDraft.customer_type_id"
            clearable
            placeholder="未分类"
            :disabled="!canManage"
            @change="saveField({ customer_type_id: $event || '' })"
          >
            <el-option
              v-for="option in accountCustomerTypes"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            >
              <span class="customer-type-option-label">
                <i class="customer-type-dot" :style="{ background: option.color || '#64748b' }"></i>
                {{ option.name }}
              </span>
            </el-option>
          </el-select>
        </label>
        <label>
          会话状态
          <el-select
            v-model="profileDraft.status"
            :disabled="!canManage"
            @change="saveField({ status: $event })"
          >
            <el-option label="待处理" value="pending" />
            <el-option label="跟进中" value="in_progress" />
            <el-option label="已解决" value="resolved" />
            <el-option label="暂停" value="paused" />
          </el-select>
        </label>
      </section>

      <section class="inspector-section">
        <div class="section-title">工作台标签</div>
        <el-select
          class="profile-tag-select"
          :model-value="selectedManualGroupIds"
          multiple
          clearable
          collapse-tags
          collapse-tags-tooltip
          placeholder="选择工作台标签"
          :disabled="!canManage || savingManualGroups"
          @change="$emit('manual-groups-change', $event)"
        >
          <el-option
            v-for="option in manualGroupOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
        <div class="tag-stack compact-tags">
          <span v-for="label in workbenchTags" :key="label.id || label.native_group_id" class="group-tag workbench-tag">
            {{ labelDisplayName(label) }}
          </span>
          <span v-if="!workbenchTags.length" class="group-tag muted">暂无工作台标签</span>
        </div>
      </section>

      <section class="inspector-section">
        <div class="section-title">渠道分组 <small>只读</small></div>
        <div class="tag-stack compact-tags">
          <span v-for="label in channelGroups" :key="label.id || label.native_group_id" class="group-tag channel-tag">
            {{ labelDisplayName(label) }}
          </span>
          <span v-if="!channelGroups.length" class="group-tag muted">暂无渠道分组</span>
        </div>
      </section>

      <section class="inspector-section">
        <div class="section-title">访问与发送</div>
        <div class="status-grid profile-status-grid">
          <span :class="statusClass(canReply)">{{ canReply ? '可回复' : '只读' }}</span>
          <span :class="statusClass(isOnline)">{{ isOnline ? '账号在线' : '账号未在线' }}</span>
          <span :class="statusClass(sendEnabled)">{{ sendEnabled ? '发送已开启' : '发送已关闭' }}</span>
          <span :class="statusClass(!breakerActive)">{{ breakerActive ? '发送已熔断' : '发送正常' }}</span>
        </div>
      </section>

      <details class="inspector-section notes-section" open>
        <summary class="section-title">内部备注 <small>最近 {{ notes.length }} 条</small></summary>
        <div v-if="notes.length" class="note-list">
          <article v-for="note in notes" :key="note.id" class="note-item">
            <strong>{{ note.actor_name || note.created_by }}</strong>
            <p>{{ note.body }}</p>
            <time>{{ formatTime(note.created_at) }}</time>
          </article>
        </div>
        <div v-else class="empty-mini">暂无备注</div>
        <el-button v-if="workspaceDetail.notes_paging?.has_more" text @click="$emit('load-more-notes')">查看全部备注</el-button>
        <textarea v-model="noteDraft" rows="3" maxlength="2000" :disabled="!canWriteNote" placeholder="添加内部备注"></textarea>
        <el-button type="primary" size="small" :disabled="!canWriteNote || !noteDraft.trim()" @click="submitNote">添加备注</el-button>
      </details>

      <details class="inspector-section presence-section" open>
        <summary class="section-title">协作状态</summary>
        <div v-if="presence.length" class="presence-list">
          <span v-for="item in presence" :key="`${item.operator_id}-${item.mode}`">
            {{ item.actor_name || item.operator_id }} · {{ presenceModeText(item.mode) }}
          </span>
        </div>
        <div v-else class="empty-mini">暂无其他坐席查看</div>
      </details>

      <details class="inspector-section timeline-section">
        <summary class="section-title">操作动态 <small>最近 {{ timeline.length }} 条</small></summary>
        <div v-if="timeline.length" class="timeline-list">
          <article v-for="event in timeline" :key="event.id">
            <strong>{{ timelineText(event) }}</strong>
            <span>{{ event.actor_name || event.actor_id }} · {{ formatTime(event.created_at) }}</span>
          </article>
        </div>
        <div v-else class="empty-mini">暂无操作记录</div>
        <el-button v-if="workspaceDetail.timeline_paging?.has_more" text @click="$emit('load-more-timeline')">查看全部动态</el-button>
      </details>
    </template>

    <section v-else class="inspector-empty">
      <div class="empty-symbol">客</div>
      <strong>选择会话后显示客户资料</strong>
      <span>资料按服务账号和会话隔离，不跨渠道合并。</span>
    </section>
  </aside>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { formatTime, platformClass, platformName } from '../utils/format';

const props = defineProps({
  group: { type: Object, default: null },
  messages: { type: Array, default: () => [] },
  workspaceDetail: { type: Object, default: () => ({ profile: null, notes: [], timeline: [], presence: [] }) },
  loadingWorkspace: { type: Boolean, default: false },
  customerTypes: { type: Array, default: () => [] },
  manualGroups: { type: Array, default: () => [] },
  savingManualGroups: { type: Boolean, default: false },
});

const emit = defineEmits(['workspace-save', 'note-create', 'manual-groups-change', 'load-more-notes', 'load-more-timeline', 'open-native']);
const noteDraft = ref('');
const profileDraft = reactive({ internal_display_name: '', customer_type_id: '', status: 'pending' });
let nameSaveTimer = null;

const profile = computed(() => props.workspaceDetail?.profile || props.group || {});
const notes = computed(() => props.workspaceDetail?.notes || []);
const timeline = computed(() => props.workspaceDetail?.timeline || []);
const presence = computed(() => props.workspaceDetail?.presence || []);
const displayGroupName = computed(() => profile.value.internal_display_name || props.group?.group_name || '');
const canManage = computed(() => props.group?.permissions?.can_manage === true);
const canReply = computed(() => props.group?.permissions?.can_reply === true);
const canWriteNote = computed(() => canReply.value || canManage.value);
const sendEnabled = computed(() => Boolean(
  props.group && props.group.send_enabled !== false && Number(props.group.send_enabled) !== 0 && props.group.global_send_enabled === true,
));
const breakerActive = computed(() => Boolean(props.group?.send_breaker_active));
const isOnline = computed(() => ['online', 'authenticated', 'ready', 'monitoring', 'healthy'].includes(String(props.group?.account_status || '').toLowerCase()));
const accountCustomerTypes = computed(() => props.customerTypes.filter((option) => option.platform === props.group?.platform && option.account === props.group?.account && option.status !== 'disabled'));
const workbenchTags = computed(() => (props.group?.labels || []).filter(isWorkbenchTag));
const channelGroups = computed(() => (props.group?.labels || []).filter((label) => !isWorkbenchTag(label)));
const selectedManualGroupIds = computed(() => workbenchTags.value.map((label) => String(label.native_group_id || label.native_label_id || '')).filter(Boolean));
const manualGroupOptions = computed(() => props.manualGroups
  .filter((group) => group.platform === props.group?.platform && group.service_account === props.group?.account)
  .map((group) => ({
    value: group.native_group_id,
    label: group.parent_name ? `${group.parent_name} / ${group.name}` : group.name,
  })));

watch(() => props.group?.id, () => { noteDraft.value = ''; syncDraft(); });
watch(() => props.workspaceDetail?.profile, syncDraft, { immediate: true, deep: true });
onBeforeUnmount(() => clearTimeout(nameSaveTimer));

function syncDraft() {
  const value = profile.value || {};
  profileDraft.internal_display_name = value.internal_display_name || '';
  profileDraft.customer_type_id = value.customer_type_id || '';
  profileDraft.status = value.status || value.conversation_status || 'pending';
}

function scheduleNameSave() {
  clearTimeout(nameSaveTimer);
  nameSaveTimer = setTimeout(() => saveField({ internal_display_name: profileDraft.internal_display_name.trim() }), 400);
}

function saveField(patch) {
  if (!canManage.value) return;
  emit('workspace-save', patch);
}

function submitNote() {
  const body = noteDraft.value.trim();
  if (!body || !canWriteNote.value) return;
  emit('note-create', body);
  noteDraft.value = '';
}

function isWorkbenchTag(label) {
  return Number(label?.is_manual) === 1 || String(label?.source || '').startsWith('manual');
}

function labelDisplayName(label) {
  const name = label?.name || label?.native_label_id || label?.native_group_id || '';
  return label?.parent_name ? `${label.parent_name} / ${name}` : name;
}

function platformShort(platform) { return platform === 'wa' ? 'W' : platform === 'tg' ? 'T' : '?'; }
function statusClass(value) { return value ? 'status-ok' : 'status-warn'; }
function presenceModeText(mode) { return mode === 'typing' ? '正在输入' : mode === 'replying' ? '正在回复' : '正在查看'; }
function timelineText(event) {
  const map = {
    'conversation.profile.update': '更新客户资料',
    'conversation.note.create': '添加内部备注',
    'conversation.manual_groups.update': '更新工作台标签',
    'conversation.read': '标记已读',
    'reply.create': '创建外发回复',
    'outbound.cancel': '取消外发',
    'outbound.retry': '重试外发',
    'customer_type.create': '新增客户类型',
    'customer_type.update': '更新客户类型',
  };
  return map[event.action_type] || event.action_type || '操作';
}
</script>
