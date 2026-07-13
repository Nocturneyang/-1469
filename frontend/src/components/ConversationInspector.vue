<template>
  <aside class="inspector-pane customer-profile-pane">
    <template v-if="group">
      <header class="inspector-work-header">
        <div><span>会话处理</span><small>状态、备注与协作动态</small></div>
        <span class="inspector-platform" :class="platformClass(group.platform)">{{ platformShort(group.platform) }}</span>
      </header>

      <section class="inspector-section status-section">
        <div class="section-title">状态</div>
        <el-select v-model="profileDraft.status" :disabled="!canManage" @change="saveField({ status: $event })">
          <el-option label="待处理" value="pending" />
          <el-option label="跟进中" value="in_progress" />
          <el-option label="已解决" value="resolved" />
          <el-option label="暂停" value="paused" />
        </el-select>
        <div class="conversation-health"><i></i>{{ isOnline ? '会话活跃' : '渠道暂未在线' }}</div>
      </section>

      <section class="inspector-section notes-section">
        <div class="section-heading"><div class="section-title">内部备注</div><el-button v-if="workspaceDetail.notes_paging?.has_more" text @click="$emit('load-more-notes')">查看全部</el-button></div>
        <div v-if="notes.length" class="note-list">
          <article v-for="note in notes.slice(0, 3)" :key="note.id" class="note-item"><strong>{{ note.actor_name || note.created_by }}</strong><p>{{ note.body }}</p><time>{{ formatTime(note.created_at) }}</time></article>
        </div>
        <div v-else class="empty-mini">暂无备注</div>
        <textarea v-model="noteDraft" rows="4" maxlength="2000" :disabled="!canWriteNote" placeholder="记录沟通背景、待办或交接信息…"></textarea>
        <el-button type="primary" size="small" :disabled="!canWriteNote || !noteDraft.trim()" @click="submitNote">添加备注</el-button>
      </section>

      <section class="inspector-section activity-section">
        <div class="section-heading"><div class="section-title">最近动态</div><el-button v-if="workspaceDetail.timeline_paging?.has_more" text @click="$emit('load-more-timeline')">查看全部</el-button></div>
        <div v-if="presence.length" class="presence-list"><span v-for="item in presence" :key="`${item.operator_id}-${item.mode}`">{{ item.actor_name || item.operator_id }} · {{ presenceModeText(item.mode) }}</span></div>
        <div v-if="timeline.length" class="timeline-list">
          <article v-for="event in timeline.slice(0, 3)" :key="event.id"><strong>{{ timelineText(event) }}</strong><span>{{ event.actor_name || event.actor_id }} · {{ formatTime(event.created_at) }}</span></article>
        </div>
        <div v-if="!presence.length && !timeline.length" class="empty-mini">暂无新的协作动态</div>
      </section>

      <details class="inspector-section delivery-section" :open="deliveryNeedsAttention">
        <summary><span>渠道与发送状态</span><em :class="deliveryNeedsAttention ? 'status-warn' : 'status-ok'">{{ deliverySummary }}</em></summary>
        <div class="status-grid profile-status-grid">
          <span :class="statusClass(canReply)">{{ canReply ? '可回复' : '只读' }}</span>
          <span :class="statusClass(isOnline)">{{ isOnline ? '账号在线' : '账号未在线' }}</span>
          <span :class="statusClass(sendEnabled)">{{ sendEnabled ? '发送开启' : '发送关闭' }}</span>
          <span :class="statusClass(!breakerActive)">{{ breakerActive ? '发送熔断中' : '发送正常' }}</span>
        </div>
      </details>
    </template>
    <section v-else class="inspector-empty"><div class="empty-symbol">处</div><strong>选择会话后开始处理</strong><span>状态、内部备注和协作动态会显示在这里。</span></section>
  </aside>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { formatTime, platformClass } from '../utils/format';

const props = defineProps({ group: { type: Object, default: null }, workspaceDetail: { type: Object, default: () => ({ profile: null, notes: [], timeline: [], presence: [] }) } });
const emit = defineEmits(['workspace-save', 'note-create', 'load-more-notes', 'load-more-timeline']);
const noteDraft = ref('');
const profileDraft = reactive({ status: 'pending' });
const profile = computed(() => props.workspaceDetail?.profile || props.group || {});
const notes = computed(() => props.workspaceDetail?.notes || []);
const timeline = computed(() => props.workspaceDetail?.timeline || []);
const presence = computed(() => props.workspaceDetail?.presence || []);
const canManage = computed(() => props.group?.permissions?.can_manage === true);
const canReply = computed(() => props.group?.permissions?.can_reply === true);
const canWriteNote = computed(() => canReply.value || canManage.value);
const sendEnabled = computed(() => Boolean(props.group && props.group.send_enabled !== false && Number(props.group.send_enabled) !== 0 && props.group.global_send_enabled === true));
const breakerActive = computed(() => Boolean(props.group?.send_breaker_active));
const isOnline = computed(() => ['online', 'authenticated', 'ready', 'monitoring', 'healthy'].includes(String(props.group?.account_status || '').toLowerCase()));
const deliveryNeedsAttention = computed(() => !canReply.value || !isOnline.value || !sendEnabled.value || breakerActive.value);
const deliverySummary = computed(() => deliveryNeedsAttention.value ? '需关注' : '发送正常');

watch(() => props.group?.id, () => { noteDraft.value = ''; syncDraft(); });
watch(() => props.workspaceDetail?.profile, syncDraft, { immediate: true, deep: true });
function syncDraft() { profileDraft.status = profile.value?.status || profile.value?.conversation_status || 'pending'; }
function saveField(patch) { if (canManage.value) emit('workspace-save', patch); }
function submitNote() { const body = noteDraft.value.trim(); if (!body || !canWriteNote.value) return; emit('note-create', body); noteDraft.value = ''; }
function platformShort(platform) { return platform === 'wa' ? 'W' : platform === 'tg' ? 'T' : '?'; }
function statusClass(value) { return value ? 'status-ok' : 'status-warn'; }
function presenceModeText(mode) { return mode === 'typing' ? '正在输入' : mode === 'replying' ? '正在回复' : '正在查看'; }
function timelineText(event) { return ({ 'conversation.profile.update': '更新会话状态', 'conversation.note.create': '添加内部备注', 'conversation.manual_groups.update': '更新工作台标签', 'conversation.read': '标记已读', 'reply.create': '创建外发回复', 'outbound.cancel': '取消外发', 'outbound.retry': '重试外发' })[event.action_type] || event.action_type || '操作'; }
</script>
