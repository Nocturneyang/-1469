<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">📋</span> {{ isReportView ? '日报详情' : '日报汇总' }}</span>
        <span class="hint">{{ headerHint }}</span>
      </div>

      <div class="filters">
        <select class="form-control" style="max-width: 180px" v-model="selectedDate" @change="fetchData">
          <option v-for="d in dates" :key="d" :value="d">{{ d }}</option>
        </select>
        <select class="form-control" style="max-width: 220px" v-model="selectedAccount" @change="fetchData">
          <option value="">全部账号</option>
          <option v-for="a in accounts" :key="a" :value="a">{{ a }}</option>
        </select>
        <select class="form-control" style="max-width: 180px" v-model="selectedRegion" @change="fetchData">
          <option value="">全部区域</option>
          <option v-for="r in regions" :key="r" :value="r">{{ r }}</option>
        </select>
        <select class="form-control" style="max-width: 180px" v-model="selectedSector" @change="fetchData">
          <option value="">全部板块</option>
          <option v-for="s in sectors" :key="s" :value="s">{{ s }}</option>
        </select>
        <button class="btn-primary" @click="exportMarkdown">📄 导出Markdown</button>
      </div>

      <div v-if="loading" class="empty-state loading-pulse">加载日报数据...</div>

      <div v-else-if="digests.length === 0" class="empty-state">暂无日报数据</div>

      <div v-else>
        <!-- Trend Overview -->
        <div v-if="trend" class="trend-card">
          <div class="trend-title">📊 趋势速览 ({{ selectedDate }}{{ selectedAccount ? ` · ${selectedAccount}` : '' }})</div>
          <div class="trend-stats">
            <div class="trend-item">
              <span class="trend-label">昨日消息</span>
              <span class="trend-value">{{ trend.yesterdayTotal }} 条</span>
            </div>
            <div class="trend-item">
              <span class="trend-label">覆盖群组</span>
              <span class="trend-value">{{ digests.length }} 个</span>
            </div>
            <div v-if="trend.trendPrevDay !== null" class="trend-item">
              <span class="trend-label">环比前日</span>
              <span class="trend-value" :class="getTrendClass(trend.trendPrevDay)">
                {{ getTrendIcon(trend.trendPrevDay) }} {{ trend.trendPrevDay > 0 ? '+' : '' }}{{ trend.trendPrevDay }}%
              </span>
            </div>
            <div v-if="trend.trendLastWeek !== null" class="trend-item">
              <span class="trend-label">同比上周</span>
              <span class="trend-value" :class="getTrendClass(trend.trendLastWeek)">
                {{ getTrendIcon(trend.trendLastWeek) }} {{ trend.trendLastWeek > 0 ? '+' : '' }}{{ trend.trendLastWeek }}%
              </span>
            </div>
          </div>
        </div>

        <!-- Group by Sector -->
        <div v-for="(groups, sector) in groupedDigests" :key="sector" class="sector-section">
          <div class="sector-title">
            {{ getSectorIcon(sector) }} {{ sector }}（{{ groups.length }}群 / {{ getSectorMsgCount(groups) }}条）
          </div>
          
          <div v-for="item in groups" :key="item.id" class="msg-card" style="flex-direction: column; gap: 12px">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
              <span style="font-size: 16px; font-weight: 700; color: var(--t)">{{ item.group_name }}</span>
              <div style="display: flex; gap: 8px; align-items: center">
                <span style="font-size: 12px; padding: 2px 8px; border-radius: 8px; background: rgba(107,70,193,0.1); color: var(--p); font-weight: 600">{{ item.region || '未知区' }}</span>
                <span style="font-size: 12px; color: var(--t3)">{{ item.msg_count }}条</span>
                <span v-if="item.has_alert" style="font-size: 12px">🚨</span>
              </div>
            </div>

            <!-- Key Points -->
            <div v-if="item.key_points && item.key_points.length > 0">
              <div style="font-size: 13px; font-weight: 600; color: var(--t2); margin-bottom: 8px">📌 关键讨论</div>
              <div style="font-size: 14px; color: var(--t2); line-height: 1.6">
                <div v-for="(point, i) in item.key_points.slice(0, 4)" :key="i" style="margin-bottom: 4px">• {{ point }}</div>
              </div>
            </div>

            <!-- Follow Up -->
            <div v-if="item.follow_up && item.follow_up.length > 0">
              <div style="font-size: 13px; font-weight: 600; color: var(--t2); margin-bottom: 8px">⚠️ 需关注</div>
              <div style="font-size: 14px; color: var(--t2); line-height: 1.6">
                <div v-for="(item, i) in item.follow_up.slice(0, 3)" :key="i" style="margin-bottom: 4px">• {{ item }}</div>
              </div>
            </div>

            <!-- Open Issues -->
            <div v-if="item.open_issues_cnt > 0">
              <div style="font-size: 13px; font-weight: 600; color: var(--t2); margin-bottom: 8px">⏳ 未闭环事项 ({{ item.open_issues_cnt }})</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/utils/request'

const route = useRoute()
const selectedDate = ref('')
const selectedAccount = ref('')
const selectedRegion = ref('')
const selectedSector = ref('')
const dates = ref([])
const accounts = ref([])
const regions = ref([])
const sectors = ref([])
const digests = ref([])
const trend = ref(null)
const loading = ref(true)

const isReportView = computed(() => route.path.startsWith('/reports/daily'))
const headerHint = computed(() => {
  if (selectedAccount.value) return `账号 ${selectedAccount.value} 的站内日报详情`
  return '每日09:00自动生成，展示各区域供应商群组消息摘要'
})

const groupedDigests = computed(() => {
  const groups = {}
  for (const item of digests.value) {
    const sector = item.business_sector || '未分类'
    if (!groups[sector]) groups[sector] = []
    groups[sector].push(item)
  }
  return groups
})

const getSectorIcon = (sector) => {
  const icons = { '设备供应商': '🏭', '直连供应商': '🔗', '语音直连供应商': '📞', '客服': '💬', '卡线': '📱' }
  return icons[sector] || '📋'
}

const getSectorMsgCount = (groups) => {
  return groups.reduce((sum, item) => sum + item.msg_count, 0)
}

const getTrendIcon = (value) => {
  if (value > 0) return '📈'
  if (value < 0) return '📉'
  return '➡️'
}

const getTrendClass = (value) => {
  if (value > 0) return 'trend-up'
  if (value < 0) return 'trend-down'
  return 'trend-flat'
}

const fetchData = async () => {
  loading.value = true
  try {
    const params = {}
    if (selectedDate.value) params.date = selectedDate.value
    if (selectedAccount.value) params.account = selectedAccount.value
    if (selectedRegion.value) params.region = selectedRegion.value
    if (selectedSector.value) params.sector = selectedSector.value
    
    const res = await api.get('/api/daily-digest', { params })
    if (res.success) {
      digests.value = res.data.digests || []
      trend.value = res.data.trend || null
      regions.value = res.data.regions || []
      sectors.value = res.data.sectors || []
      accounts.value = res.data.accounts || []
      dates.value = res.data.dates || []
      
      if (!selectedDate.value && (res.data.selectedDate || dates.value.length > 0)) {
        selectedDate.value = res.data.selectedDate || dates.value[0]
      }
    }
  } catch (e) {
    console.error('Failed to fetch daily digest:', e)
  }
  loading.value = false
}

const exportMarkdown = () => {
  let md = `# 日报汇总 - ${selectedDate.value}${selectedAccount.value ? ` - ${selectedAccount.value}` : ''}\n\n`
  
  if (trend.value) {
    md += `## 📊 趋势速览\n`
    md += `- 昨日消息：${trend.value.yesterdayTotal} 条\n`
    if (trend.value.trendPrevDay !== null) {
      md += `- 环比前日：${getTrendIcon(trend.value.trendPrevDay)} ${trend.value.trendPrevDay > 0 ? '+' : ''}${trend.value.trendPrevDay}%\n`
    }
    if (trend.value.trendLastWeek !== null) {
      md += `- 同比上周：${getTrendIcon(trend.value.trendLastWeek)} ${trend.value.trendLastWeek > 0 ? '+' : ''}${trend.value.trendLastWeek}%\n`
    }
    md += '\n'
  }
  
  for (const [sector, groups] of Object.entries(groupedDigests.value)) {
    md += `## ${getSectorIcon(sector)} ${sector}（${groups.length}群 / ${getSectorMsgCount(groups)}条）\n\n`
    
    for (const item of groups) {
      md += `### ${item.group_name} ${item.region || ''} - ${item.msg_count}条\n\n`
      
      if (item.key_points && item.key_points.length > 0) {
        md += `**📌 关键讨论**\n`
        for (const point of item.key_points.slice(0, 4)) {
          md += `- ${point}\n`
        }
        md += '\n'
      }
      
      if (item.follow_up && item.follow_up.length > 0) {
        md += `**⚠️ 需关注**\n`
        for (const item of item.follow_up.slice(0, 3)) {
          md += `- ${item}\n`
        }
        md += '\n'
      }
      
      if (item.open_issues_cnt > 0) {
        md += `**⏳ 未闭环事项**：${item.open_issues_cnt}项\n\n`
      }
      
      md += '---\n\n'
    }
  }
  
  const blob = new Blob([md], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `daily-digest-${selectedDate.value}.md`
  a.click()
  URL.revokeObjectURL(url)
}

const applyRouteQuery = () => {
  selectedDate.value = typeof route.query.date === 'string' ? route.query.date : selectedDate.value
  selectedAccount.value = typeof route.query.account === 'string' ? route.query.account : selectedAccount.value
  selectedRegion.value = typeof route.query.region === 'string' ? route.query.region : selectedRegion.value
  selectedSector.value = typeof route.query.sector === 'string' ? route.query.sector : selectedSector.value
}

onMounted(() => {
  applyRouteQuery()
  fetchData()
})

watch(() => route.fullPath, () => {
  applyRouteQuery()
  fetchData()
})
</script>

<style scoped>
.trend-card {
  background: var(--bg);
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 24px;
  box-shadow: 8px 8px 16px rgba(0,0,0,0.1), -8px -8px 16px rgba(255,255,255,0.8);
}

.trend-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--t);
  margin-bottom: 16px;
}

.trend-stats {
  display: flex;
  gap: 32px;
  flex-wrap: wrap;
}

.trend-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trend-label {
  font-size: 12px;
  color: var(--t3);
}

.trend-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--t);
}

.trend-up {
  color: #10b981;
}

.trend-down {
  color: #ef4444;
}

.trend-flat {
  color: var(--t3);
}

.sector-section {
  margin-bottom: 32px;
}

.sector-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--t);
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 2px solid rgba(107,70,193,0.2);
}

/* Styles now use global style.css */
</style>
