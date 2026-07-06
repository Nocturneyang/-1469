<template>
  <div class="workbench-permissions-view">
    <section class="permission-toolbar">
      <div>
        <p class="eyebrow">Workbench Access</p>
        <h2>工作台权限管理</h2>
        <span>按服务账号和分组控制坐席查看、回复、认领和管理权限。</span>
      </div>
      <el-button type="primary" :loading="saving" @click="saveCurrentScopes">保存权限</el-button>
    </section>

    <section class="permission-grid">
      <aside class="permission-panel operator-panel">
        <div class="panel-head">
          <strong>坐席</strong>
          <el-input
            v-model="operatorSearch"
            size="small"
            clearable
            placeholder="搜索 SSO 用户"
            @input="loadOperators"
          />
        </div>

        <div class="new-operator">
          <el-input v-model="newOperator.id" size="small" placeholder="SSO 身份 ID，如 1469" />
          <el-input v-model="newOperator.name" size="small" placeholder="显示名" />
          <el-button size="small" @click="selectNewOperator">选择此用户</el-button>
        </div>

        <div class="operator-list">
          <button
            v-for="operator in operators"
            :key="operator.id"
            type="button"
            class="operator-item"
            :class="{ active: operator.id === selectedOperatorId }"
            @click="selectOperator(operator)"
          >
            <span class="operator-avatar">{{ operatorInitial(operator) }}</span>
            <span>
              <strong>{{ operator.display_name || operator.username || operator.id }}</strong>
              <em>{{ operator.id }}</em>
            </span>
            <el-tag size="small" effect="plain">{{ operator.scope_count || 0 }}</el-tag>
          </button>
        </div>
      </aside>

      <aside class="permission-panel account-panel">
        <div class="panel-head compact">
          <strong>服务账号</strong>
          <span>{{ serviceAccounts.length }} 个</span>
        </div>
        <div v-if="!serviceAccounts.length" class="empty-service-state">
          <strong>还没有可授权的服务账号</strong>
          <p>请先到账号管理，把需要进入工作台的 WA/TG 账号用途改成“服务账号”或“采集 + 服务”。</p>
          <el-button size="small" type="primary" plain @click="goAccountManagement">去账号管理设置</el-button>
        </div>
        <button
          v-for="account in serviceAccounts"
          :key="accountKey(account)"
          type="button"
          class="account-item"
          :class="{ active: accountKey(account) === selectedAccountKey }"
          @click="selectedAccountKey = accountKey(account)"
        >
          <span class="platform-dot" :class="account.platform">{{ platformText(account.platform) }}</span>
          <span>
            <strong>{{ account.display_name || account.account }}</strong>
            <em>{{ account.platform.toUpperCase() }} · {{ account.account }}</em>
          </span>
          <el-tag size="small" :type="account.send_enabled ? 'success' : 'info'">
            {{ account.send_enabled ? '可发送' : '只读' }}
          </el-tag>
        </button>
      </aside>

      <main class="permission-panel matrix-panel">
        <div class="panel-head matrix-head">
          <div>
            <strong>{{ selectedAccountTitle }}</strong>
            <span>入口权限和分组权限保存后全局生效。</span>
          </div>
          <div class="matrix-actions">
            <el-button size="small" @click="applySelectedAccount('all')">授权全部分组</el-button>
            <el-button size="small" @click="applySelectedAccount('readonly')">只读全部分组</el-button>
            <el-button size="small" @click="applySelectedAccount('clear')">取消全部权限</el-button>
          </div>
        </div>

        <div class="portal-access-card">
          <div>
            <strong>允许访问页面</strong>
            <span>控制登录后的系统入口和直接访问权限。</span>
          </div>
          <el-checkbox v-model="portalDraft.can_monitor">监控系统</el-checkbox>
          <el-checkbox v-model="portalDraft.can_workbench">客服工作台</el-checkbox>
          <el-checkbox v-model="portalDraft.can_admin">权限配置</el-checkbox>
          <el-select v-model="portalDraft.default_entry" size="small" class="default-entry-select">
            <el-option label="自动判断" value="auto" />
            <el-option label="显示选择页" value="chooser" />
            <el-option label="默认进监控系统" value="monitor" />
            <el-option label="默认进工作台" value="workbench" />
            <el-option label="默认进权限配置" value="admin" />
          </el-select>
        </div>

        <div class="copy-bar">
          <span>复制当前草稿到</span>
          <el-input v-model="copyTarget.id" size="small" placeholder="目标 SSO 身份 ID" />
          <el-input v-model="copyTarget.name" size="small" placeholder="目标显示名" />
          <el-button size="small" :disabled="!copyTarget.id" @click="copyCurrentScopes">复制并保存</el-button>
        </div>

        <el-table
          v-loading="loadingScopes"
          :data="selectedGroups"
          height="calc(100vh - 300px)"
          row-key="row_key"
          class="permission-table"
          empty-text="当前服务账号暂无分组"
        >
          <el-table-column label="分组" min-width="220">
            <template #default="{ row }">
              <div class="group-cell">
                <span class="group-color" :style="{ background: row.color || '#94a3b8' }"></span>
                <span>
                  <strong>{{ row.name }}</strong>
                  <em>{{ groupSourceText(row) }}</em>
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="查看" width="92" align="center">
            <template #default="{ row }">
              <el-switch :model-value="scopeValue(row, 'can_view')" @change="setScopeValue(row, 'can_view', $event)" />
            </template>
          </el-table-column>
          <el-table-column label="回复" width="92" align="center">
            <template #default="{ row }">
              <el-switch :model-value="scopeValue(row, 'can_reply')" @change="setScopeValue(row, 'can_reply', $event)" />
            </template>
          </el-table-column>
          <el-table-column label="认领" width="92" align="center">
            <template #default="{ row }">
              <el-switch :model-value="scopeValue(row, 'can_assign')" @change="setScopeValue(row, 'can_assign', $event)" />
            </template>
          </el-table-column>
          <el-table-column label="管理" width="92" align="center">
            <template #default="{ row }">
              <el-switch :model-value="scopeValue(row, 'can_manage')" @change="setScopeValue(row, 'can_manage', $event)" />
            </template>
          </el-table-column>
        </el-table>
      </main>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  getWorkbenchOperators,
  getWorkbenchPermissionScopes,
  saveWorkbenchPermissionScopes
} from '@/api/workbenchPermissions'

const router = useRouter()
const ALL_GROUPS = '*'
const UNGROUPED_GROUP = '__ungrouped__'
const operators = ref([])
const serviceAccounts = ref([])
const serviceGroups = ref([])
const selectedOperatorId = ref('')
const selectedOperatorName = ref('')
const selectedAccountKey = ref('')
const operatorSearch = ref('')
const loadingScopes = ref(false)
const saving = ref(false)
const scopeDraft = reactive({})
const portalDraft = reactive({
  can_monitor: false,
  can_workbench: false,
  can_admin: false,
  default_entry: 'auto'
})
const newOperator = reactive({ id: '', name: '' })
const copyTarget = reactive({ id: '', name: '' })

const selectedAccount = computed(() => (
  serviceAccounts.value.find((account) => accountKey(account) === selectedAccountKey.value) || null
))

const selectedAccountTitle = computed(() => {
  const account = selectedAccount.value
  if (!account) return '请选择服务账号'
  return `${account.display_name || account.account} · ${account.platform.toUpperCase()}`
})

const selectedGroups = computed(() => {
  const account = selectedAccount.value
  if (!account) return []
  return serviceGroups.value
    .filter((group) => group.platform === account.platform && group.service_account === account.account)
    .map((group) => ({ ...group, row_key: scopeKey(group) }))
})

onMounted(async () => {
  await loadOperators()
  await loadScopes()
})

async function loadOperators() {
  const res = await getWorkbenchOperators({ search: operatorSearch.value || undefined }).catch(() => ({ data: [] }))
  operators.value = res.data || []
  if (!selectedOperatorId.value && operators.value.length) {
    selectOperator(operators.value[0])
  }
}

async function loadScopes() {
  loadingScopes.value = true
  try {
    const res = await getWorkbenchPermissionScopes({
      operator_id: selectedOperatorId.value || undefined
    })
    const data = res.data || {}
    serviceAccounts.value = data.service_accounts || []
    serviceGroups.value = data.service_groups || []
    resetPortalDraft(data.portal_access)
    resetDraft(data.scopes || [])
    if (!selectedAccountKey.value && serviceAccounts.value.length) {
      selectedAccountKey.value = accountKey(serviceAccounts.value[0])
    }
  } finally {
    loadingScopes.value = false
  }
}

function selectOperator(operator) {
  selectedOperatorId.value = operator.id
  selectedOperatorName.value = operator.display_name || operator.username || operator.id
  copyTarget.id = ''
  copyTarget.name = ''
  loadScopes()
}

function selectNewOperator() {
  const id = newOperator.id.trim()
  if (!id) {
    ElMessage.warning('请输入 SSO 身份 ID')
    return
  }
  selectedOperatorId.value = id
  selectedOperatorName.value = newOperator.name.trim() || id
  copyTarget.id = ''
  copyTarget.name = ''
  resetPortalDraft(null)
  resetDraft([])
  loadScopes()
}

function resetPortalDraft(access) {
  portalDraft.can_monitor = Boolean(access && Number(access.can_monitor) === 1)
  portalDraft.can_workbench = Boolean(access && Number(access.can_workbench) === 1)
  portalDraft.can_admin = Boolean(access && Number(access.can_admin) === 1)
  portalDraft.default_entry = normalizeDefaultEntry(access && access.default_entry)
}

function resetDraft(scopes) {
  Object.keys(scopeDraft).forEach((key) => delete scopeDraft[key])
  scopes.forEach((scope) => {
    const key = scopeKey(scope)
    scopeDraft[key] = {
      platform: scope.platform,
      service_account: scope.service_account,
      native_group_id: scope.native_group_id,
      can_view: Boolean(scope.can_view),
      can_reply: Boolean(scope.can_reply),
      can_assign: Boolean(scope.can_assign),
      can_manage: Boolean(scope.can_manage)
    }
  })
}

function scopeValue(row, capability) {
  return Boolean(scopeDraft[scopeKey(row)]?.[capability])
}

function setScopeValue(row, capability, value) {
  const key = scopeKey(row)
  if (!scopeDraft[key]) {
    scopeDraft[key] = {
      platform: row.platform,
      service_account: row.service_account,
      native_group_id: row.native_group_id,
      can_view: false,
      can_reply: false,
      can_assign: false,
      can_manage: false
    }
  }
  scopeDraft[key][capability] = Boolean(value)
  if (value) {
    portalDraft.can_workbench = true
  }
  if (capability !== 'can_view' && value) {
    scopeDraft[key].can_view = true
  }
  if (capability === 'can_view' && !value) {
    scopeDraft[key].can_reply = false
    scopeDraft[key].can_assign = false
    scopeDraft[key].can_manage = false
  }
}

function applySelectedAccount(mode) {
  selectedGroups.value.forEach((group) => {
    if (mode === 'clear') {
      setScopeValue(group, 'can_view', false)
      return
    }
    setScopeValue(group, 'can_view', true)
    setScopeValue(group, 'can_reply', mode === 'all')
    setScopeValue(group, 'can_assign', mode === 'all')
    setScopeValue(group, 'can_manage', mode === 'all')
  })
}

async function saveCurrentScopes() {
  if (!selectedOperatorId.value) {
    ElMessage.warning('请先选择或输入坐席')
    return
  }
  saving.value = true
  try {
    await saveWorkbenchPermissionScopes({
      operator_id: selectedOperatorId.value,
      operator_name: selectedOperatorName.value || selectedOperatorId.value,
      portal_access: normalizedPortalDraft(),
      scopes: draftList()
    })
    ElMessage.success('工作台权限已保存')
    await loadOperators()
    await loadScopes()
  } finally {
    saving.value = false
  }
}

async function copyCurrentScopes() {
  if (!copyTarget.id.trim()) return
  saving.value = true
  try {
    await saveWorkbenchPermissionScopes({
      operator_id: copyTarget.id.trim(),
      operator_name: copyTarget.name.trim() || copyTarget.id.trim(),
      portal_access: normalizedPortalDraft(),
      scopes: draftList()
    })
    ElMessage.success('权限已复制')
    await loadOperators()
  } finally {
    saving.value = false
  }
}

function normalizedPortalDraft() {
  return {
    can_monitor: portalDraft.can_monitor,
    can_workbench: portalDraft.can_workbench,
    can_admin: portalDraft.can_admin,
    default_entry: normalizeDefaultEntry(portalDraft.default_entry)
  }
}

function normalizeDefaultEntry(value) {
  return ['auto', 'chooser', 'monitor', 'workbench', 'admin'].includes(value) ? value : 'auto'
}

function draftList() {
  return Object.values(scopeDraft)
    .filter((scope) => scope.can_view || scope.can_reply || scope.can_assign || scope.can_manage)
}

function accountKey(account) {
  return `${account.platform}:${account.account}`
}

function scopeKey(scope) {
  return `${scope.platform}:${scope.service_account || scope.account}:${scope.native_group_id}`
}

function platformText(platform) {
  if (platform === 'wa') return 'WA'
  if (platform === 'tg') return 'TG'
  return String(platform || '').toUpperCase()
}

function operatorInitial(operator) {
  return String(operator.display_name || operator.username || operator.id || '?').slice(0, 1).toUpperCase()
}

function groupSourceText(group) {
  if (group.native_group_id === ALL_GROUPS) return '账号全部分组'
  if (group.native_group_id === UNGROUPED_GROUP) return '没有 WA 标签 / TG 分组的会话'
  if (group.source === 'wa_label') return 'WA 标签'
  if (group.source === 'tg_group') return 'TG 分组'
  return group.source || '分组'
}

function goAccountManagement() {
  router.push('/admin/accounts')
}
</script>

<style scoped>
.workbench-permissions-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.permission-toolbar,
.permission-panel {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
}

.permission-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px;
}

.permission-toolbar h2 {
  margin: 2px 0 4px;
  font-size: 22px;
  color: #0f172a;
}

.permission-toolbar span,
.panel-head span,
.operator-item em,
.account-item em,
.group-cell em {
  color: #64748b;
  font-style: normal;
  font-size: 12px;
}

.eyebrow {
  margin: 0;
  color: #0f766e;
  font-size: 12px;
  font-weight: 700;
}

.permission-grid {
  display: grid;
  grid-template-columns: 280px 300px minmax(0, 1fr);
  gap: 16px;
  min-height: calc(100vh - 190px);
}

.permission-panel {
  min-width: 0;
  overflow: hidden;
}

.panel-head {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 14px;
  border-bottom: 1px solid #e2e8f0;
}

.panel-head.compact {
  min-height: 62px;
}

.matrix-head {
  align-items: flex-start;
}

.matrix-head > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.matrix-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.new-operator,
.copy-bar {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #e2e8f0;
}

.copy-bar {
  grid-template-columns: auto minmax(140px, 220px) minmax(120px, 180px) auto;
  align-items: center;
}

.portal-access-card {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) auto auto 180px;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
}

.portal-access-card > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.portal-access-card strong {
  color: #0f172a;
}

.portal-access-card span {
  color: #64748b;
  font-size: 12px;
}

.default-entry-select {
  width: 180px;
}

.operator-list {
  max-height: calc(100vh - 340px);
  overflow: auto;
}

.operator-item,
.account-item {
  width: 100%;
  border: 0;
  border-bottom: 1px solid #f1f5f9;
  background: #fff;
  display: grid;
  align-items: center;
  gap: 10px;
  text-align: left;
  cursor: pointer;
}

.operator-item {
  grid-template-columns: 36px minmax(0, 1fr) auto;
  padding: 12px 14px;
}

.account-item {
  grid-template-columns: 42px minmax(0, 1fr) auto;
  padding: 14px;
}

.empty-service-state {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 14px;
  color: #475569;
  font-size: 13px;
  line-height: 1.6;
}

.empty-service-state strong {
  color: #0f172a;
  font-size: 14px;
}

.empty-service-state p {
  margin: 0;
}

.operator-item:hover,
.account-item:hover,
.operator-item.active,
.account-item.active {
  background: #ecfdf5;
}

.operator-item.active,
.account-item.active {
  box-shadow: inset 3px 0 0 #10b981;
}

.operator-item strong,
.account-item strong,
.group-cell strong {
  display: block;
  overflow: hidden;
  color: #0f172a;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.operator-avatar,
.platform-dot {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #fff;
  background: #0f766e;
  font-size: 12px;
  font-weight: 800;
}

.platform-dot.tg {
  background: #0284c7;
}

.platform-dot.teams {
  background: #4f46e5;
}

.permission-table {
  border-top: 1px solid #f1f5f9;
}

.group-cell {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

.group-color {
  width: 10px;
  height: 32px;
  border-radius: 999px;
}

@media (max-width: 1180px) {
  .permission-grid {
    grid-template-columns: 1fr;
  }

  .operator-list {
    max-height: 320px;
  }

  .copy-bar {
    grid-template-columns: 1fr;
  }

  .portal-access-card {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .default-entry-select {
    width: 100%;
  }
}
</style>
