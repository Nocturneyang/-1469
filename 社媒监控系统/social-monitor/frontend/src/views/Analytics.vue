<template>
  <div class="view-enter analytics-view">
    <section class="analytics-hero">
      <div>
        <div class="eyebrow">运营驾驶舱</div>
        <h2>数据看板</h2>
        <p>按采集、告警、问题闭环、知识资产四条线聚合，优先暴露需要处理的区域和业务板块。</p>
      </div>
      <div class="toolbar">
        <select v-model="days" class="period-select" @change="fetchDashboard">
          <option :value="1">近 1 天</option>
          <option :value="7">近 7 天</option>
          <option :value="14">近 14 天</option>
          <option :value="30">近 30 天</option>
        </select>
        <button class="btn-primary icon-button" :disabled="loading" @click="fetchDashboard">
          <el-icon><Refresh /></el-icon>
          <span>{{ loading ? '刷新中' : '刷新' }}</span>
        </button>
      </div>
    </section>

    <div v-if="loading" class="empty-state loading-pulse">加载数据看板...</div>
    <div v-else-if="!dashboard.ready" class="empty-state">分析库或采集库暂不可用，请确认本地服务状态。</div>

    <template v-else>
      <section class="metric-grid">
        <article v-for="item in summaryCards" :key="item.key" class="metric-tile" :class="item.tone">
          <div class="metric-head">
            <span class="metric-icon">
              <el-icon><component :is="item.icon" /></el-icon>
            </span>
            <span class="metric-label">{{ item.label }}</span>
          </div>
          <strong>{{ item.value }}</strong>
          <p>{{ item.hint }}</p>
        </article>
      </section>

      <section class="focus-layout">
        <div class="panel work-panel">
          <div class="section-title">
            <div>
              <span>今日优先处理</span>
              <small>按响应缺口、P0/P1、未推送和未闭环综合排序</small>
            </div>
            <span class="soft-badge danger">{{ priorityItems.length }} 项</span>
          </div>
          <div v-if="priorityItems.length === 0" class="empty-inline">当前没有高优先级事项。</div>
          <div v-else class="priority-list">
            <article v-for="item in priorityItems" :key="item.key" class="priority-row">
              <span class="priority-mark" :class="item.tone">
                <el-icon><component :is="item.icon" /></el-icon>
              </span>
              <div>
                <div class="priority-title">{{ item.title }}</div>
                <p>{{ item.summary }}</p>
                <div class="meta-line">
                  <span>{{ item.scope }}</span>
                  <span>{{ item.action }}</span>
                </div>
              </div>
              <strong>{{ item.score }}</strong>
            </article>
          </div>
        </div>

        <div class="panel signal-panel">
          <div class="section-title">
            <div>
              <span>告警有效性</span>
              <small>不只看数量，也看是否成功推送和是否有响应缺口</small>
            </div>
          </div>
          <div class="signal-score">
            <strong>{{ dashboard.alerts.push_success_rate }}%</strong>
            <span>推送成功率</span>
          </div>
          <div class="level-bars">
            <div v-for="item in alertLevels" :key="item.level" class="level-row">
              <span :class="['level-pill', item.level]">{{ item.label }}</span>
              <div class="bar-track"><i :class="item.level" :style="{ width: item.width + '%' }"></i></div>
              <strong>{{ item.count }}</strong>
            </div>
          </div>
          <div class="signal-notes">
            <div>
              <span>未推送</span>
              <strong>{{ dashboard.alerts.unpushed }}</strong>
            </div>
            <div>
              <span>P2 响应缺口</span>
              <strong>{{ dashboard.alerts.by_level.p2 || 0 }}</strong>
            </div>
          </div>
        </div>
      </section>

      <section class="analytics-grid-two">
        <div class="panel">
          <div class="section-title">
            <div>
              <span>区域/板块热点</span>
              <small>按告警强度排序，决定今日先看哪里</small>
            </div>
          </div>
          <div v-if="dashboard.region_hotspots.length === 0" class="empty-inline">暂无区域告警热点。</div>
          <div v-else class="hotspot-table">
            <div class="hotspot-head">
              <span>区域 / 板块</span>
              <span>P0</span>
              <span>P1</span>
              <span>P2</span>
              <span>风险</span>
            </div>
            <div v-for="row in dashboard.region_hotspots.slice(0, 8)" :key="row.scope" class="hotspot-row">
              <strong>{{ row.scope }}</strong>
              <span>{{ row.p0_count || 0 }}</span>
              <span>{{ row.p1_count || 0 }}</span>
              <span>{{ row.p2_count || 0 }}</span>
              <span class="risk-meter"><i :style="{ width: Math.max(8, row.risk_score || 0) + '%' }"></i></span>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="section-title">
            <div>
              <span>P2 响应缺口</span>
              <small>新格式会展示诉求、风险和建议动作</small>
            </div>
          </div>
          <div v-if="dashboard.response_gaps.length === 0" class="empty-inline">当前周期暂无无响应告警。</div>
          <div v-else class="gap-list">
            <article v-for="gap in dashboard.response_gaps.slice(0, 5)" :key="gap.id" class="gap-row">
              <div>
                <strong>{{ gap.region || '未知区' }} / {{ gap.business_sector || '未分类' }}</strong>
                <p>{{ gap.ai_title || '无响应告警' }}</p>
                <small>{{ gap.group_name }} · 来源 {{ gap.source_count || 1 }} 条 · {{ formatTime(gap.created_at) }}</small>
              </div>
              <span>{{ gap.receiver_account || '-' }}</span>
            </article>
          </div>
        </div>
      </section>

      <section class="analytics-grid-two">
        <div class="panel">
          <div class="section-title">
            <div>
              <span>问题闭环</span>
              <small>未闭环和升级问题优先进入运营动作</small>
            </div>
            <span class="soft-badge">{{ dashboard.issues.resolve_rate }}% 闭环率</span>
          </div>
          <div class="issue-summary">
            <div><span>未闭环</span><strong>{{ dashboard.issues.open }}</strong></div>
            <div><span>已升级</span><strong>{{ dashboard.issues.escalated }}</strong></div>
            <div><span>平均处理</span><strong>{{ formatDuration(dashboard.issues.avg_resolution_mins) }}</strong></div>
          </div>
          <div v-if="dashboard.issues.open_list.length === 0" class="empty-inline">暂无未闭环问题。</div>
          <div v-else class="issue-list">
            <article v-for="issue in dashboard.issues.open_list.slice(0, 5)" :key="issue.id" class="issue-row">
              <span :class="['status-dot', issue.status]"></span>
              <div>
                <strong>{{ issue.issue_type || '未分类问题' }}</strong>
                <p>{{ issue.region || '未知区' }} / {{ issue.business_sector || '未分类' }} · {{ issue.group_name }}</p>
              </div>
              <small>{{ issueAge(issue.opened_at) }}</small>
            </article>
          </div>
        </div>

        <div class="panel">
          <div class="section-title">
            <div>
              <span>知识资产效率</span>
              <small>看数据沉淀速度，而不是只看候选数量</small>
            </div>
            <span class="soft-badge green">{{ dashboard.knowledge.formal_assets }} 正式</span>
          </div>
          <div class="asset-metrics">
            <div><span>候选资产</span><strong>{{ formatNumber(dashboard.knowledge.total_candidates) }}</strong></div>
            <div><span>高价值</span><strong>{{ formatNumber(dashboard.knowledge.high_value) }}</strong></div>
            <div><span>待审核</span><strong>{{ formatNumber(dashboard.knowledge.pending_review) }}</strong></div>
          </div>
          <div v-if="dashboard.knowledge.by_type.length === 0" class="empty-inline">暂无资产沉淀数据。</div>
          <div v-else class="asset-type-list">
            <div v-for="item in dashboard.knowledge.by_type.slice(0, 6)" :key="item.asset_type" class="asset-type-row">
              <span>{{ assetTypeLabel(item.asset_type) }}</span>
              <div class="bar-track"><i class="asset" :style="{ width: typeWidth(item.count) + '%' }"></i></div>
              <strong>{{ item.count }}</strong>
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="section-title">
          <div>
            <span>最近告警明细</span>
            <small>用于快速复核推送内容和处理方向</small>
          </div>
        </div>
        <div v-if="dashboard.alerts.recent.length === 0" class="empty-inline">暂无近期告警。</div>
        <div v-else class="alert-table">
          <div class="alert-head">
            <span>等级</span>
            <span>区域 / 板块</span>
            <span>告警摘要</span>
            <span>状态</span>
            <span>时间</span>
          </div>
          <div v-for="alert in dashboard.alerts.recent.slice(0, 10)" :key="alert.id" class="alert-row">
            <span :class="['level-pill', String(alert.alert_level || '').toLowerCase()]">{{ levelLabel(alert.alert_level) }}</span>
            <strong>{{ alert.region || '未知区' }} / {{ alert.business_sector || '未分类' }}</strong>
            <p>{{ alert.ai_title || alert.ai_type || '告警' }}</p>
            <span :class="['push-state', alert.is_pushed ? 'ok' : 'miss']">{{ alert.is_pushed ? '已推送' : '未推送' }}</span>
            <small>{{ formatTime(alert.created_at) }}</small>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, markRaw, onMounted, ref } from 'vue'
import {
  Bell,
  Clock,
  Collection,
  DataAnalysis,
  Refresh,
  TrendCharts,
  WarningFilled,
} from '@element-plus/icons-vue'
import { getDashboard } from '@/api/analytics'
import { formatShanghaiDateTime } from '@/utils/time'

const defaultDashboard = () => ({
  ready: false,
  collection: {
    messages_24h: 0,
    previous_messages_24h: 0,
    message_growth_pct: 0,
    active_groups_24h: 0,
    active_accounts_24h: 0,
    media_24h: 0,
    sector_volume: [],
  },
  alerts: {
    total: 0,
    last_24h: 0,
    previous_24h: 0,
    growth_pct: 0,
    pushed: 0,
    unpushed: 0,
    push_success_rate: 0,
    by_level: { p0: 0, p1: 0, p2: 0 },
    recent: [],
    trend: [],
  },
  issues: {
    open: 0,
    escalated: 0,
    closed: 0,
    resolve_rate: 0,
    avg_resolution_mins: 0,
    hotspots: [],
    open_list: [],
  },
  response_gaps: [],
  region_hotspots: [],
  knowledge: {
    ready: false,
    total_candidates: 0,
    high_value: 0,
    pending_review: 0,
    confirmed: 0,
    formal_assets: 0,
    by_type: [],
    top_candidates: [],
  },
  digest: { generated: 0, groups: 0 },
  reliability: { assessed_suppliers: 0, avg_score: 0, risky_suppliers: [] },
  message_trend: [],
})

const loading = ref(true)
const days = ref(7)
const dashboard = ref(defaultDashboard())

const formatNumber = (value) => Number(value || 0).toLocaleString()

const signedPct = (value) => {
  const n = Number(value || 0)
  if (n > 0) return `较前期 +${n}%`
  if (n < 0) return `较前期 ${n}%`
  return '较前期持平'
}

const formatDuration = (mins) => {
  const n = Number(mins || 0)
  if (!n) return '-'
  if (n >= 60) return `${Math.round(n / 60)}h`
  return `${Math.round(n)}m`
}

const formatTime = (value) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16)
  return formatShanghaiDateTime(value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const issueAge = (openedAt) => {
  const ts = Number(openedAt || 0)
  if (!ts) return '-'
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000))
  if (mins >= 1440) return `${Math.round(mins / 1440)}天`
  if (mins >= 60) return `${Math.round(mins / 60)}小时`
  return `${mins}分钟`
}

const levelLabel = (value) => String(value || 'p1').toUpperCase()

const assetLabels = {
  entity_relationship: '实体关系',
  operation_action: '处理动作',
  regional_intelligence: '区域情报',
  risk_pattern: '风险模式',
  sla_commitment: 'SLA履约',
  contact_role: '联系人角色',
  change_event: '变更事件',
  media_evidence: '媒体证据',
}

const assetTypeLabel = (value) => assetLabels[value] || value || '未知类型'

const summaryCards = computed(() => [
  {
    key: 'messages',
    label: '24h 入库消息',
    value: formatNumber(dashboard.value.collection.messages_24h),
    hint: `${signedPct(dashboard.value.collection.message_growth_pct)} · ${dashboard.value.collection.active_groups_24h} 个活跃群`,
    tone: 'blue',
    icon: markRaw(DataAnalysis),
  },
  {
    key: 'alerts',
    label: '24h 告警',
    value: formatNumber(dashboard.value.alerts.last_24h),
    hint: `${signedPct(dashboard.value.alerts.growth_pct)} · P0 ${dashboard.value.alerts.by_level.p0 || 0}`,
    tone: 'red',
    icon: markRaw(Bell),
  },
  {
    key: 'issues',
    label: '未闭环问题',
    value: formatNumber(dashboard.value.issues.open + dashboard.value.issues.escalated),
    hint: `升级 ${dashboard.value.issues.escalated} · 闭环率 ${dashboard.value.issues.resolve_rate}%`,
    tone: 'amber',
    icon: markRaw(WarningFilled),
  },
  {
    key: 'assets',
    label: '知识资产沉淀',
    value: formatNumber(dashboard.value.knowledge.formal_assets),
    hint: `候选 ${formatNumber(dashboard.value.knowledge.total_candidates)} · 待审 ${formatNumber(dashboard.value.knowledge.pending_review)}`,
    tone: 'green',
    icon: markRaw(Collection),
  },
])

const alertLevels = computed(() => {
  const levels = dashboard.value.alerts.by_level || {}
  const max = Math.max(Number(levels.p0 || 0), Number(levels.p1 || 0), Number(levels.p2 || 0), 1)
  return [
    { level: 'p0', label: 'P0', count: Number(levels.p0 || 0) },
    { level: 'p1', label: 'P1', count: Number(levels.p1 || 0) },
    { level: 'p2', label: 'P2', count: Number(levels.p2 || 0) },
  ].map(item => ({ ...item, width: Math.max(6, Math.round((item.count / max) * 100)) }))
})

const priorityItems = computed(() => {
  const gaps = (dashboard.value.response_gaps || []).slice(0, 4).map(item => ({
    key: `gap-${item.id}`,
    title: item.ai_title || 'P2 响应缺口',
    summary: item.ai_action || '先在群内回复接手状态，再确认处理方向。',
    scope: `${item.region || '未知区'} / ${item.business_sector || '未分类'}`,
    action: item.group_name || item.receiver_account || '-',
    score: 'P2',
    tone: 'amber',
    icon: markRaw(Clock),
  }))

  const regions = (dashboard.value.region_hotspots || [])
    .filter(item => Number(item.risk_score || 0) > 0)
    .slice(0, 4)
    .map(item => ({
      key: `region-${item.scope}`,
      title: `${item.scope} 告警集中`,
      summary: `近 ${days.value} 天累计 ${item.alert_count} 条告警，P0 ${item.p0_count || 0}、P1 ${item.p1_count || 0}、P2 ${item.p2_count || 0}。`,
      scope: item.scope,
      action: item.unpushed_count ? `${item.unpushed_count} 条未推送` : '路由已覆盖',
      score: item.risk_score,
      tone: item.p0_count ? 'red' : 'blue',
      icon: markRaw(TrendCharts),
    }))

  const openIssues = (dashboard.value.issues.open_list || [])
    .filter(item => Number(item.escalation_count || 0) > 0)
    .slice(0, 2)
    .map(item => ({
      key: `issue-${item.id}`,
      title: `${item.issue_type || '问题'} 已升级`,
      summary: item.commitment_text || '请确认承诺是否兑现，并补充闭环结论。',
      scope: `${item.region || '未知区'} / ${item.business_sector || '未分类'}`,
      action: item.group_name || '-',
      score: '升级',
      tone: 'red',
      icon: markRaw(WarningFilled),
    }))

  return [...gaps, ...openIssues, ...regions].slice(0, 6)
})

const maxAssetTypeCount = computed(() => Math.max(...(dashboard.value.knowledge.by_type || []).map(item => Number(item.count || 0)), 1))
const typeWidth = (count) => Math.max(8, Math.round((Number(count || 0) / maxAssetTypeCount.value) * 100))

const fetchDashboard = async () => {
  loading.value = true
  try {
    const res = await getDashboard({ days: days.value })
    if (res.success && res.data) {
      dashboard.value = { ...defaultDashboard(), ...res.data }
    }
  } catch (error) {
    console.error('Failed to load analytics dashboard', error)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchDashboard()
})
</script>

<style scoped>
.analytics-view {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.analytics-hero {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  padding: 26px 28px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: #fff;
  box-shadow: var(--out-shadow);
}

.eyebrow {
  font-size: 12px;
  font-weight: 800;
  color: #2563eb;
  margin-bottom: 4px;
}

.analytics-hero h2 {
  margin: 0;
  color: var(--t);
  font-size: 26px;
  font-weight: 850;
}

.analytics-hero p {
  margin: 8px 0 0;
  color: var(--t3);
  max-width: 680px;
}

.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.period-select {
  min-width: 116px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fff;
  color: var(--t2);
  padding: 0 10px;
  font-weight: 700;
}

.icon-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.metric-tile {
  min-height: 156px;
  padding: 18px;
  border-radius: 14px;
  background: #fff;
  border: 1px solid var(--border);
  box-shadow: var(--out-shadow);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.metric-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.metric-icon {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: #eff6ff;
  color: #2563eb;
  flex-shrink: 0;
}

.metric-tile.red .metric-icon { background: #fff1f2; color: #dc2626; }
.metric-tile.amber .metric-icon { background: #fffbeb; color: #b45309; }
.metric-tile.green .metric-icon { background: #ecfdf5; color: #047857; }

.metric-label {
  color: var(--t3);
  font-size: 13px;
  font-weight: 800;
}

.metric-tile strong {
  color: var(--t);
  font-size: 34px;
  line-height: 1.1;
}

.metric-tile p {
  color: var(--t3);
  margin: 0;
  font-size: 13px;
}

.focus-layout,
.analytics-grid-two {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.75fr);
  gap: 20px;
}

.analytics-grid-two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel {
  margin-bottom: 0;
  padding: 22px;
  border-radius: 16px;
}

.section-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 18px;
}

.section-title span {
  display: block;
  color: var(--t);
  font-size: 17px;
  font-weight: 850;
}

.section-title small {
  display: block;
  margin-top: 2px;
  color: var(--t3);
  font-size: 12px;
  font-weight: 600;
}

.soft-badge {
  display: inline-flex;
  align-items: center;
  height: 28px;
  border-radius: 999px;
  padding: 0 10px;
  background: #eef2ff;
  color: #4338ca;
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}

.soft-badge.danger { background: #fff1f2; color: #be123c; }
.soft-badge.green { background: #ecfdf5; color: #047857; }

.priority-list,
.gap-list,
.issue-list,
.asset-type-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.priority-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 58px;
  gap: 12px;
  align-items: center;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
}

.priority-mark {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #eff6ff;
  color: #2563eb;
}

.priority-mark.red { background: #fff1f2; color: #dc2626; }
.priority-mark.amber { background: #fffbeb; color: #b45309; }

.priority-title {
  font-weight: 850;
  color: var(--t);
}

.priority-row p {
  margin: 2px 0 6px;
  color: var(--t2);
  font-size: 13px;
}

.priority-row > strong {
  text-align: right;
  color: var(--t);
}

.meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--t3);
  font-size: 12px;
  font-weight: 700;
}

.signal-score {
  height: 128px;
  border-radius: 14px;
  border: 1px solid #bfdbfe;
  background: linear-gradient(180deg, #eff6ff, #fff);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  margin-bottom: 16px;
}

.signal-score strong {
  font-size: 44px;
  line-height: 1;
  color: #1d4ed8;
}

.signal-score span {
  color: var(--t3);
  font-size: 13px;
  font-weight: 800;
  margin-top: 8px;
}

.level-bars,
.signal-notes {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.level-row,
.asset-type-row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 38px;
  align-items: center;
  gap: 10px;
}

.level-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 38px;
  height: 24px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 850;
}

.level-pill.p0 { background: #fff1f2; color: #dc2626; }
.level-pill.p1 { background: #fffbeb; color: #b45309; }
.level-pill.p2 { background: #eff6ff; color: #2563eb; }

.bar-track {
  height: 9px;
  border-radius: 999px;
  background: #edf2f7;
  overflow: hidden;
}

.bar-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
}

.bar-track i.p0 { background: #ef4444; }
.bar-track i.p1 { background: #f59e0b; }
.bar-track i.p2 { background: #3b82f6; }
.bar-track i.asset { background: #10b981; }

.signal-notes {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
}

.signal-notes div,
.issue-summary div,
.asset-metrics div {
  padding: 12px;
  border-radius: 12px;
  background: var(--bg-tint);
}

.signal-notes span,
.issue-summary span,
.asset-metrics span {
  display: block;
  color: var(--t3);
  font-size: 12px;
  font-weight: 800;
}

.signal-notes strong,
.issue-summary strong,
.asset-metrics strong {
  color: var(--t);
  font-size: 22px;
}

.hotspot-table,
.alert-table {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hotspot-head,
.hotspot-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px 44px 44px 100px;
  gap: 10px;
  align-items: center;
}

.hotspot-head,
.alert-head {
  color: var(--t3);
  font-size: 12px;
  font-weight: 850;
}

.hotspot-row,
.alert-row,
.gap-row,
.issue-row {
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
}

.hotspot-row strong,
.gap-row strong,
.issue-row strong {
  color: var(--t);
}

.risk-meter {
  height: 9px;
  border-radius: 999px;
  background: #f1f5f9;
  overflow: hidden;
}

.risk-meter i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #22c55e, #f59e0b, #ef4444);
}

.gap-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
}

.gap-row p,
.issue-row p,
.alert-row p {
  margin: 3px 0;
  color: var(--t2);
  font-size: 13px;
}

.gap-row small,
.issue-row small,
.alert-row small {
  color: var(--t3);
  font-size: 12px;
}

.gap-row > span {
  color: var(--t3);
  font-size: 12px;
  font-weight: 800;
  white-space: nowrap;
}

.issue-summary,
.asset-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}

.issue-row {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) 56px;
  gap: 12px;
  align-items: center;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #f59e0b;
}

.status-dot.escalated { background: #ef4444; }

.asset-type-row {
  grid-template-columns: 116px minmax(0, 1fr) 42px;
}

.asset-type-row span {
  color: var(--t2);
  font-size: 13px;
  font-weight: 800;
}

.alert-head,
.alert-row {
  display: grid;
  grid-template-columns: 64px 190px minmax(0, 1fr) 78px 110px;
  gap: 12px;
  align-items: center;
}

.push-state {
  display: inline-flex;
  justify-content: center;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 12px;
  font-weight: 850;
}

.push-state.ok { color: #047857; background: #ecfdf5; }
.push-state.miss { color: #be123c; background: #fff1f2; }

.empty-inline {
  padding: 20px;
  border: 1px dashed var(--border);
  border-radius: 12px;
  color: var(--t3);
  background: #fff;
}

@media (max-width: 1200px) {
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .focus-layout,
  .analytics-grid-two {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .analytics-hero,
  .section-title,
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .metric-grid {
    grid-template-columns: 1fr;
  }

  .hotspot-head,
  .hotspot-row,
  .alert-head,
  .alert-row {
    grid-template-columns: 1fr;
  }

  .issue-summary,
  .asset-metrics,
  .signal-notes {
    grid-template-columns: 1fr;
  }
}
</style>
