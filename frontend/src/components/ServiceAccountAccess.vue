<template>
  <main class="service-access-page">
    <header class="service-access-header">
      <div>
        <h1>服务账号</h1>
        <p>WA/TG 账号状态、登录入口与工作台可见范围</p>
      </div>
      <div class="service-access-actions">
        <el-button type="primary" @click="$emit('open-login')">新增登录</el-button>
        <el-button @click="$emit('back')">返回工作台</el-button>
      </div>
    </header>

    <section class="service-access-summary">
      <div class="service-access-stat">
        <span>账号记录</span>
        <strong>{{ accounts.length }}</strong>
      </div>
      <div class="service-access-stat">
        <span>已接入</span>
        <strong>{{ readyCount }}</strong>
      </div>
      <div class="service-access-stat">
        <span>允许发送</span>
        <strong>{{ sendEnabledCount }}</strong>
      </div>
      <div class="service-access-stat">
        <span>授权模式</span>
        <strong>{{ scopeText }}</strong>
      </div>
    </section>

    <section class="service-access-body">
      <article
        v-for="account in accounts"
        :key="`${account.platform}:${account.account}`"
        class="service-access-card"
      >
        <div class="service-access-card-head">
          <div class="service-access-title">
            <span class="platform-icon" :class="platformClass(account.platform)">
              {{ platformShort(account.platform) }}
            </span>
            <div>
              <h2>{{ account.account_display_name || account.account }}</h2>
              <small>{{ account.account }}</small>
            </div>
          </div>
          <el-tag :type="statusType(account)">{{ statusText(account) }}</el-tag>
        </div>

        <div class="service-access-meta">
          <div>
            <span>用途</span>
            <strong>{{ roleText(account.account_role) }}</strong>
          </div>
          <div>
            <span>发送</span>
            <strong>{{ sendText(account) }}</strong>
          </div>
          <div>
            <span>分组同步</span>
            <strong>{{ enabledText(account.sync_groups_enabled) }}</strong>
          </div>
          <div>
            <span>风险</span>
            <strong>{{ riskText(account.risk_level) }}</strong>
          </div>
          <div>
            <span>会话消息</span>
            <strong>{{ Number(account.message_count || 0).toLocaleString('zh-CN') }}</strong>
          </div>
          <div>
            <span>最近同步</span>
            <strong>{{ timeText(account.last_channel_sync_at) }}</strong>
          </div>
          <div>
            <span>运行状态</span>
            <strong>{{ account.runtime_phase || account.runtime_status || accountStatus(account) || '未上报' }}</strong>
          </div>
          <div>
            <span>已就绪</span>
            <strong>{{ runtimeDuration(account.runtime_ready_for_seconds) }}</strong>
          </div>
        </div>

        <p v-if="account.runtime_last_error" class="service-access-runtime-error">最近运行错误：{{ account.runtime_last_error }}</p>

        <div class="service-access-method">
          <span>接入方式</span>
          <strong>{{ methodText(account.platform) }}</strong>
        </div>

        <div v-if="canManage" class="service-access-card-actions">
          <el-button
            size="small"
            :type="Number(account.send_enabled) === 0 ? 'warning' : 'danger'"
            plain
            @click="toggleAccountSend(account)"
          >
            {{ Number(account.send_enabled) === 0 ? '开启账号发送' : '关闭账号发送' }}
          </el-button>
          <el-button v-if="account.send_breaker_active" size="small" type="danger" @click="releaseBreaker(account)">
            人工解除熔断
          </el-button>
          <el-button
            size="small"
            plain
            :loading="isLifecycleBusy(account, 'logout')"
            :disabled="!canLogout(account) || isAnyLifecycleBusy(account)"
            @click="logoutAccount(account)"
          >
            {{ accountStatus(account) === 'logout_requested' ? '退出中' : '退出登录' }}
          </el-button>
          <el-button
            type="danger"
            plain
            size="small"
            :loading="isLifecycleBusy(account, 'delete')"
            :disabled="isAnyLifecycleBusy(account)"
            @click="deleteAccount(account)"
          >
            彻底删除
          </el-button>
        </div>
      </article>

      <section v-if="!accounts.length" class="service-access-empty">
        暂无服务账号。
      </section>
    </section>
  </main>
</template>

<script setup>
import { computed, ref } from 'vue';
import ElMessage from 'element-plus/es/components/message/index.mjs';
import ElMessageBox from 'element-plus/es/components/message-box/index.mjs';
import { platformClass } from '../utils/format';
import {
  deleteServiceAccount,
  logoutServiceAccount,
  releaseServiceAccountBreaker,
  updateServiceAccountSettings,
} from '../api';

const props = defineProps({
  accounts: {
    type: Array,
    default: () => [],
  },
  accountScope: {
    type: Object,
    default: () => ({ mode: 'all', active: false, accounts: [] }),
  },
  canManage: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits(['back', 'open-login', 'account-deleted', 'settings-change', 'refresh-accounts']);

const readyStatuses = new Set(['online', 'authenticated', 'ready', 'monitoring', 'healthy']);
const deletableStatuses = new Set(['logged_out', 'disconnected', 'requires_login', 'auth_failed', 'failed', 'logout_failed']);
const savingTypes = ref(false);
const lifecycleBusy = ref(new Set());

const readyCount = computed(() => props.accounts.filter((account) => isReady(account)).length);
const sendEnabledCount = computed(() => props.accounts.filter((account) => canSend(account)).length);
const scopeText = computed(() => {
  if (!props.accountScope?.active) return '全部';
  if (props.accountScope.mode === 'explicit') return '显式授权';
  if (props.accountScope.mode === 'logged-in') return '当前账户';
  return '受限';
});

function isReady(account) {
  if (account.is_connected === true || account.is_connected === 1) return true;
  return readyStatuses.has(String(account.account_status || '').toLowerCase());
}

function canSend(account) {
  if (account.can_send === true || account.can_send === 1) return true;
  return isReady(account) && account.global_send_enabled === true && Number(account.send_enabled) !== 0;
}

function statusType(account) {
  if (isReady(account)) return 'success';
  if (String(account.account_status || '').toLowerCase() === 'failed') return 'danger';
  if (account.account_status) return 'warning';
  return 'info';
}

function statusText(account) {
  if (accountStatus(account) === 'logout_requested') return '退出中';
  if (accountStatus(account) === 'logged_out') return '已退出';
  if (isReady(account)) return '已接入';
  if (account.account_status) return account.account_status;
  return '待接入';
}

function accountStatus(account) {
  return String(account?.account_status || '').trim().toLowerCase();
}

function runtimeDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
}

function canLogout(account) {
  const status = accountStatus(account);
  return status !== 'logout_requested' && status !== 'logged_out' && status !== 'deleted';
}

function canPermanentlyDelete(account) {
  const status = accountStatus(account);
  return deletableStatuses.has(status) || (!status && !isReady(account));
}

function lifecycleKey(account, action) {
  return `${account.platform}:${account.account}:${action}`;
}

function isLifecycleBusy(account, action) {
  return lifecycleBusy.value.has(lifecycleKey(account, action));
}

function isAnyLifecycleBusy(account) {
  return isLifecycleBusy(account, 'logout') || isLifecycleBusy(account, 'delete');
}

function setLifecycleBusy(account, action, busy) {
  const next = new Set(lifecycleBusy.value);
  const key = lifecycleKey(account, action);
  if (busy) next.add(key);
  else next.delete(key);
  lifecycleBusy.value = next;
}

async function logoutAccount(account) {
  const label = account.account_display_name || account.account;
  try {
    await ElMessageBox.confirm(
      `退出 ${label} 的渠道登录？历史消息、分组和账号配置都会保留，之后可重新扫码登录。`,
      '退出登录',
      { confirmButtonText: '确认退出', cancelButtonText: '取消', type: 'warning' },
    );
    setLifecycleBusy(account, 'logout', true);
    const result = await logoutServiceAccount(account.platform, account.account);
    emit('settings-change', {
      ...account,
      account_status: result.status,
      is_connected: false,
      can_send: false,
    });
    ElMessage.success(result.worker_active ? '已提交退出请求，账号正在安全退出' : '账号已退出，历史消息和配置已保留');
    if (result.worker_active) {
      window.setTimeout(() => emit('refresh-accounts'), 12000);
    }
  } catch (err) {
    if (err === 'cancel' || err === 'close') return;
    ElMessage.error(err.response?.data?.error || '退出登录失败');
  } finally {
    setLifecycleBusy(account, 'logout', false);
  }
}

async function deleteAccount(account) {
  const label = account.account_display_name || account.account;
  if (!canPermanentlyDelete(account)) {
    ElMessage.warning(accountStatus(account) === 'logout_requested' ? '账号仍在退出中，请稍后再删除' : '请先退出登录，再彻底删除账号');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `彻底删除 ${label}（${account.account}）？这会删除该账号的所有历史消息、媒体、分组、配置、登录任务和 session。`,
      '彻底删除账号',
      { confirmButtonText: '继续删除', cancelButtonText: '取消', type: 'error' },
    );
    await ElMessageBox.confirm(
      '再次确认：所有历史消息及配置都会永久删除且无法恢复。是否继续？',
      '最终确认',
      { confirmButtonText: '永久删除全部数据', cancelButtonText: '取消', type: 'error' },
    );
    setLifecycleBusy(account, 'delete', true);
    await deleteServiceAccount(account.platform, account.account, {
      confirm_delete_history: true,
      confirm_account: account.account,
    });
    emit('account-deleted', account);
    ElMessage.success('服务账号及其全部历史消息和配置已彻底删除');
  } catch (err) {
    if (err === 'cancel' || err === 'close') return;
    ElMessage.error(err.response?.data?.error || '彻底删除失败');
  } finally {
    setLifecycleBusy(account, 'delete', false);
  }
}

function platformShort(platform) {
  if (platform === 'wa') return 'W';
  if (platform === 'tg') return 'T';
  return '?';
}

function roleText(role) {
  if (role === 'service') return '服务';
  if (role === 'both') return '服务 + 采集';
  if (role === 'collector') return '采集';
  if (role === 'disabled') return '停用';
  return role || '服务';
}

function enabledText(value) {
  return Number(value) === 0 || value === false ? '关闭' : '开启';
}

function sendText(account) {
  if (!isReady(account)) return '未接入';
  if (account.global_send_enabled === false || Number(account.global_send_enabled) === 0) return '全局关闭';
  return Number(account.send_enabled) === 0 ? '账号关闭' : '开启';
}

async function toggleAccountSend(account) {
  const sendEnabled = Number(account.send_enabled) === 0 ? 1 : 0;
  savingTypes.value = true;
  try {
    const settings = await updateServiceAccountSettings(account.platform, account.account, { send_enabled: sendEnabled });
    emit('settings-change', { ...account, send_enabled: Number(settings.send_enabled) });
    ElMessage.success(sendEnabled ? '账号发送已开启；全局开关仍需由部署管理员显式开启' : '账号发送已关闭');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '账号发送设置失败');
  } finally {
    savingTypes.value = false;
  }
}

async function releaseBreaker(account) {
  savingTypes.value = true;
  try {
    await releaseServiceAccountBreaker(account.platform, account.account);
    emit('settings-change', { ...account, send_breaker_active: false, send_breaker_reason: '' });
    ElMessage.success('账号发送熔断已由管理员解除；暂停任务仍需逐条重试');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '解除熔断失败');
  } finally {
    savingTypes.value = false;
  }
}

function riskText(risk) {
  if (risk === 'high') return '高';
  if (risk === 'medium') return '中';
  return '低';
}

function methodText(platform) {
  if (platform === 'wa') return '工作台 WA 扫码登录';
  if (platform === 'tg') return '工作台 TG token/session 登录';
  return '工作台服务账号登录';
}

function timeText(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function accountKey(account) {
  return `${account.platform}:${account.account}`;
}

</script>
