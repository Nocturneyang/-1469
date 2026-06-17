<template>
  <el-dialog
    v-model="dialogVisible"
    title="重新配置监控群聊 (Whitelist)"
    width="500px"
    @open="loadDialogs"
  >
    <div class="mb-4 text-center">当前配置账号: <span class="font-bold">tgu-{{ accountName }}</span></div>
    <el-form label-position="top">
      <el-form-item label="监控范围">
        <el-select v-model="rcMode" class="w-100">
          <el-option label="监听所有群聊 (高风险)" value="all" />
          <el-option label="仅监听指定群聊 (推荐)" value="partial" />
        </el-select>
      </el-form-item>

      <div v-show="rcMode === 'partial'" class="dialog-list-container" v-loading="loading">
        <el-checkbox-group v-model="rcWhitelist">
          <el-checkbox v-for="item in rcDialogs" :key="item.id" :label="item.id" class="dialog-list-item">
            {{ item.title }}
          </el-checkbox>
        </el-checkbox-group>
        <div v-if="!loading && rcDialogs.length === 0" class="empty-text">未发现群组/频道</div>
      </div>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :disabled="loading" :loading="submitting" @click="submitReconfigGroups">保存并重启服务</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getTgUserDialogs,
  updateTgUserWhitelist,
  reloginAccount
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

const emit = defineEmits(['update:modelValue', 'success'])

const loading = ref(false)
const submitting = ref(false)

const rcMode = ref('partial')
const rcDialogs = ref([])
const rcWhitelist = ref([])

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const loadDialogs = async () => {
  if (!props.accountName) return
  loading.value = true
  try {
    const res = await getTgUserDialogs(props.accountName)
    if (res.success) {
      rcDialogs.value = res.data || []
      const wl = res.whitelist
      if (wl === null) {
        rcMode.value = 'all'
        rcWhitelist.value = rcDialogs.value.map(d => d.id)
      } else {
        rcMode.value = 'partial'
        rcWhitelist.value = []
        rcDialogs.value.forEach(d => {
          if (wl.includes(d.id.toString()) || wl.includes('-100' + d.id) || wl.includes(d.id)) {
            rcWhitelist.value.push(d.id)
          }
        })
      }
    } else {
      ElMessage.error(res.error || '获取群组列表失败')
    }
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

const submitReconfigGroups = async () => {
  if (rcMode.value === 'partial' && rcWhitelist.value.length === 0) {
    return ElMessage.warning('请至少选择一个群聊')
  }
  submitting.value = true
  try {
    const res = await updateTgUserWhitelist(props.accountName, {
      mode: rcMode.value,
      whitelist: rcWhitelist.value
    })
    if (res.success) {
      ElMessage.success('配置已保存！后台服务将自动生效')
      dialogVisible.value = false
      // 发送重启/重新登录命令以让配置生效
      await reloginAccount({ id: 'tgu-' + props.accountName })
      emit('success')
    } else {
      ElMessage.error(res.error || '保存配置失败')
    }
  } catch (e) {
    console.error(e)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.mb-4 { margin-bottom: 16px; }
.font-bold { font-weight: bold; }
.text-center { text-align: center; }
.w-100 { width: 100%; }
.dialog-list-container {
  max-height: 250px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: #fff;
}
.dialog-list-item {
  display: block;
  margin-bottom: 6px;
}
.empty-text {
  text-align: center;
  padding: 20px;
  color: var(--t3);
  font-size: 13px;
}
</style>
