<template>
  <main class="permission-page" :aria-busy="loading ? 'true' : 'false'">
    <header class="permission-header">
      <div>
        <h1>权限管理</h1>
        <p>工作台坐席身份、角色权限与服务账号范围</p>
      </div>
      <div class="permission-header-actions">
        <el-button @click="$emit('back')">返回工作台</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </header>

    <section v-if="loading && !users.length" class="permission-initial-loading" role="status" aria-live="polite">
      <span class="permission-loading-spinner" aria-hidden="true"></span>
      <div>
        <strong>正在打开权限管理</strong>
        <p>正在读取坐席、角色和服务账号范围…</p>
      </div>
      <div class="permission-loading-skeleton" aria-hidden="true">
        <span></span><span></span>
      </div>
    </section>

    <section v-else class="permission-layout">
      <aside class="permission-users">
        <div class="permission-users-head">
          <div>
            <div class="permission-section-title">工作台坐席</div>
            <strong>{{ users.length }}</strong>
          </div>
          <span>{{ activeUserCount }} 启用</span>
        </div>
        <button
          v-for="user in users"
          :key="user.id"
          type="button"
          class="permission-user"
          :class="{ active: selectedUser && selectedUser.id === user.id }"
          @click="selectUser(user.id)"
        >
          <span class="permission-user-avatar">{{ initialOf(user) }}</span>
          <span class="permission-user-main">
            <strong>{{ user.display_name || user.username }}</strong>
            <span>{{ user.username }} · {{ roleLabel(user.roles) }}</span>
          </span>
          <span class="permission-user-status" :class="{ disabled: user.status !== 'active' }">
            {{ user.status === 'active' ? '启用' : '停用' }}
          </span>
        </button>

        <el-divider />

        <div class="permission-section-title">新增工作台坐席</div>
        <el-form label-position="top" class="permission-create-form">
          <el-form-item label="工作台账号/工号">
            <el-input v-model.trim="createForm.username" placeholder="例如 1469 或 support01" />
          </el-form-item>
          <el-form-item label="显示名">
            <el-input v-model.trim="createForm.display_name" placeholder="坐席姓名" />
          </el-form-item>
          <el-button type="primary" :icon="Plus" :loading="saving" @click="createUser">添加坐席</el-button>
        </el-form>
      </aside>

      <section v-if="selectedUser" class="permission-detail">
        <div class="permission-block permission-profile-block">
          <div class="permission-block-head">
            <div class="permission-profile-title">
              <span class="permission-detail-avatar">{{ initialOf(selectedUser) }}</span>
              <div>
                <h2>{{ selectedUser.display_name || selectedUser.username }}</h2>
                <span>{{ selectedUser.username }} · ID {{ selectedUser.id }}</span>
              </div>
            </div>
            <div class="permission-profile-actions">
              <el-button
                type="primary"
                :loading="saving"
                :disabled="!hasAccountChanges"
                @click="saveCurrentUser"
              >
                保存当前账户
              </el-button>
              <el-tag :type="selectedUser.status === 'active' ? 'success' : 'info'">
                {{ selectedUser.status === 'active' ? '启用' : '停用' }}
              </el-tag>
              <el-button
                type="danger"
                plain
                :icon="Delete"
                :disabled="!canDeleteSelectedUser"
                :loading="saving"
                @click="confirmDeleteUser"
              >
                删除坐席
              </el-button>
            </div>
          </div>

          <div class="permission-meta-strip">
            <span>角色：{{ selectedRoleText }}</span>
            <span>默认入口：工作台</span>
            <span>范围：{{ scopeDraft.length }}</span>
          </div>

          <el-form class="permission-profile" label-position="top">
            <el-form-item label="显示名">
              <el-input v-model="selectedUser.display_name" />
            </el-form-item>
            <el-form-item label="账号状态">
              <el-segmented v-model="selectedUser.status" :options="statusOptions" />
            </el-form-item>
          </el-form>
        </div>

        <div class="permission-block">
          <div class="permission-block-head">
            <div>
              <h2>角色</h2>
              <span>角色自动决定可访问页面，登录后默认进入工作台</span>
            </div>
          </div>
          <el-checkbox-group v-model="roleDraft" class="role-checks">
            <el-checkbox
              v-for="role in roles"
              :key="role.code"
              :value="role.code"
              border
            >
              {{ role.name }}
            </el-checkbox>
          </el-checkbox-group>
        </div>

        <div class="permission-block">
          <div class="permission-block-head">
            <div>
              <h2>服务账号与分组范围</h2>
              <span>按平台、服务账号和分组配置查看/回复/分配/管理</span>
            </div>
            <div>
              <el-button :icon="Plus" @click="addScope">添加范围</el-button>
            </div>
          </div>

          <div v-if="!scopeDraft.length" class="empty-permission-state">暂无范围，添加后该账号才会看到会话。</div>
          <div v-else class="scope-row scope-row-head">
            <span>平台</span>
            <span>服务账号</span>
            <span>分组</span>
            <span>查看</span>
            <span>回复</span>
            <span>分配</span>
            <span>管理</span>
            <span></span>
          </div>
          <div v-for="(scope, index) in scopeDraft" :key="scope.local_id" class="scope-row">
            <el-select v-model="scope.platform" placeholder="平台" @change="scope.service_account = ''; scope.native_group_id = '*'">
              <el-option label="WA" value="wa" />
              <el-option label="TG" value="tg" />
            </el-select>
            <el-select v-model="scope.service_account" placeholder="服务账号" @change="scope.native_group_id = '*'">
              <el-option
                v-for="account in accountsForPlatform(scope.platform)"
                :key="`${account.platform}:${account.account}`"
                :label="account.account_display_name || account.account"
                :value="account.account"
              />
            </el-select>
            <el-select v-model="scope.native_group_id" placeholder="分组">
              <el-option
                v-for="group in groupOptions(scope)"
                :key="group.native_group_id"
                :label="group.name"
                :value="group.native_group_id"
              />
            </el-select>
            <el-checkbox v-model="scope.can_view">看</el-checkbox>
            <el-checkbox v-model="scope.can_reply">回</el-checkbox>
            <el-checkbox v-model="scope.can_assign">分</el-checkbox>
            <el-checkbox v-model="scope.can_manage">管</el-checkbox>
            <el-button text type="danger" :icon="Delete" @click="scopeDraft.splice(index, 1)">删除</el-button>
          </div>
        </div>

        <div class="permission-block">
          <div class="permission-block-head">
            <div>
              <h2>角色权限项</h2>
              <span>全局配置，调整后会影响所有使用该角色的账户</span>
            </div>
            <el-button
              type="primary"
              plain
              :loading="savingRolePermissions"
              :disabled="!hasRolePermissionChanges"
              @click="saveRolePermissionChanges"
            >
              保存角色权限
            </el-button>
          </div>
          <el-collapse>
            <el-collapse-item v-for="role in roles" :key="role.code" :title="`${role.name} · ${role.code}`" :name="role.code">
              <el-checkbox-group v-model="rolePermissionDraft[role.code]" class="permission-checks">
                <el-checkbox
                  v-for="permission in permissions"
                  :key="permission.code"
                  :value="permission.code"
                  border
                >
                  {{ permission.name }}
                </el-checkbox>
              </el-checkbox-group>
            </el-collapse-item>
          </el-collapse>
        </div>
      </section>

      <section v-else class="permission-detail empty-permission-state">
        请选择一个坐席。
      </section>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import ElMessage from 'element-plus/es/components/message/index.mjs';
import ElMessageBox from 'element-plus/es/components/message-box/index.mjs';
import { Delete, Plus, Refresh } from '@element-plus/icons-vue';
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminAccess,
  saveAdminUserAccess,
  saveRolePermissions,
} from '../api';

defineEmits(['back']);

const loading = ref(false);
const saving = ref(false);
const savingRolePermissions = ref(false);
const access = ref({ users: [], roles: [], permissions: [], accounts: [], service_groups: [], scope_special_groups: [] });
const selectedUserId = ref('');
const roleDraft = ref([]);
const scopeDraft = ref([]);
const rolePermissionDraft = reactive({});
const accountBaseline = ref(null);
const rolePermissionBaseline = ref({});
const createForm = reactive({
  username: '',
  display_name: '',
});

const statusOptions = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'disabled' },
];

const users = computed(() => access.value.users || []);
const roles = computed(() => access.value.roles || []);
const permissions = computed(() => access.value.permissions || []);
const selectedUser = computed(() => users.value.find((user) => user.id === selectedUserId.value) || null);
const activeUserCount = computed(() => users.value.filter((user) => user.status === 'active').length);
const selectedRoleText = computed(() => roleLabel(roleDraft.value));
const canDeleteSelectedUser = computed(() => selectedUser.value && !selectedUser.value.is_super_admin);
const hasAccountChanges = computed(() => {
  if (!selectedUser.value || !accountBaseline.value) return false;
  return JSON.stringify(normalizeAccountPayload(currentAccountPayload())) !== JSON.stringify(accountBaseline.value);
});
const hasRolePermissionChanges = computed(() => (
  JSON.stringify(rolePermissionSnapshot()) !== JSON.stringify(rolePermissionBaseline.value)
));

onMounted(load);

watch(selectedUser, (user) => {
  if (!user) return;
  hydrateAccountDrafts(user);
}, { immediate: true });

async function load() {
  loading.value = true;
  try {
    access.value = await fetchAdminAccess();
    hydrateRolePermissionDrafts();
    if (!users.value.some((user) => user.id === selectedUserId.value)) {
      selectedUserId.value = users.value[0]?.id || '';
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '无法加载权限管理');
  } finally {
    loading.value = false;
  }
}

async function createUser() {
  if (!createForm.username) {
    ElMessage.warning('请输入工作台账号或工号');
    return;
  }
  saving.value = true;
  try {
    const result = await createAdminUser({
      username: createForm.username,
      display_name: createForm.display_name || createForm.username,
      roles: ['agent'],
      role: 'agent',
    });
    createForm.username = '';
    createForm.display_name = '';
    access.value = result.access || access.value;
    selectedUserId.value = result.user?.id || selectedUserId.value;
    ElMessage.success('坐席已添加');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '添加坐席失败');
  } finally {
    saving.value = false;
  }
}

async function confirmDeleteUser() {
  if (!selectedUser.value || !canDeleteSelectedUser.value) return;
  const user = selectedUser.value;
  try {
    await ElMessageBox.confirm(
      `确定删除坐席「${user.display_name || user.username}」吗？`,
      '删除坐席',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger',
      },
    );
  } catch (_) {
    return;
  }

  saving.value = true;
  try {
    const result = await deleteAdminUser(user.id);
    access.value = result.access || access.value;
    selectedUserId.value = access.value.users?.[0]?.id || '';
    ElMessage.success('坐席已删除');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '删除坐席失败');
  } finally {
    saving.value = false;
  }
}

async function addScope() {
  if (!access.value.accounts?.length) await refreshScopeOptions();
  const account = access.value.accounts?.[0];
  if (!account) {
    ElMessage.warning('暂无可授权的服务账号，请先完成服务账号接入后刷新权限管理');
    return;
  }
  scopeDraft.value = [...scopeDraft.value, {
    local_id: `${Date.now()}-${Math.random()}`,
    platform: account.platform,
    service_account: account.account,
    native_group_id: '*',
    can_view: true,
    can_reply: true,
    can_assign: false,
    can_manage: false,
  }];
}

async function refreshScopeOptions() {
  try {
    const refreshed = await fetchAdminAccess();
    access.value.accounts = refreshed.accounts || [];
    access.value.service_groups = refreshed.service_groups || [];
    access.value.scope_special_groups = refreshed.scope_special_groups || [];
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '刷新服务账号失败');
  }
}

async function selectUser(userId) {
  if (!userId || userId === selectedUserId.value || saving.value) return;
  if (hasAccountChanges.value) {
    try {
      await ElMessageBox.confirm(
        '当前账户存在未保存修改，切换账户后这些修改将丢失。',
        '切换账户',
        {
          confirmButtonText: '放弃修改并切换',
          cancelButtonText: '继续编辑',
          type: 'warning',
        },
      );
    } catch (_) {
      return;
    }
    restoreAccountBaseline();
  }
  selectedUserId.value = userId;
}

async function saveCurrentUser() {
  if (!selectedUser.value) return;
  if (scopeDraft.value.some((scope) => !scope.platform || !scope.service_account || !scope.native_group_id)) {
    ElMessage.warning('请为每条范围选择平台、服务账号和分组后再保存');
    return;
  }
  const userId = selectedUser.value.id;
  saving.value = true;
  try {
    const result = await saveAdminUserAccess(userId, {
      profile: {
        display_name: selectedUser.value.display_name,
        status: selectedUser.value.status,
        role: selectedUser.value.role,
      },
      roles: [...roleDraft.value],
      scopes: scopeDraft.value.map(({ local_id, ...scope }) => scope),
    });
    access.value = result.access || access.value;
    selectedUserId.value = userId;
    hydrateAccountDrafts(users.value.find((user) => user.id === userId));
    ElMessage.success('当前账户已保存');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '保存当前账户失败');
  } finally {
    saving.value = false;
  }
}

async function saveRolePermissionChanges() {
  const changedRoles = roles.value.filter((role) => (
    JSON.stringify(normalizeCodes(rolePermissionDraft[role.code]))
      !== JSON.stringify(rolePermissionBaseline.value[role.code] || [])
  ));
  if (!changedRoles.length) return;
  savingRolePermissions.value = true;
  try {
    for (const role of changedRoles) {
      const result = await saveRolePermissions(role.code, rolePermissionDraft[role.code] || []);
      const savedRole = result.role || role;
      const roleIndex = access.value.roles.findIndex((item) => item.code === role.code);
      if (roleIndex >= 0) access.value.roles[roleIndex] = savedRole;
      rolePermissionDraft[role.code] = [...(savedRole.permissions || [])];
      rolePermissionBaseline.value = {
        ...rolePermissionBaseline.value,
        [role.code]: normalizeCodes(savedRole.permissions),
      };
    }
    ElMessage.success('角色权限已保存');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '保存角色权限失败');
  } finally {
    savingRolePermissions.value = false;
  }
}

function hydrateAccountDrafts(user) {
  if (!user) {
    accountBaseline.value = null;
    return;
  }
  roleDraft.value = [...(user.roles || [])];
  scopeDraft.value = toScopeDraft(user.scopes);
  accountBaseline.value = normalizeAccountPayload(currentAccountPayload(user));
}

function restoreAccountBaseline() {
  if (!selectedUser.value || !accountBaseline.value) return;
  selectedUser.value.display_name = accountBaseline.value.profile.display_name;
  selectedUser.value.status = accountBaseline.value.profile.status;
  selectedUser.value.role = accountBaseline.value.profile.role;
  roleDraft.value = [...accountBaseline.value.roles];
  scopeDraft.value = toScopeDraft(accountBaseline.value.scopes);
}

function currentAccountPayload(user = selectedUser.value) {
  return {
    profile: {
      display_name: user?.display_name || '',
      status: user?.status || 'active',
      role: user?.role || '',
    },
    roles: [...roleDraft.value],
    scopes: scopeDraft.value.map(({ local_id, ...scope }) => scope),
  };
}

function normalizeAccountPayload(payload = {}) {
  const scopes = (payload.scopes || []).map((scope) => ({
    platform: scope.platform || '',
    service_account: scope.service_account || '',
    native_group_id: scope.native_group_id || '',
    can_view: Boolean(scope.can_view),
    can_reply: Boolean(scope.can_reply),
    can_assign: Boolean(scope.can_assign),
    can_manage: Boolean(scope.can_manage),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    profile: {
      display_name: String(payload.profile?.display_name || ''),
      status: String(payload.profile?.status || 'active'),
      role: String(payload.profile?.role || ''),
    },
    roles: normalizeCodes(payload.roles),
    scopes,
  };
}

function hydrateRolePermissionDrafts() {
  Object.keys(rolePermissionDraft).forEach((code) => delete rolePermissionDraft[code]);
  roles.value.forEach((role) => {
    rolePermissionDraft[role.code] = [...(role.permissions || [])];
  });
  rolePermissionBaseline.value = rolePermissionSnapshot();
}

function rolePermissionSnapshot() {
  return Object.fromEntries(roles.value
    .map((role) => [role.code, normalizeCodes(rolePermissionDraft[role.code])])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeCodes(codes = []) {
  return [...new Set(codes || [])].sort();
}

function toScopeDraft(scopes = []) {
  return scopes.map((scope) => ({
    ...scope,
    local_id: `${Date.now()}-${Math.random()}`,
  }));
}

function accountsForPlatform(platform) {
  return (access.value.accounts || []).filter((account) => account.platform === platform);
}

function groupOptions(scope) {
  const specials = access.value.scope_special_groups || [];
  const groups = (access.value.service_groups || []).filter((group) => (
    group.platform === scope.platform && group.service_account === scope.service_account
  ));
  return [...specials, ...groups];
}

function roleLabel(roleCodes = []) {
  if (!roleCodes.length) return '未分配角色';
  const roleMap = new Map(roles.value.map((role) => [role.code, role.name]));
  return roleCodes.map((code) => roleMap.get(code) || code).join('、');
}

function initialOf(user = {}) {
  const text = String(user.display_name || user.username || user.id || '?').trim();
  return text.slice(0, 1).toUpperCase();
}

</script>
