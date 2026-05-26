<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">📋</span> 系统日志</span>
        <button class="btn-primary" :disabled="loading" @click="refreshAll">刷新日志</button>
      </div>

      <div class="toolbar">
        <label>
          <span>服务</span>
          <select v-model="selectedProcess" class="field-input" @change="fetchLogs">
            <option v-for="item in processes" :key="item.name" :value="item.name">
              {{ item.name }} · {{ item.status }}
            </option>
          </select>
        </label>
        <label>
          <span>类型</span>
          <select v-model="logType" class="field-input" @change="fetchLogs">
            <option value="out">运行日志</option>
            <option value="error">错误日志</option>
          </select>
        </label>
        <label>
          <span>行数</span>
          <select v-model="lineCount" class="field-input" @change="fetchLogs">
            <option :value="100">100</option>
            <option :value="200">200</option>
            <option :value="500">500</option>
            <option :value="1000">1000</option>
          </select>
        </label>
        <label>
          <span>关键词</span>
          <input v-model="keyword" class="field-input" placeholder="error / daily / AI" @keyup.enter="fetchLogs" />
        </label>
        <button class="btn-secondary" :disabled="loading" @click="fetchLogs">查询</button>
      </div>

      <div v-if="selectedMeta" class="meta-grid">
        <div><strong>状态</strong><span :class="['status-dot', selectedMeta.status]">{{ selectedMeta.status }}</span></div>
        <div><strong>重启次数</strong><span>{{ selectedMeta.restartCount }}</span></div>
        <div><strong>CPU</strong><span>{{ selectedMeta.cpu }}%</span></div>
        <div><strong>内存</strong><span>{{ formatMemory(selectedMeta.memory) }}</span></div>
      </div>

      <div v-if="loading" class="empty-state loading-pulse">正在读取日志...</div>
      <div v-else-if="!processes.length" class="empty-state">未发现 PM2 进程</div>
      <div v-else class="log-box">
        <div class="log-header">
          <span>{{ selectedProcess || '-' }} / {{ logType === 'error' ? '错误日志' : '运行日志' }}</span>
          <span>{{ logLines.length }} 行</span>
        </div>
        <pre v-if="logLines.length">{{ logLines.join('\n') }}</pre>
        <div v-else class="empty-state">暂无日志内容</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/utils/request'

const loading = ref(false)
const processes = ref([])
const selectedProcess = ref('')
const logType = ref('error')
const lineCount = ref(200)
const keyword = ref('')
const logLines = ref([])

const selectedMeta = computed(() => processes.value.find((item) => item.name === selectedProcess.value))

const formatMemory = (value) => {
  if (!value) return '0 MB'
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

const fetchProcesses = async () => {
  const res = await api.get('/api/logs/processes')
  if (res.success) {
    processes.value = res.data || []
    if (!selectedProcess.value && processes.value.length) {
      const preferred = processes.value.find((item) => item.name === 'ui-server') || processes.value[0]
      selectedProcess.value = preferred.name
    }
  }
}

const fetchLogs = async () => {
  if (!selectedProcess.value) return
  loading.value = true
  try {
    const res = await api.get(`/api/logs/${encodeURIComponent(selectedProcess.value)}`, {
      params: { type: logType.value, lines: lineCount.value, keyword: keyword.value }
    })
    if (res.success) {
      logLines.value = res.data?.lines || []
    } else {
      ElMessage.error(res.error || '读取日志失败')
    }
  } catch (e) {
    ElMessage.error('读取日志失败')
  } finally {
    loading.value = false
  }
}

const refreshAll = async () => {
  loading.value = true
  try {
    await fetchProcesses()
    await fetchLogs()
  } finally {
    loading.value = false
  }
}

onMounted(refreshAll)
</script>

<style scoped>
.toolbar {
  display: grid;
  grid-template-columns: 1.4fr 0.8fr 0.6fr 1fr auto;
  gap: 12px;
  align-items: end;
  margin-bottom: 16px;
}

.toolbar label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--t3);
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.meta-grid > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-tint);
  border-radius: 10px;
  font-size: 13px;
}

.status-dot {
  font-weight: 800;
}

.status-dot.online {
  color: #276749;
}

.log-box {
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: #0f172a;
}

.log-header {
  display: flex;
  justify-content: space-between;
  padding: 10px 14px;
  background: #111827;
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 800;
}

pre {
  margin: 0;
  padding: 16px;
  max-height: 640px;
  overflow: auto;
  color: #d1d5db;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 900px) {
  .toolbar,
  .meta-grid {
    grid-template-columns: 1fr;
  }
}
</style>
