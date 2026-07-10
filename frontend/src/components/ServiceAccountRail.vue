<template>
  <aside class="service-rail" :class="{ collapsed }">
    <div class="rail-brand">
      <div class="brand-mark">客</div>
      <div class="brand-copy">
        <strong>客服工作台</strong>
        <span>WA / TG Inbox</span>
      </div>
      <button
        type="button"
        class="rail-collapse-button"
        :title="collapsed ? '展开侧边栏' : '收起侧边栏'"
        :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'"
        @click="$emit('toggle-collapse')"
      >
        <el-icon>
          <Expand v-if="collapsed" />
          <Fold v-else />
        </el-icon>
      </button>
    </div>

    <div class="portal-shortcuts" aria-label="工作台导航">
      <span class="portal-shortcut active" title="客服工作台">
        <span>客</span>
        <strong>工作台</strong>
      </span>
      <button
        type="button"
        class="portal-shortcut"
        title="服务账号总览与登录"
        @click="$emit('open-service-access')"
      >
        <span>号</span>
        <strong>服务账号</strong>
      </button>
      <a
        v-if="canOpenAdmin"
        class="portal-shortcut"
        href="/admin"
        title="坐席权限管理"
        @click.prevent="$emit('open-permissions')"
      >
        <span>权</span>
        <strong>权限管理</strong>
      </a>
    </div>

    <button
      type="button"
      class="rail-all-button"
      :class="{ active: !selectedAccountKeys.length }"
      :title="`全部已接入账号，${totalMessageCount} 条消息`"
      @click="$emit('clear')"
    >
      <span class="rail-icon">全</span>
      <span>
        <strong>全部已接入账号</strong>
        <small>{{ totalMessageCount }} 条消息</small>
      </span>
    </button>

    <div class="rail-section-title">已接入账号</div>
    <div class="rail-account-list">
      <button
        v-for="account in accounts"
        :key="accountKey(account)"
        type="button"
        class="rail-account"
        :class="{ active: isSelected(account) }"
        :title="accountTitle(account)"
        @click="$emit('select', account)"
      >
        <span class="platform-icon small" :class="platformClass(account.platform)">
          {{ platformShort(account.platform) }}
        </span>
        <span class="rail-account-copy">
          <strong :title="account.account_display_name || account.account">
            {{ account.account_display_name || account.account }}
          </strong>
          <small :title="account.account">{{ platformName(account.platform) }} · {{ account.account }}</small>
        </span>
        <em>{{ compactCount(account.message_count) }}</em>
      </button>
    </div>

    <div class="scope-card">
      <strong>{{ scopeTitle }}</strong>
      <span>{{ scopeDescription }}</span>
      <small v-if="accountScope && accountScope.active">
        {{ scopeAccountCount }} 个账号
      </small>
    </div>

    <button
      type="button"
      class="rail-profile-button"
      title="我的账户"
      @click="$emit('open-account-settings')"
    >
      <span class="rail-icon">我</span>
      <span>
        <strong>{{ operatorName }}</strong>
        <small>我的账户 / 退出</small>
      </span>
    </button>
  </aside>
</template>

<script setup>
import { computed } from 'vue';
import { Expand, Fold } from '@element-plus/icons-vue';
import { platformClass, platformName } from '../utils/format';

const props = defineProps({
  accounts: {
    type: Array,
    default: () => [],
  },
  selectedAccountKeys: {
    type: Array,
    default: () => [],
  },
  accountScope: {
    type: Object,
    default: () => ({ mode: 'all', active: false, accounts: [] }),
  },
  portalAccess: {
    type: Object,
    default: () => ({ can_monitor: false, can_workbench: true, can_admin: false }),
  },
  collapsed: {
    type: Boolean,
    default: false,
  },
  operator: {
    type: Object,
    default: null,
  },
});

defineEmits([
  'select',
  'clear',
  'toggle-collapse',
  'open-permissions',
  'open-account-settings',
  'open-service-access',
]);

const totalMessageCount = computed(() => props.accounts.reduce((sum, account) => (
  sum + Number(account.message_count || 0)
), 0).toLocaleString('zh-CN'));

const scopeAccountCount = computed(() => (
  props.accountScope && Array.isArray(props.accountScope.accounts)
    ? props.accountScope.accounts.length
    : props.accounts.length
));

const scopeTitle = computed(() => {
  if (!props.accountScope || !props.accountScope.active) return '数据库服务账号';
  if (props.accountScope.mode === 'explicit') return '显式服务账号';
  if (props.accountScope.mode === 'logged-in') return '授权服务账号';
  return '账号范围已限制';
});

const canOpenAdmin = computed(() => Boolean(
  props.operator && props.operator.is_super_admin
) || Boolean(props.portalAccess && props.portalAccess.can_admin));

const operatorName = computed(() => (
  props.operator?.display_name ||
  props.operator?.username ||
  '我的账户'
));

const scopeDescription = computed(() => {
  if (!props.accountScope || !props.accountScope.active) return '来自工作台独立数据源的服务账号';
  if (props.accountScope.mode === 'explicit') return '由运行时白名单或后台用途配置共同限制';
  if (props.accountScope.mode === 'logged-in') return '按当前登录身份可访问范围展示';
  return '工作台只展示服务账号会话';
});

function accountKey(account) {
  return `${account.platform}:${account.account}`;
}

function accountTitle(account) {
  const displayName = account.account_display_name || account.account;
  return `${displayName} · ${platformName(account.platform)} · ${account.account} · ${compactCount(account.message_count)} 条`;
}

function isSelected(account) {
  return props.selectedAccountKeys.includes(accountKey(account));
}

function platformShort(platform) {
  if (platform === 'wa') return 'W';
  if (platform === 'tg') return 'T';
  return '?';
}

function compactCount(value) {
  const count = Number(value || 0);
  if (count >= 10000) return `${Math.round(count / 1000) / 10}w`;
  if (count >= 1000) return `${Math.round(count / 100) / 10}k`;
  return count;
}
</script>
