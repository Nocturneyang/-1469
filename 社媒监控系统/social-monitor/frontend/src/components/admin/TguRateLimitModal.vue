<template>
  <el-dialog
    v-model="dialogVisible"
    title="频控安全与风控设置"
    width="500px"
    @open="loadRateLimit"
  >
    <div class="mb-4 text-center">当前配置账号: <span class="font-bold">tgu-{{ accountName }}</span></div>
    <el-form label-width="120px" size="small" v-loading="loading">
      <el-form-item label="启用历史回溯">
        <el-switch v-model="rlForm.enable_backfill" />
      </el-form-item>
      <el-form-item label="自动回溯天数">
        <el-input-number v-model="rlForm.backfill_days" :min="0" :max="30" controls-position="right" />
      </el-form-item>
      <el-form-item label="每日拉取上限">
        <el-input-number v-model="rlForm.daily_limit" :min="0" :step="100" controls-position="right" />
      </el-form-item>
      <el-form-item label="登录预热期(秒)">
        <el-input-number v-model="rlForm.warmup_seconds" :min="0" controls-position="right" />
      </el-form-item>
      <el-form-item label="单次拉取批次回溯">
        <el-input-number v-model="rlForm.batch_size" :min="10" :max="100" controls-position="right" />
      </el-form-item>
      <el-form-item label="批次最小休眠(ms)">
        <el-input-number v-model="rlForm.sleep_min_ms" :min="0" :step="1000" controls-position="right" />
      </el-form-item>
      <el-form-item label="批次最大休眠(ms)">
        <el-input-number v-model="rlForm.sleep_max_ms" :min="1000" :step="1000" controls-position="right" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :disabled="loading" :loading="submitting" @click="submitRateLimit">保存配置</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { getTgRateLimit, updateTgRateLimit } from '@/api/accounts'

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

const loading = ref(false)
const submitting = ref(false)

const rlForm = reactive({
  enable_backfill: true,
  backfill_days: 7,
  daily_limit: 500,
  warmup_seconds: 600,
  batch_size: 50,
  sleep_min_ms: 3000,
  sleep_max_ms: 8000
})

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const loadRateLimit = async () => {
  if (!props.accountName) return
  loading.value = true
  try {
    const res = await getTgRateLimit(props.accountName)
    if (res.success && res.data) {
      const c = res.data
      rlForm.enable_backfill = c.enable_backfill
      rlForm.backfill_days = c.backfill_days
      rlForm.daily_limit = c.daily_limit
      rlForm.warmup_seconds = c.warmup_seconds
      rlForm.batch_size = c.batch_size
      rlForm.sleep_min_ms = c.sleep_min_ms
      rlForm.sleep_max_ms = c.sleep_max_ms
    }
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

const submitRateLimit = async () => {
  submitting.value = true
  try {
    const res = await updateTgRateLimit(props.accountName, rlForm)
    if (res.success) {
      ElMessage.success('频控配置已保存！')
      dialogVisible.value = false
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
</style>
