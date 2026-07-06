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

      <section class="inspector-section">
        <div class="section-title">分组</div>
        <div class="tag-stack">
          <span
            v-for="label in group.labels"
            :key="label.id || label.native_label_id"
            class="group-tag"
          >
            {{ label.name }}
          </span>
          <span v-if="!group.labels || !group.labels.length" class="group-tag muted">未分组</span>
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
        <span>权限配置 -> 帐号管理 -> WA/TG 账号 -> 账号用途</span>
        <small>运行时白名单只作为保险，不作为唯一配置来源。</small>
      </section>
    </template>

    <template v-else>
      <section class="inspector-empty">
        <div class="empty-symbol">i</div>
        <strong>选择会话后显示详情</strong>
        <span>这里会显示服务账号、分组、权限和发送安全状态。</span>
      </section>
    </template>
  </aside>
</template>

<script setup>
import { computed } from 'vue';
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

function platformShort(platform) {
  if (platform === 'wa') return 'W';
  if (platform === 'tg') return 'T';
  if (platform === 'teams') return 'M';
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
