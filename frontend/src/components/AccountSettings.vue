<template>
  <main class="account-page">
    <header class="account-header">
      <div>
        <h1>账户设置</h1>
        <p>当前工作台登录身份与服务范围</p>
      </div>
      <div class="account-header-actions">
        <el-button @click="$emit('back')">返回工作台</el-button>
        <el-button type="danger" plain @click="logout">退出登录</el-button>
      </div>
    </header>

    <section class="account-layout">
      <section class="account-panel">
        <div class="account-avatar">账</div>
        <div class="account-main">
          <h2>{{ displayName }}</h2>
          <span>{{ username }}</span>
        </div>
        <el-tag :type="operatorStatus === 'active' ? 'success' : 'info'">
          {{ operatorStatus === 'active' ? '启用' : '停用' }}
        </el-tag>
      </section>

      <section class="account-panel account-info-grid">
        <div class="account-info-item">
          <span>工作台身份</span>
          <strong>{{ identity }}</strong>
        </div>
        <div class="account-info-item">
          <span>工作台角色</span>
          <strong>{{ roleText }}</strong>
        </div>
        <div class="account-info-item">
          <span>登录方式</span>
          <strong>{{ loginSource }}</strong>
        </div>
        <div class="account-info-item">
          <span>权限入口</span>
          <strong>{{ portalText }}</strong>
        </div>
      </section>

      <section class="account-panel">
        <div class="account-section-head">
          <h2>服务账号范围</h2>
          <el-tag>{{ serviceAccountCount }} 个服务账号</el-tag>
        </div>
        <div class="account-scope-summary">
          <span>{{ scopeModeText }}</span>
          <strong>{{ serviceScopeText }}</strong>
        </div>
        <div v-if="visibleAccounts.length" class="account-service-list">
          <span
            v-for="account in visibleAccounts"
            :key="`${account.platform}:${account.account}`"
            class="account-service-chip"
          >
            {{ platformText(account.platform) }} · {{ account.account_display_name || account.account }}
          </span>
        </div>
      </section>

      <section class="account-panel account-note">
        <h2>服务账号登录位置</h2>
        <p>WA/TG 服务账号从工作台自己的登录入口发起，由工作台运行态 worker 执行登录和维护，账号权限与会话数据不与监控项目共用。</p>
      </section>
    </section>
  </main>
</template>

<script setup>
import { computed } from 'vue';
import { logoutSso } from '../api';

const props = defineProps({
  operator: {
    type: Object,
    default: null,
  },
  user: {
    type: Object,
    default: null,
  },
  portalAccess: {
    type: Object,
    default: () => ({ can_workbench: true, can_admin: false }),
  },
  accountScope: {
    type: Object,
    default: () => ({ mode: 'all', active: false, accounts: [] }),
  },
  accounts: {
    type: Array,
    default: () => [],
  },
});

defineEmits(['back']);

const displayName = computed(() => (
  props.operator?.display_name ||
  props.user?.display_name ||
  props.user?.displayName ||
  props.user?.name ||
  props.operator?.username ||
  '工作台账户'
));

const identity = computed(() => String(
  props.operator?.id ||
  props.user?.id ||
  props.user?.uid ||
  props.operator?.username ||
  props.user?.username ||
  '-',
));
const username = computed(() => props.operator?.username || props.user?.username || props.user?.email || identity.value);
const operatorStatus = computed(() => props.operator?.status || 'active');
const loginSource = computed(() => (props.user?.source || props.operator?.auth_source || '工作台统一登录网关'));

const roleText = computed(() => {
  const role = String(props.operator?.role || props.user?.role || '').trim();
  if (role === 'super_admin') return '超级管理员';
  if (role === 'admin') return '管理员';
  if (role === 'agent') return '坐席';
  if (role === 'viewer') return '只读';
  return role || '坐席';
});

const portalText = computed(() => {
  const items = ['工作台'];
  if (props.portalAccess?.can_admin) items.push('权限配置');
  return items.join(' / ');
});

const scopedAccounts = computed(() => (
  props.accountScope?.active && Array.isArray(props.accountScope.accounts)
    ? props.accountScope.accounts
    : props.accounts
));

const serviceAccountCount = computed(() => scopedAccounts.value.length);

const visibleAccounts = computed(() => scopedAccounts.value.slice(0, 12));

const scopeModeText = computed(() => {
  if (!props.accountScope?.active) return '全部服务账号';
  if (props.accountScope.mode === 'explicit') return '显式授权范围';
  if (props.accountScope.mode === 'logged-in') return '当前账户授权范围';
  return '受限服务范围';
});

const serviceScopeText = computed(() => {
  if (!serviceAccountCount.value) return '暂无可访问服务账号';
  if (serviceAccountCount.value > visibleAccounts.value.length) {
    return `已显示 ${visibleAccounts.value.length} 个，合计 ${serviceAccountCount.value} 个`;
  }
  return `合计 ${serviceAccountCount.value} 个`;
});

function platformText(platform) {
  if (platform === 'wa') return 'WA';
  if (platform === 'tg') return 'TG';
  return String(platform || '').toUpperCase() || '渠道';
}

function logout() {
  logoutSso();
}
</script>
