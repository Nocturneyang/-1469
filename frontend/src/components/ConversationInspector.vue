<template>
  <aside class="inspector-pane">
    <template v-if="group">
      <section class="inspector-profile">
        <div class="profile-avatar" :class="platformClass(group.platform)">
          {{ platformShort(group.platform) }}
        </div>
        <div class="profile-copy">
          <h2 :title="displayGroupName">{{ displayGroupName }}</h2>
          <p>{{ platformName(group.platform) }} · {{ group.group_id }}</p>
        </div>
      </section>

      <section class="inspector-section workflow-section">
        <div class="section-title">会话工作流</div>
        <div class="status-segments">
          <button
            v-for="option in statusOptions"
            :key="option.value"
            type="button"
            :class="{ active: profileDraft.status === option.value }"
            :disabled="!canEditWorkflow"
            @click="saveWorkflow({ status: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
        <div class="workflow-fields">
          <button
            type="button"
            class="star-toggle"
            :class="{ active: profileDraft.starred }"
            :disabled="!canEditWorkflow"
            @click="saveWorkflow({ starred: !profileDraft.starred })"
          >
            {{ profileDraft.starred ? '已星标' : '星标' }}
          </button>
          <label>
            重要度
            <select v-model="profileDraft.priority" :disabled="!canEditWorkflow" @change="saveWorkflow({ priority: profileDraft.priority })">
              <option value="low">低</option>
              <option value="normal">普通</option>
              <option value="high">高</option>
              <option value="urgent">紧急</option>
            </select>
          </label>
          <label>
            跟进提醒
            <input
              v-model="profileDraft.follow_up_at"
              type="datetime-local"
              :disabled="!canEditWorkflow"
              @change="saveWorkflow({ follow_up_at: profileDraft.follow_up_at })"
            >
          </label>
        </div>
      </section>

      <section class="inspector-section customer-profile-section">
        <div class="section-title">群备注字段</div>
        <label>
          内部展示名
          <input v-model="profileDraft.internal_display_name" type="text" :disabled="!canManageManualGroups">
        </label>
        <label>
          客户类型
          <input v-model="profileDraft.customer_type" type="text" :disabled="!canManageManualGroups">
        </label>
        <label>
          负责人备注
          <textarea v-model="profileDraft.owner_note" rows="3" :disabled="!canManageManualGroups"></textarea>
        </label>
        <el-button size="small" type="primary" :disabled="!canManageManualGroups" @click="saveProfileFields">
          保存群资料
        </el-button>
      </section>

      <section class="inspector-section workbench-tags-section">
        <div class="section-title">工作台标签</div>
        <div class="tag-stack">
          <span
            v-for="label in workbenchTags"
            :key="label.id || label.native_label_id"
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
          @change="emitManualGroupsChange"
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

        <div class="manual-tag-helper">
          {{ manualHelperText }}
        </div>
      </section>

      <section class="inspector-section">
        <div class="section-title">渠道分组</div>
        <div class="tag-stack">
          <span
            v-for="label in channelGroups"
            :key="label.id || label.native_label_id"
            class="group-tag channel-tag"
            :title="labelTitle(label)"
          >
            {{ labelDisplayName(label) }}
          </span>
          <span v-if="!channelGroups.length" class="group-tag muted">暂无同步分组</span>
        </div>
      </section>

      <section class="inspector-section">
        <div class="section-title">服务账号</div>
        <dl class="meta-list">
          <div>
            <dt>展示名</dt>
            <dd>{{ group.account_display_name || group.account }}</dd>
          </div>
          <div>
            <dt>账号</dt>
            <dd>{{ group.account }}</dd>
          </div>
          <div>
            <dt>用途</dt>
            <dd>{{ accountRoleText(group.account_role) }}</dd>
          </div>
          <div>
            <dt>风险</dt>
            <dd>{{ riskText(group.risk_level) }}</dd>
          </div>
        </dl>
      </section>

      <section class="inspector-section">
        <div class="section-title">发送安全</div>
        <div class="status-grid">
          <span :class="statusClass(canSend)">
            {{ canSend ? '允许发送' : '禁止发送' }}
          </span>
          <span :class="statusClass(group.sync_groups_enabled)">
            {{ group.sync_groups_enabled ? '同步分组' : '不同步分组' }}
          </span>
          <span :class="statusClass(isOnline)">
            {{ isOnline ? 'worker 在线' : 'worker 未确认' }}
          </span>
          <span class="status-neutral">按服务账号隔离</span>
        </div>
      </section>

      <section class="inspector-section">
        <div class="section-title">会话状态</div>
        <dl class="meta-list">
          <div>
            <dt>负责人</dt>
            <dd>{{ assignmentText }}</dd>
          </div>
          <div>
            <dt>未读</dt>
            <dd>{{ group.unread_count || 0 }}</dd>
          </div>
          <div>
            <dt>当前加载</dt>
            <dd>{{ messages.length }} 条</dd>
          </div>
          <div>
            <dt>最后消息</dt>
            <dd>{{ formatTime(group.last_message_time) || '-' }}</dd>
          </div>
        </dl>
      </section>

      <section class="inspector-section notes-section">
        <div class="section-title">内部备注</div>
        <div v-if="notes.length" class="note-list">
          <article v-for="note in notes" :key="note.id" class="note-item">
            <strong>{{ note.actor_name || note.created_by }}</strong>
            <p>{{ note.body }}</p>
            <time>{{ formatTime(note.created_at) }}</time>
          </article>
        </div>
        <div v-else class="empty-mini">暂无备注</div>
        <textarea v-model="noteDraft" rows="3" placeholder="添加内部备注"></textarea>
        <el-button size="small" type="primary" :disabled="!noteDraft.trim()" @click="submitNote">
          添加备注
        </el-button>
      </section>

      <section class="inspector-section presence-section">
        <div class="section-title">协作防撞</div>
        <div v-if="presence.length" class="presence-list">
          <span v-for="item in presence" :key="`${item.operator_id}-${item.mode}`">
            {{ item.actor_name || item.operator_id }} · {{ presenceModeText(item.mode) }}
          </span>
        </div>
        <div v-else class="empty-mini">暂无其他坐席查看</div>
      </section>

      <section class="inspector-section timeline-section">
        <div class="section-title">操作时间线</div>
        <div v-if="timeline.length" class="timeline-list">
          <article v-for="event in timeline" :key="event.id">
            <strong>{{ timelineText(event) }}</strong>
            <span>{{ event.actor_name || event.actor_id }} · {{ formatTime(event.created_at) }}</span>
          </article>
        </div>
        <div v-else class="empty-mini">暂无操作记录</div>
      </section>

      <section class="inspector-note">
        <strong>账号用途设置</strong>
        <span>权限管理 -> 服务账号范围 -> 账号用途</span>
        <small>运行时白名单只作为保险，不作为唯一配置来源。</small>
      </section>
    </template>

    <template v-else>
      <section class="inspector-empty">
        <div class="empty-symbol">i</div>
        <strong>选择会话后显示详情</strong>
        <span>这里会显示服务账号、标签、渠道分组、权限和发送安全状态。</span>
      </section>
    </template>
  </aside>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { formatTime, platformClass, platformName } from '../utils/format';

const props = defineProps({
  group: {
    type: Object,
    default: null,
  },
  messages: {
    type: Array,
    default: () => [],
  },
  manualGroups: {
    type: Array,
    default: () => [],
  },
  savingManualGroups: {
    type: Boolean,
    default: false,
  },
  workspaceDetail: {
    type: Object,
    default: () => ({ profile: null, notes: [], timeline: [], presence: [] }),
  },
  loadingWorkspace: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['manual-groups-change', 'manual-group-create', 'workspace-save', 'note-create']);
const manualDraft = reactive({
  name: '',
});
const noteDraft = ref('');
const profileDraft = reactive({
  status: 'pending',
  priority: 'normal',
  starred: false,
  follow_up_at: '',
  internal_display_name: '',
  customer_type: '',
  owner_note: '',
});

const statusOptions = [
  { value: 'pending', label: '待处理' },
  { value: 'in_progress', label: '跟进中' },
  { value: 'resolved', label: '已解决' },
  { value: 'paused', label: '暂停' },
];

const isOnline = computed(() => {
  if (!props.group || !props.group.account_status) return false;
  return ['online', 'authenticated', 'monitoring', 'healthy'].includes(String(props.group.account_status));
});

const canSend = computed(() => (
  props.group && props.group.send_enabled !== false && Number(props.group.send_enabled) !== 0
));

const assignmentText = computed(() => {
  const assignment = props.group && props.group.assignment;
  if (!assignment) return '未认领';
  return assignment.assigned_to_name || assignment.assigned_to || '已认领';
});

const canManageManualGroups = computed(() => (
  props.group &&
  props.group.permissions &&
  props.group.permissions.can_manage === true
));

const canEditWorkflow = computed(() => (
  props.group &&
  props.group.permissions &&
  props.group.permissions.can_view !== false
));

const workspaceProfile = computed(() => (
  props.workspaceDetail && props.workspaceDetail.profile ? props.workspaceDetail.profile : props.group || {}
));

const notes = computed(() => (
  props.workspaceDetail && Array.isArray(props.workspaceDetail.notes) ? props.workspaceDetail.notes : []
));

const timeline = computed(() => (
  props.workspaceDetail && Array.isArray(props.workspaceDetail.timeline) ? props.workspaceDetail.timeline : []
));

const presence = computed(() => (
  props.workspaceDetail && Array.isArray(props.workspaceDetail.presence) ? props.workspaceDetail.presence : []
));

const displayGroupName = computed(() => (
  workspaceProfile.value.internal_display_name ||
  props.group?.display_group_name ||
  props.group?.group_name ||
  ''
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

const workbenchTags = computed(() => (
  ((props.group && props.group.labels) || []).filter(isWorkbenchTag)
));

const channelGroups = computed(() => (
  ((props.group && props.group.labels) || []).filter((label) => !isWorkbenchTag(label))
));

const selectedManualGroupIds = computed(() => (
  workbenchTags.value
    .map((label) => String(label.native_group_id || label.native_label_id || '').trim())
    .filter(Boolean)
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

const canSubmitManualGroup = computed(() => {
  if (!canManageManualGroups.value || props.savingManualGroups) return false;
  if (!manualDraft.name.trim()) return false;
  return true;
});

const manualHelperText = computed(() => (
  canManageManualGroups.value ? '标签保存在工作台自己的数据库中，不会写回 WA/TG 原生分组。' : '当前账号没有标签管理权限'
));

watch(
  () => props.group && props.group.id,
  () => {
    manualDraft.name = '';
    noteDraft.value = '';
    syncProfileDraft();
  },
);

watch(
  () => props.workspaceDetail && props.workspaceDetail.profile,
  () => syncProfileDraft(),
  { immediate: true, deep: true },
);

function emitManualGroupsChange(values) {
  emit('manual-groups-change', values);
}

function submitManualGroup() {
  if (!canSubmitManualGroup.value) return;
  emit('manual-group-create', {
    name: manualDraft.name.trim(),
    group_level: 1,
  });
  manualDraft.name = '';
}

function saveWorkflow(patch) {
  if (!canEditWorkflow.value) return;
  const normalized = { ...patch };
  if (Object.prototype.hasOwnProperty.call(normalized, 'follow_up_at')) {
    normalized.follow_up_at = normalizeDateTimeLocal(normalized.follow_up_at);
  }
  emit('workspace-save', normalized);
}

function saveProfileFields() {
  if (!canManageManualGroups.value) return;
  emit('workspace-save', {
    internal_display_name: profileDraft.internal_display_name,
    customer_type: profileDraft.customer_type,
    owner_note: profileDraft.owner_note,
  });
}

function submitNote() {
  const body = noteDraft.value.trim();
  if (!body) return;
  emit('note-create', body);
  noteDraft.value = '';
}

function syncProfileDraft() {
  const profile = workspaceProfile.value || {};
  profileDraft.status = profile.status || profile.conversation_status || 'pending';
  profileDraft.priority = profile.priority || 'normal';
  profileDraft.starred = Boolean(profile.starred);
  profileDraft.follow_up_at = toDateTimeLocal(profile.follow_up_at);
  profileDraft.internal_display_name = profile.internal_display_name || '';
  profileDraft.customer_type = profile.customer_type || '';
  profileDraft.owner_note = profile.owner_note || '';
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
  const prefix = isWorkbenchTag(label) ? '工作台标签' : '渠道分组';
  return `${prefix} · ${labelDisplayName(label)}`;
}

function platformShort(platform) {
  if (platform === 'wa') return 'W';
  if (platform === 'tg') return 'T';
  return '?';
}

function accountRoleText(role) {
  if (role === 'service') return '服务账号';
  if (role === 'both') return '采集 + 服务';
  if (role === 'collector') return '采集账号';
  if (role === 'disabled') return '停用';
  return role || '服务账号';
}

function riskText(risk) {
  if (risk === 'high') return '高';
  if (risk === 'medium') return '中';
  return '低';
}

function statusClass(value) {
  return value ? 'status-ok' : 'status-warn';
}

function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeDateTimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function presenceModeText(mode) {
  if (mode === 'typing') return '正在输入';
  if (mode === 'replying') return '正在回复';
  return '正在查看';
}

function timelineText(event) {
  const map = {
    'conversation.profile.update': '更新会话资料',
    'conversation.note.create': '添加内部备注',
    'conversation.manual_groups.update': '更新工作台标签',
    'conversation.read': '标记已读',
    'conversation.assign': '认领/移交会话',
    'conversation.release': '释放会话',
    'conversation.bulk.mark_read': '批量标已读',
    'conversation.bulk.assign': '批量认领/移交',
    'conversation.bulk.release': '批量释放',
    'conversation.bulk.add_tags': '批量打标签',
    'reply.create': '创建外发回复',
    'outbound.cancel': '取消外发',
    'outbound.retry': '重试外发',
  };
  return map[event.action_type] || event.action_type || '操作';
}
</script>
