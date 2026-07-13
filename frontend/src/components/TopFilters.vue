<template>
  <header class="topbar">
    <div class="toolbar-title">
      <strong>社媒客服工作台</strong>
      <span>{{ toolbarSubtitle }}</span>
    </div>

    <el-input
      class="topbar-search"
      :model-value="modelValue.search"
      clearable
      placeholder="搜索会话…"
      aria-label="搜索会话"
      @input="(search) => update({ search })"
    >
      <template #prefix><el-icon><Search /></el-icon></template>
    </el-input>

    <div class="segmented platform-tabs" aria-label="平台过滤">
      <button
        v-for="platform in visiblePlatforms"
        :key="platform.value"
        class="segment"
        :class="{ active: modelValue.platforms.includes(platform.value) }"
        type="button"
        @click="selectPlatform(platform.value)"
      >
        <span class="platform-dot" :class="platform.className"></span>
        {{ platform.label }}
      </button>
    </div>

    <div class="segmented scope-tabs" aria-label="范围过滤">
      <button
        v-for="scope in scopes"
        :key="scope.value"
        class="segment"
        :class="{ active: modelValue.scope === scope.value }"
        type="button"
        @click="update({ scope: scope.value })"
      >{{ scope.label }}</button>
    </div>

    <el-select
      class="account-select"
      :model-value="modelValue.accountKeys || []"
      placeholder="全部服务账号"
      clearable
      multiple
      collapse-tags
      collapse-tags-tooltip
      :disabled="!visibleAccounts.length"
      @change="(accountKeys) => update({ accountKeys, labelId: '' })"
    >
      <el-option
        v-for="account in visibleAccounts"
        :key="accountKey(account)"
        :label="accountOptionLabel(account)"
        :value="accountKey(account)"
      />
    </el-select>

    <el-select
      class="label-select"
      :model-value="modelValue.labelId"
      placeholder="标签 / 分组"
      clearable
      @change="(labelId) => update({ labelId })"
    >
      <el-option
        v-for="label in labels"
        :key="`${label.platform}:${label.account}:${label.native_label_id}`"
        :label="labelDisplayName(label)"
        :value="label.native_label_id"
      >
        <div class="label-option">
          <span>{{ labelDisplayName(label) }}</span>
          <small>{{ labelSourceText(label) }}</small>
        </div>
      </el-option>
    </el-select>

    <el-button
      class="sync-button"
      :icon="Refresh"
      :loading="syncing"
      :disabled="!modelValue.platforms.length"
      @click="$emit('sync-channels')"
    >同步</el-button>

    <el-button class="profile-toggle-button" @click="$emit('toggle-customer-profile')">
      {{ profileOpen ? '收起处理栏' : '会话处理' }}
    </el-button>
  </header>
</template>

<script setup>
import { computed } from 'vue';
import { Refresh, Search } from '@element-plus/icons-vue';

const props = defineProps({
  modelValue: { type: Object, required: true },
  labels: { type: Array, default: () => [] },
  accounts: { type: Array, default: () => [] },
  availablePlatforms: { type: Array, default: () => [] },
  syncing: { type: Boolean, default: false },
  accountScope: { type: Object, default: () => ({ mode: 'all', active: false, accounts: [] }) },
  profileOpen: { type: Boolean, default: true },
});

const emit = defineEmits(['update:modelValue', 'sync-channels', 'toggle-customer-profile']);
const platforms = [
  { value: 'wa', label: 'WA', className: 'platform-wa' },
  { value: 'tg', label: 'TG', className: 'platform-tg' },
];
const scopes = [{ value: 'unread', label: '未读' }, { value: 'all', label: '全部' }];

const visiblePlatforms = computed(() => {
  const allowed = new Set(props.availablePlatforms.filter(Boolean));
  return allowed.size ? platforms.filter((platform) => allowed.has(platform.value)) : platforms;
});
const visibleAccounts = computed(() => {
  const selected = new Set((props.modelValue.platforms || []).filter(Boolean));
  return props.accounts.filter((account) => !selected.size || selected.has(account.platform));
});
const toolbarSubtitle = computed(() => {
  if (props.accountScope?.active && props.accountScope.mode === 'explicit') return '已授权服务账号';
  if (props.modelValue.accountKeys?.length) return `${props.modelValue.accountKeys.length} 个服务账号`;
  return '全部会话';
});

function update(patch) { emit('update:modelValue', { ...props.modelValue, ...patch }); }
function selectPlatform(platform) {
  if (props.modelValue.platforms.length === 1 && props.modelValue.platforms[0] === platform) return;
  update({ platforms: [platform], accountKeys: [], labelId: '' });
}
function accountKey(account) { return `${account.platform}:${account.account}`; }
function accountOptionLabel(account) { return account.account_display_name || account.account; }
function labelDisplayName(label) { return label.name || label.native_label_id; }
function labelSourceText(label) {
  if (Number(label.is_manual) === 1 || String(label.source || '').startsWith('manual')) return '工作台标签';
  if (label.source === 'wa_label') return 'WA 同步标签';
  if (label.source === 'tg_group' || label.source === 'tg_folder') return 'TG 同步文件夹';
  return '渠道分组';
}
</script>
