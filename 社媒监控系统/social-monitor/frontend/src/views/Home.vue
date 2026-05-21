<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">📡</span> 数据采集吞吐量</span>
        <span class="hint">滚动窗口 24h · 自动 10s 刷新 · 4 个采集终端在线</span>
      </div>
      <div class="grid-4">
        <div class="stat-card color-p">
          <div class="stat-lbl">实时总入库数</div>
          <div class="stat-val" :class="{ 'loading-pulse': loadingStats }">{{ loadingStats ? '--' : stats.total.toLocaleString() }}</div>
          <div class="stat-foot"><span class="up">↑ 18.4%</span> 较昨日同时段</div>
        </div>
        <div class="stat-card color-wa">
          <div class="stat-lbl">WhatsApp 规模</div>
          <div class="stat-val" :class="{ 'loading-pulse': loadingStats }">{{ loadingStats ? '--' : stats.platforms.whatsapp.toLocaleString() }}</div>
          <div class="stat-foot"><span class="up">↑ 1,203</span> · 24h</div>
        </div>
        <div class="stat-card color-tg">
          <div class="stat-lbl">Telegram 规模</div>
          <div class="stat-val" :class="{ 'loading-pulse': loadingStats }">{{ loadingStats ? '--' : stats.platforms.telegram.toLocaleString() }}</div>
          <div class="stat-foot"><span class="up">↑ 480</span> · 24h</div>
        </div>
        <div class="stat-card color-m">
          <div class="stat-lbl">含媒体附件数</div>
          <div class="stat-val" :class="{ 'loading-pulse': loadingStats }">{{ loadingStats ? '--' : stats.withMedia.toLocaleString() }}</div>
          <div class="stat-foot"><span class="down">↓ 86</span> · 24h</div>
        </div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 5fr 4fr; gap: 24px">
      <div class="panel">
        <div class="panel-title">
          <span class="title-text"><span class="panel-icon">🚨</span> 实时告警流</span>
          <span class="hint">P0 · P1 自动路由至区域负责人</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 10">
          <div v-for="a in alerts" :key="a.id" style="display: flex; align-items: center; gap: 14px; padding: 14px 16px; background: #fff; border: 1px solid var(--border); border-radius: 14px">
            <span :class="'tag ' + (a.lvl === 'P0' ? 'p0' : 'p1')" style="font-size: 10px; min-width: 32px; justify-content: center; display: flex">{{ a.lvl }}</span>
            <div style="flex: 1; min-width: 0">
              <div style="font-size: 14px; color: var(--t); font-weight: 600; margin-bottom: 2px">{{ a.text }}</div>
              <div style="font-size: 11px; color: var(--t3)">{{ a.group }}</div>
            </div>
            <span style="font-size: 11px; color: var(--t3); font-family: var(--font-mono)">{{ a.time }}</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">
          <span class="title-text"><span class="panel-icon">✅</span> 近期闭环</span>
          <span class="hint">今日 12 项</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 10">
          <div v-for="c in closedRecent" :key="c.id" style="display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; background: var(--bg-tint); border-radius: 12px">
            <span class="tag green" style="font-size: 10px; min-width: 38px; justify-content: center; display: flex">闭环</span>
            <div style="flex: 1; min-width: 0">
              <div style="font-size: 13px; color: var(--t); font-weight: 600">{{ c.text }}</div>
              <div style="font-size: 11px; color: var(--t3); margin-top: 2px">{{ c.supplier }} · MTTR {{ c.mttr }}</div>
            </div>
            <span style="font-size: 11px; color: var(--t3); font-family: var(--font-mono)">{{ c.time }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import api from '@/utils/request'

const loadingStats = ref(true)
const stats = ref({
  total: 0,
  platforms: { whatsapp: 0, telegram: 0 },
  withMedia: 0
})

const alerts = ref([])
const closedRecent = ref([])

let pollTimer = null

const fetchStats = async () => {
  try {
    const res = await api.get('/api/stats')
    if (res.success) {
      stats.value = res
    }
  } catch (err) {
    console.error(err)
  } finally {
    loadingStats.value = false
  }
}

const fetchAlerts = async () => {
  try {
    const res = await api.get('/api/alerts')
    if (res.success) {
      alerts.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to fetch alerts:', err)
  }
}

const fetchClosedRecent = async () => {
  try {
    const res = await api.get('/api/closed-recent')
    if (res.success) {
      closedRecent.value = res.data || []
    }
  } catch (err) {
    console.error('Failed to fetch closed recent:', err)
  }
}

onMounted(() => {
  fetchStats()
  fetchAlerts()
  fetchClosedRecent()
  pollTimer = setInterval(() => {
    fetchStats()
    fetchAlerts()
    fetchClosedRecent()
  }, 10000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>
