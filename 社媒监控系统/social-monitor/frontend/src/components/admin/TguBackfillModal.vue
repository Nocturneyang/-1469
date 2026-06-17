<template>
  <el-dialog
    v-model="dialogVisible"
    title="TG 历史回溯监控"
    width="600px"
    @open="loadBackfillTasks"
  >
    <div class="mb-4 flex-between">
      <span>当前配置账号: <span class="font-bold">tgu-{{ accountName }}</span></span>
      <div>
        <el-button size="small" type="warning" plain :disabled="loading" @click="backfillPauseAll">暂停全部</el-button>
        <el-button size="small" type="success" plain :disabled="loading" @click="backfillResumeAll">恢复全部</el-button>
      </div>
    </div>

    <el-table :data="bfTasks" style="width: 100%" v-loading="loading">
      <el-table-column prop="chat_title" label="群组" show-overflow-tooltip width="200" />
      <el-table-column label="状态" width="100">
        <template #default="scope">
          <el-tag size="small" :type="getBfStatusType(scope.row.status)">
            {{ getBfStatusText(scope.row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="today_count" label="今日下载" align="right" />
      <el-table-column prop="total_count" label="总计" align="right" />
      <el-table-column label="操作" width="80" align="center">
        <template #default="scope">
          <el-button link type="danger" size="small" @click="resetTask(scope.row.chat_id)">重置</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getTgBackfillTasks,
  pauseTgBackfill,
  resumeTgBackfill,
  resetTgBackfillTask
} from '@/api/accounts'

const props = defineProps({
  modelValue: {
    type: Boolean,
    required: true
  },
  accountName: {
    type: String,
    required: true
  }
})

const emit = defineEmits(['update:modelValue'])

const bfTasks = ref([])
const loading = ref(false)

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const loadBackfillTasks = async () => {
  if (!props.accountName) return
  loading.value = true
  try {
    const res = await getTgBackfillTasks(props.accountName)
    if (res.success) {
      bfTasks.value = res.data || []
    }
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

const backfillPauseAll = async () => {
  try {
    const res = await pauseTgBackfill(props.accountName)
    if (res.success) {
      ElMessage.success('已发送暂停指令')
      loadBackfillTasks()
    } else {
      ElMessage.error(res.error || '发送暂停指令失败')
    }
  } catch (e) {
    console.error(e)
  }
}

const backfillResumeAll = async () => {
  try {
    const res = await resumeTgBackfill(props.accountName)
    if (res.success) {
      ElMessage.success('已发送恢复指令')
      loadBackfillTasks()
    } else {
      ElMessage.error(res.error || '发送恢复指令失败')
    }
  } catch (e) {
    console.error(e)
  }
}

const resetTask = async (chatId) => {
  try {
    await ElMessageBox.confirm('确定重置该群的回溯进度？将从头重新拉取', '提示', { type: 'warning' })
    const res = await resetTgBackfillTask(props.accountName, { chat_id: chatId })
    if (res.success) {
      ElMessage.success('已重置回溯进度')
      loadBackfillTasks()
    } else {
      ElMessage.error(res.error || '重置进度失败')
    }
  } catch (e) {}
}

const getBfStatusType = (status) => {
  const m = { pending: 'warning', running: 'success', paused: 'info', completed: 'success', error: 'danger' }
  return m[status] || 'info'
}

const getBfStatusText = (status) => {
  const m = { pending: '待处理', running: '进行中', paused: '已暂停', completed: '已完成', error: '出错' }
  return m[status] || status
}
</script>

<style scoped>
.mb-4 { margin-bottom: 16px; }
.font-bold { font-weight: bold; }
.flex-between { display: flex; justify-content: space-between; align-items: center; }
</style>
