<template>
  <div class="role-management">
    <section class="panel">
      <div class="panel-title access-title">
        <span class="title-text"><span class="panel-icon">▦</span> 角色管理</span>
        <el-button type="primary" @click="createVisible = true">新增角色</el-button>
      </div>

      <div class="access-grid">
        <aside class="access-list">
          <button
            v-for="role in roles"
            :key="role.code"
            type="button"
            class="access-item"
            :class="{ active: role.code === selectedRoleCode }"
            @click="selectRole(role)"
          >
            <span>
              <strong>{{ role.name }}</strong>
              <em>{{ role.code }}</em>
            </span>
            <el-tag size="small" :type="role.is_system ? 'info' : 'success'">
              {{ role.is_system ? '系统' : '自定义' }}
            </el-tag>
          </button>
        </aside>

        <main class="access-detail">
          <div v-if="selectedRole" class="detail-head">
            <div>
              <h3>{{ selectedRole.name }}</h3>
              <p>{{ selectedRole.description || '未填写描述' }}</p>
            </div>
            <el-button type="primary" :loading="savingRole" @click="saveSelectedRole">保存权限</el-button>
          </div>

          <div v-if="selectedRole" class="permission-groups">
            <section v-for="group in groupedPermissions" :key="group.category" class="permission-group">
              <strong>{{ categoryLabel(group.category) }}</strong>
              <el-checkbox-group v-model="rolePermissionDraft">
                <el-checkbox
                  v-for="permission in group.items"
                  :key="permission.code"
                  :label="permission.code"
                  class="permission-check"
                >
                  <span>{{ permission.name }}</span>
                  <em>{{ permission.code }}</em>
                </el-checkbox>
              </el-checkbox-group>
            </section>
          </div>

          <div v-else class="empty-state">请选择一个角色</div>
        </main>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title access-title">
        <span class="title-text"><span class="panel-icon">◎</span> 授权对象</span>
        <div class="operator-create">
          <el-input v-model="operatorForm.id" size="small" placeholder="SSO 身份 ID / 用户名" />
          <el-input v-model="operatorForm.name" size="small" placeholder="显示名" />
          <el-button size="small" @click="selectManualOperator">选择</el-button>
        </div>
      </div>

      <div class="access-grid operator-grid">
        <aside class="access-list">
          <el-input
            v-model="operatorSearch"
            clearable
            placeholder="搜索授权对象"
            @input="loadOperators"
          />
          <button
            v-for="item in operators"
            :key="item.operator.id"
            type="button"
            class="access-item"
            :class="{ active: item.operator.id === selectedOperatorId }"
            @click="selectOperator(item)"
          >
            <span>
              <strong>{{ item.operator.display_name || item.operator.username || item.operator.id }}</strong>
              <em>{{ item.operator.id }}</em>
            </span>
            <el-tag size="small">{{ item.roles.length }}</el-tag>
          </button>
        </aside>

        <main class="access-detail">
          <div v-if="selectedOperatorId" class="detail-head">
            <div>
              <h3>{{ selectedOperatorName }}</h3>
              <p>{{ selectedOperatorId }}</p>
            </div>
            <el-button type="primary" :loading="savingOperator" @click="saveOperator">保存授权</el-button>
          </div>

          <div v-if="selectedOperatorId" class="operator-editor">
            <div class="editor-row">
              <strong>角色</strong>
              <el-checkbox-group v-model="operatorDraft.roles">
                <el-checkbox v-for="role in roles" :key="role.code" :label="role.code">
                  {{ role.name }}
                </el-checkbox>
              </el-checkbox-group>
            </div>

            <div class="editor-row portal-row">
              <strong>允许访问页面</strong>
              <el-checkbox v-model="operatorDraft.portal_access.can_monitor">监控系统</el-checkbox>
              <el-checkbox v-model="operatorDraft.portal_access.can_workbench">客服工作台</el-checkbox>
              <el-checkbox v-model="operatorDraft.portal_access.can_admin">权限配置</el-checkbox>
              <el-select v-model="operatorDraft.portal_access.default_entry" size="small" class="default-entry-select">
                <el-option label="自动判断" value="auto" />
                <el-option label="显示选择页" value="chooser" />
                <el-option label="默认进监控系统" value="monitor" />
                <el-option label="默认进工作台" value="workbench" />
                <el-option label="默认进权限配置" value="admin" />
              </el-select>
            </div>

            <div class="editor-row">
              <strong>有效权限</strong>
              <div class="permission-chip-list">
                <el-tag v-for="permission in operatorEffectivePermissions" :key="permission" effect="plain">
                  {{ permission }}
                </el-tag>
              </div>
            </div>
          </div>

          <div v-else class="empty-state">请选择或输入一个授权对象</div>
        </main>
      </div>
    </section>

    <el-dialog v-model="createVisible" title="新增自定义角色" width="520px">
      <el-form label-position="top">
        <el-form-item label="角色编码">
          <el-input v-model="createForm.code" placeholder="例如 regional_manager" />
        </el-form-item>
        <el-form-item label="角色名称">
          <el-input v-model="createForm.name" placeholder="例如 区域主管" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="createForm.description" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creatingRole" @click="createRole">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createAccessRole,
  getAccessOperators,
  getAccessPermissions,
  getAccessRoles,
  saveAccessOperator,
  saveRolePermissions
} from '@/api/accessControl'

const roles = ref([])
const permissions = ref([])
const operators = ref([])
const selectedRoleCode = ref('')
const rolePermissionDraft = ref([])
const operatorSearch = ref('')
const selectedOperatorId = ref('')
const selectedOperatorName = ref('')
const operatorEffectivePermissions = ref([])
const savingRole = ref(false)
const savingOperator = ref(false)
const creatingRole = ref(false)
const createVisible = ref(false)

const operatorForm = reactive({ id: '', name: '' })
const createForm = reactive({ code: '', name: '', description: '' })
const operatorDraft = reactive({
  roles: [],
  portal_access: {
    can_monitor: false,
    can_workbench: false,
    can_admin: false,
    default_entry: 'auto'
  }
})

const selectedRole = computed(() => roles.value.find((role) => role.code === selectedRoleCode.value) || null)

const groupedPermissions = computed(() => {
  const groups = new Map()
  permissions.value.forEach((permission) => {
    if (!groups.has(permission.category)) groups.set(permission.category, [])
    groups.get(permission.category).push(permission)
  })
  return [...groups.entries()].map(([category, items]) => ({ category, items }))
})

onMounted(async () => {
  await Promise.all([loadRoles(), loadPermissions(), loadOperators()])
})

async function loadRoles() {
  const res = await getAccessRoles()
  roles.value = res.data || []
  if (!selectedRoleCode.value && roles.value.length) selectRole(roles.value[0])
}

async function loadPermissions() {
  const res = await getAccessPermissions()
  permissions.value = res.data || []
}

async function loadOperators() {
  const res = await getAccessOperators({ search: operatorSearch.value || undefined })
  operators.value = res.data || []
}

function selectRole(role) {
  selectedRoleCode.value = role.code
  rolePermissionDraft.value = [...(role.permissions || [])]
}

async function saveSelectedRole() {
  if (!selectedRole.value) return
  savingRole.value = true
  try {
    await saveRolePermissions(selectedRole.value.code, rolePermissionDraft.value)
    ElMessage.success('角色权限已保存')
    await loadRoles()
  } finally {
    savingRole.value = false
  }
}

async function createRole() {
  creatingRole.value = true
  try {
    const res = await createAccessRole({
      code: createForm.code,
      name: createForm.name,
      description: createForm.description
    })
    ElMessage.success('角色已创建')
    createVisible.value = false
    createForm.code = ''
    createForm.name = ''
    createForm.description = ''
    await loadRoles()
    if (res.data?.code) selectRole(roles.value.find((role) => role.code === res.data.code) || roles.value[0])
  } finally {
    creatingRole.value = false
  }
}

function selectManualOperator() {
  const id = operatorForm.id.trim()
  if (!id) {
    ElMessage.warning('请输入授权对象 ID')
    return
  }
  selectedOperatorId.value = id
  selectedOperatorName.value = operatorForm.name.trim() || id
  operatorDraft.roles = []
  operatorDraft.portal_access = {
    can_monitor: false,
    can_workbench: false,
    can_admin: false,
    default_entry: 'auto'
  }
  operatorEffectivePermissions.value = []
}

function selectOperator(item) {
  selectedOperatorId.value = item.operator.id
  selectedOperatorName.value = item.operator.display_name || item.operator.username || item.operator.id
  operatorDraft.roles = [...(item.roles || [])]
  operatorDraft.portal_access = {
    can_monitor: Boolean(item.portal_access?.can_monitor),
    can_workbench: Boolean(item.portal_access?.can_workbench),
    can_admin: Boolean(item.portal_access?.can_admin),
    default_entry: item.portal_access?.default_entry || 'auto'
  }
  operatorEffectivePermissions.value = item.permissions || []
}

async function saveOperator() {
  if (!selectedOperatorId.value) return
  savingOperator.value = true
  try {
    const res = await saveAccessOperator(selectedOperatorId.value, {
      display_name: selectedOperatorName.value,
      roles: operatorDraft.roles,
      portal_access: operatorDraft.portal_access
    })
    ElMessage.success('授权已保存')
    operatorEffectivePermissions.value = res.data?.permissions || []
    await loadOperators()
  } finally {
    savingOperator.value = false
  }
}

function categoryLabel(category) {
  return {
    monitor: '监控系统',
    workbench: '客服工作台',
    admin: '权限配置'
  }[category] || category
}
</script>

<style scoped>
.role-management {
  padding: 20px;
}

.access-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.access-grid {
  display: grid;
  grid-template-columns: minmax(220px, 280px) 1fr;
  gap: 16px;
}

.operator-grid {
  align-items: start;
}

.access-list,
.access-detail {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  padding: 14px;
}

.access-list {
  display: grid;
  align-content: start;
  gap: 10px;
}

.access-item {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px;
  text-align: left;
  cursor: pointer;
}

.access-item.active {
  border-color: #0f766e;
  background: #ecfdf5;
}

.access-item strong,
.detail-head h3 {
  color: var(--t1);
}

.access-item em,
.detail-head p,
.permission-check em {
  color: var(--t3);
  font-style: normal;
  font-size: 12px;
}

.detail-head,
.operator-create {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.operator-create {
  width: min(560px, 100%);
}

.permission-groups,
.operator-editor {
  display: grid;
  gap: 16px;
}

.permission-group,
.editor-row {
  border-top: 1px solid var(--border);
  padding-top: 14px;
}

.permission-check {
  display: flex;
  width: 100%;
  min-height: 34px;
}

.permission-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.portal-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.default-entry-select {
  width: 180px;
}

@media (max-width: 1000px) {
  .access-grid {
    grid-template-columns: 1fr;
  }

  .operator-create {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
