<template>
  <div class="permission-management">
    <section class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">☷</span> 权限项管理</span>
      </div>
      <p class="permission-note">
        权限项是系统可执行动作的稳定字典。当前版本由代码内置并随发布迁移，角色页负责把权限项组合成业务角色。
      </p>

      <el-table :data="permissions" style="width:100%" row-key="code">
        <el-table-column prop="category" label="模块" width="130">
          <template #default="{ row }">
            <el-tag effect="plain">{{ categoryLabel(row.category) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="权限名称" min-width="160" />
        <el-table-column prop="code" label="权限编码" min-width="180">
          <template #default="{ row }">
            <code>{{ row.code }}</code>
          </template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="280" />
        <el-table-column prop="updated_at" label="更新时间" width="180" />
      </el-table>
    </section>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { getAccessPermissions } from '@/api/accessControl'

const permissions = ref([])

onMounted(async () => {
  const res = await getAccessPermissions()
  permissions.value = res.data || []
})

function categoryLabel(category) {
  return {
    monitor: '监控系统',
    workbench: '客服工作台',
    admin: '权限配置'
  }[category] || category
}
</script>

<style scoped>
.permission-management {
  padding: 20px;
}

.permission-note {
  margin: 0 0 18px;
  color: var(--t3);
  font-size: 13px;
  line-height: 1.7;
}
</style>
