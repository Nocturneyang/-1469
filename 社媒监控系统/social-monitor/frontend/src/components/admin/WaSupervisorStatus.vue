<template>
  <div v-if="waSupervisor" class="wa-supervisor-strip">
    <div class="wa-supervisor-head">
      <div>
        <div class="wa-supervisor-title">WhatsApp Supervisor</div>
        <div class="wa-supervisor-sub">长期在线容量 {{ waCapacityText }}</div>
      </div>
      <el-button size="small" :icon="RefreshRight" :loading="loading" circle @click="$emit('refresh')" />
    </div>
    <div class="wa-supervisor-metrics">
      <div class="wa-metric">
        <span>Chrome RSS</span>
        <strong>{{ waRuntimeSummary.totalRssMb }} MB</strong>
      </div>
      <div class="wa-metric">
        <span>Chrome 进程</span>
        <strong>{{ waRuntimeSummary.totalProcessCount }}</strong>
      </div>
      <div class="wa-metric">
        <span>在线账号</span>
        <strong>{{ waRuntimeSummary.accountCount }}</strong>
      </div>
      <div class="wa-metric">
        <span>Chrome 版本</span>
        <strong>{{ waChromeVersion }}</strong>
      </div>
      <div class="wa-metric">
        <span>WebVersion</span>
        <strong>{{ waWebVersion }}</strong>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { RefreshRight } from '@element-plus/icons-vue'

const props = defineProps({
  waSupervisor: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  }
})

defineEmits(['refresh'])

const waRuntimeSummary = computed(() => {
  const runtime = props.waSupervisor?.runtime || {}
  const summary = runtime.summary || runtime
  return {
    totalRssMb: summary.totalRssMb || 0,
    totalProcessCount: summary.totalProcessCount || 0,
    accountCount: summary.accountCount || runtime.accounts?.length || 0
  }
})

const waChromeVersion = computed(() => props.waSupervisor?.chrome?.chromeVersion || '未知')
const waWebVersion = computed(() => props.waSupervisor?.webVersionCache?.latest?.version || '未缓存')

const waCapacityText = computed(() => {
  const root = props.waSupervisor?.config || {}
  const cfg = root.capacity || root
  const maxOnline = cfg.maxOnlineAccounts || '-'
  const maxStarting = cfg.maxStartingAccounts || '-'
  const maxRss = cfg.maxChromeRssMbTotal || '-'
  return `${maxOnline} 个在线 / ${maxStarting} 个启动中 / ${maxRss} MB 总预算`
})
</script>

<style scoped>
.wa-supervisor-strip {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-tint);
  padding: 16px;
  margin-bottom: 20px;
}
.wa-supervisor-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.wa-supervisor-title {
  font-weight: 850;
  color: var(--t);
  font-size: 15px;
}
.wa-supervisor-sub {
  font-size: 12px;
  color: var(--t3);
  margin-top: 2px;
  font-weight: 700;
}
.wa-supervisor-metrics {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}
.wa-metric {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
}
.wa-metric span {
  display: block;
  font-size: 11px;
  color: var(--t3);
  font-weight: 700;
  margin-bottom: 4px;
}
.wa-metric strong {
  font-size: 16px;
  color: var(--t);
}
</style>
