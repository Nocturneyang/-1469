<template>
  <header class="topbar">
    <div class="toolbar-title">
      <strong>Inbox</strong>
      <span>{{ toolbarSubtitle }}</span>
    </div>

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
      >
        {{ scope.label }}
      </button>
    </div>

    <el-select
      class="account-select"
      :model-value="modelValue.accountKeys || []"
      placeholder="全部已接入账号"
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
      >
        <div class="account-option">
          <span>{{ account.account_display_name || account.account }}</span>
          <small>{{ account.account }} · {{ Number(account.message_count || 0) }}</small>
        </div>
      </el-option>
    </el-select>

    <el-select
      class="label-select"
      :model-value="modelValue.labelId"
      placeholder="标签/分组"
      clearable
      @change="(labelId) => update({ labelId })"
    >
      <el-option
        v-for="label in labels"
        :key="`${label.platform}:${label.account}:${label.native_label_id}`"
        :label="labelOptionLabel(label)"
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
    >
      同步渠道分组
    </el-button>

    <el-input
      class="search-input"
      :model-value="modelValue.search"
      placeholder="搜索会话或消息"
      clearable
      @input="(search) => update({ search })"
    >
      <template #prefix>
        <el-icon><Search /></el-icon>
      </template>
    </el-input>
  </header>
</template>

<script setup>
import { computed } from 'vue';
import { Refresh, Search } from '@element-plus/icons-vue';

const props = defineProps({
  modelValue: {
    type: Object,
    required: true,
  },
  labels: {
    type: Array,
    default: () => [],
  },
  accounts: {
    type: Array,
    default: () => [],
  },
  availablePlatforms: {
    type: Array,
    default: () => [],
  },
  syncing: {
    type: Boolean,
    default: false,
  },
  accountScope: {
    type: Object,
    default: () => ({ mode: 'all', active: false, accounts: [] }),
  },
});

const emit = defineEmits(['update:modelValue', 'sync-channels']);

const platforms = [
  { value: 'wa', label: 'WA', className: 'platform-wa' },
  { value: 'tg', label: 'TG', className: 'platform-tg' },
];

const visiblePlatforms = computed(() => {
  const allowed = new Set(props.availablePlatforms.filter(Boolean));
  if (!allowed.size) return platforms;
  return platforms.filter((platform) => allowed.has(platform.value));
});

const visibleAccounts = computed(() => {
  const selectedPlatforms = new Set((props.modelValue.platforms || []).filter(Boolean));
  return props.accounts.filter((account) => (
    !selectedPlatforms.size || selectedPlatforms.has(account.platform)
  ));
});

const toolbarSubtitle = computed(() => {
  if (props.accountScope && props.accountScope.active && props.accountScope.mode === 'explicit') {
    return '显式服务账号范围';
  }
  if (props.modelValue.accountKeys && props.modelValue.accountKeys.length) {
    return `${props.modelValue.accountKeys.length} 个服务账号`;
  }
  return '服务账号 -> 标签/分组 -> 会话';
});

const scopes = [
  { value: 'mine', label: '我的会话' },
  { value: 'unread', label: '未读' },
  { value: 'all', label: '全部' },
];

function update(patch) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}

function selectPlatform(platform) {
  if (props.modelValue.platforms.length === 1 && props.modelValue.platforms[0] === platform) return;
  update({ platforms: [platform], accountKeys: [], labelId: '' });
}

function accountKey(account) {
  return `${account.platform}:${account.account}`;
}

function accountOptionLabel(account) {
  const displayName = account.account_display_name || account.account;
  return `${displayName} (${account.account})`;
}

function labelOptionLabel(label) {
  return labelDisplayName(label);
}

function labelDisplayName(label) {
  return label.name || label.native_label_id;
}

function labelSourceText(label) {
  if (Number(label.is_manual) === 1 || String(label.source || '').startsWith('manual')) {
    return '工作台标签';
  }
  if (label.source === 'wa_label') return 'WA 同步标签';
  if (label.source === 'tg_group' || label.source === 'tg_folder') return 'TG 同步文件夹';
  return label.source || '渠道分组';
}
</script>
