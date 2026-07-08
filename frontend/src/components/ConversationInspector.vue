<template>
  <aside class="inspector-pane">
    <template v-if="group">
      <section class="inspector-profile">
        <div class="profile-avatar" :class="platformClass(group.platform)">
          {{ platformShort(group.platform) }}
        </div>
        <div class="profile-copy">
          <h2 :title="group.group_name">{{ group.group_name }}</h2>
          <p>{{ platformName(group.platform) }} · {{ group.group_id }}</p>
        </div>
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
import { computed, reactive, watch } from 'vue';
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
});

const emit = defineEmits(['manual-groups-change', 'manual-group-create']);
const manualDraft = reactive({
  name: '',
});

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
  },
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
</script>
