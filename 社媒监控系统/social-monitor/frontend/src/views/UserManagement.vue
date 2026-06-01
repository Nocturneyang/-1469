<template>
  <div class="user-management">
    <div class="panel">
      <div class="panel-title">🔐 钉钉 SSO 管理员</div>
      <p style="font-size:13px;color:var(--t3);margin-bottom:18px;line-height:1.7">
        钉钉登录用户默认是游客。把姓名、工号、邮箱或手机号加入此列表后，匹配到的钉钉账号会获得管理员权限。
      </p>

      <div class="sso-form">
        <el-input v-model="ssoAdminForm.identity" placeholder="身份标识，如：杨杰 / 工号 / 邮箱 / 手机号" />
        <el-input v-model="ssoAdminForm.display_name" placeholder="显示名称，可选" />
        <el-input v-model="ssoAdminForm.note" placeholder="备注，可选" />
        <el-button type="primary" @click="handleSaveSsoAdmin">保存管理员</el-button>
      </div>

      <el-table :data="ssoAdmins" style="width:100%;margin-top:16px">
        <el-table-column prop="identity" label="匹配标识" min-width="180" />
        <el-table-column prop="display_name" label="显示名称" min-width="140" />
        <el-table-column prop="note" label="备注" min-width="180" />
        <el-table-column prop="updated_at" label="更新时间" width="180" />
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button size="small" type="danger" @click="handleDeleteSsoAdmin(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="panel">
      <div class="panel-title">👥 本地账号管理</div>
      <p style="font-size:13px;color:var(--t3);margin-bottom:24px">保留给非 SSO 环境使用；生产钉钉登录主要使用上方 SSO 管理员列表控制权限。</p>

      <el-button type="primary" @click="openCreateModal" style="margin-bottom:16px">
        + 新增用户
      </el-button>

      <el-table :data="users" style="width:100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="username" label="用户名" width="150" />
        <el-table-column prop="role" label="角色" width="120">
          <template #default="{ row }">
            <el-tag :type="row.role === 'admin' ? 'danger' : 'success'" size="small">
              {{ row.role === 'admin' ? '管理员' : '游客' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="180" />
        <el-table-column prop="last_login" label="最后登录" width="180" />
        <el-table-column label="操作" width="300">
          <template #default="{ row }">
            <el-button size="small" @click="openPasswordModal(row)">修改密码</el-button>
            <el-button size="small" @click="openRoleModal(row)" :disabled="row.username === 'admin' || row.username === 'view'">修改角色</el-button>
            <el-button size="small" type="danger" @click="handleDelete(row)" :disabled="row.username === 'admin' || row.username === 'view'">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 创建用户弹窗 -->
    <el-dialog v-model="createModalVisible" title="新增用户" width="400px">
      <el-form :model="createForm" :rules="createRules" ref="createFormRef">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="createForm.username" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="createForm.password" type="password" placeholder="请输入密码" show-password />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="createForm.role" placeholder="请选择角色" style="width:100%">
            <el-option label="管理员" value="admin" />
            <el-option label="游客" value="view" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createModalVisible = false">取消</el-button>
        <el-button type="primary" @click="handleCreate">确定</el-button>
      </template>
    </el-dialog>

    <!-- 修改密码弹窗 -->
    <el-dialog v-model="passwordModalVisible" title="修改密码" width="400px">
      <el-form :model="passwordForm" :rules="passwordRules" ref="passwordFormRef">
        <el-form-item label="新密码" prop="password">
          <el-input v-model="passwordForm.password" type="password" placeholder="请输入新密码" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="passwordModalVisible = false">取消</el-button>
        <el-button type="primary" @click="handleUpdatePassword">确定</el-button>
      </template>
    </el-dialog>

    <!-- 修改角色弹窗 -->
    <el-dialog v-model="roleModalVisible" title="修改角色" width="400px">
      <el-form :model="roleForm" ref="roleFormRef">
        <el-form-item label="角色">
          <el-select v-model="roleForm.role" placeholder="请选择角色" style="width:100%">
            <el-option label="管理员" value="admin" />
            <el-option label="游客" value="view" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="roleModalVisible = false">取消</el-button>
        <el-button type="primary" @click="handleUpdateRole">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/utils/request'

const users = ref([])
const ssoAdmins = ref([])
const createModalVisible = ref(false)
const passwordModalVisible = ref(false)
const roleModalVisible = ref(false)
const createFormRef = ref(null)
const passwordFormRef = ref(null)
const roleFormRef = ref(null)
const currentUser = ref(null)

const createForm = reactive({
  username: '',
  password: '',
  role: 'view'
})

const ssoAdminForm = reactive({
  identity: '',
  display_name: '',
  note: ''
})

const passwordForm = reactive({
  password: ''
})

const roleForm = reactive({
  role: ''
})

const createRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }]
}

const passwordRules = {
  password: [{ required: true, message: '请输入新密码', trigger: 'blur' }]
}

const fetchUsers = async () => {
  try {
    const res = await api.get('/api/auth/users')
    if (res.success) {
      users.value = res.data || []
    }
  } catch (err) {
    ElMessage.error('获取用户列表失败')
  }
}

const fetchSsoAdmins = async () => {
  try {
    const res = await api.get('/api/auth/sso-admins')
    if (res.success) {
      ssoAdmins.value = res.data || []
    }
  } catch (err) {
    ElMessage.error('获取钉钉管理员失败')
  }
}

const handleSaveSsoAdmin = async () => {
  if (!ssoAdminForm.identity.trim()) {
    ElMessage.warning('请输入身份标识')
    return
  }

  try {
    const res = await api.post('/api/auth/sso-admins', ssoAdminForm)
    if (res.success) {
      ElMessage.success(res.message || '保存成功')
      ssoAdminForm.identity = ''
      ssoAdminForm.display_name = ''
      ssoAdminForm.note = ''
      fetchSsoAdmins()
    }
  } catch (err) {
    ElMessage.error('保存钉钉管理员失败')
  }
}

const handleDeleteSsoAdmin = async (item) => {
  try {
    await ElMessageBox.confirm(`确定移除「${item.display_name || item.identity}」的管理员权限吗？`, '确认移除', { type: 'warning' })
    const res = await api.delete(`/api/auth/sso-admins/${item.id}`)
    if (res.success) {
      ElMessage.success(res.message || '已移除')
      fetchSsoAdmins()
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('移除钉钉管理员失败')
  }
}

const openCreateModal = () => {
  createForm.username = ''
  createForm.password = ''
  createForm.role = 'view'
  createModalVisible.value = true
}

const handleCreate = async () => {
  if (!createFormRef.value) return
  await createFormRef.value.validate(async (valid) => {
    if (valid) {
      try {
        const res = await api.post('/api/auth/users', createForm)
        if (res.success) {
          ElMessage.success(res.message || '用户创建成功')
          createModalVisible.value = false
          fetchUsers()
        }
      } catch (err) {
        ElMessage.error('用户创建失败')
      }
    }
  })
}

const openPasswordModal = (user) => {
  currentUser.value = user
  passwordForm.password = ''
  passwordModalVisible.value = true
}

const handleUpdatePassword = async () => {
  if (!passwordFormRef.value) return
  await passwordFormRef.value.validate(async (valid) => {
    if (valid) {
      try {
        const res = await api.put(`/api/auth/users/${currentUser.value.id}/password`, passwordForm)
        if (res.success) {
          ElMessage.success(res.message || '密码修改成功')
          passwordModalVisible.value = false
        }
      } catch (err) {
        ElMessage.error('密码修改失败')
      }
    }
  })
}

const openRoleModal = (user) => {
  currentUser.value = user
  roleForm.role = user.role
  roleModalVisible.value = true
}

const handleUpdateRole = async () => {
  try {
    const res = await api.put(`/api/auth/users/${currentUser.value.id}/role`, roleForm)
    if (res.success) {
      ElMessage.success(res.message || '角色修改成功')
      roleModalVisible.value = false
      fetchUsers()
    }
  } catch (err) {
    ElMessage.error('角色修改失败')
  }
}

const handleDelete = async (user) => {
  try {
    await ElMessageBox.confirm(`确定删除用户「${user.username}」吗？`, '警告', { type: 'warning' })
    const res = await api.delete(`/api/auth/users/${user.id}`)
    if (res.success) {
      ElMessage.success(res.message || '用户删除成功')
      fetchUsers()
    }
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('用户删除失败')
  }
}

onMounted(() => {
  fetchUsers()
  fetchSsoAdmins()
})
</script>

<style scoped>
.user-management {
  padding: 20px;
}

.sso-form {
  display: grid;
  grid-template-columns: minmax(180px, 1.3fr) minmax(140px, 1fr) minmax(160px, 1fr) auto;
  gap: 12px;
  align-items: center;
}

@media (max-width: 960px) {
  .sso-form {
    grid-template-columns: 1fr;
  }
}
</style>
