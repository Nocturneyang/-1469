<template>
  <div class="view-enter region-intel-page">
    <section class="panel intro-panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">🗺️</span> {{ pageTitle }}</span>
        <div class="filters compact-filters">
          <select v-model="filters.days" class="form-control" @change="fetchData">
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
            <option value="90">近 90 天</option>
          </select>
          <select v-model="filters.region" class="form-control" @change="fetchData">
            <option value="">全部{{ axisLabel }}</option>
            <option v-for="r in regions" :key="r" :value="r">{{ r }}</option>
          </select>
          <select v-model="filters.sector" class="form-control" @change="fetchData">
            <option value="">全部板块</option>
            <option v-for="s in sectors" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
      </div>

      <div class="scope-switch">
        <button
          v-for="item in scopeOptions"
          :key="item.key"
          type="button"
          :class="{ active: filters.scope === item.key }"
          @click="changeScope(item.key)"
        >
          <strong>{{ item.label }}</strong>
          <span>{{ item.description }}</span>
        </button>
      </div>

      <div class="brief-hero">
        <div>
          <span class="eyebrow">{{ scopeMeta.label }}简报</span>
          <h1>{{ selected?.business_brief?.title || `暂无${pageTitle}` }}</h1>
          <p>{{ selected?.business_brief?.summary || '等待更多消息和资产样本形成可读结论。' }}</p>
          <div v-if="selected?.business_brief?.key_points?.length" class="brief-points">
            <span v-for="point in selected.business_brief.key_points.slice(0, 3)" :key="point.title">
              {{ point.title }}
            </span>
          </div>
        </div>
        <div class="hero-metrics">
          <span><b>{{ fmt(summary.message_count) }}</b>消息</span>
          <span><b>{{ fmt(summary.total) }}</b>资产</span>
          <span><b>{{ fmt(summary.high_value) }}</b>高价值</span>
        </div>
      </div>

      <div v-if="summary.ai_judgment" class="ai-summary" :class="aiStatusClass">
        <div class="ai-title">
          <span>AI判断</span>
          <i>{{ aiStatusText }} · {{ summary.ai_judgment.model || '未配置模型' }}</i>
        </div>
        <p>{{ summary.ai_judgment.summary || summary.ai_judgment.judgment }}</p>
        <div class="ai-tags">
          <b :class="priorityClass(summary.ai_judgment.priority)">{{ priorityText(summary.ai_judgment.priority) }}</b>
          <span>{{ fmtConfidence(summary.ai_judgment.confidence) }}</span>
          <span v-for="item in aiReasons" :key="item">{{ item }}</span>
        </div>
      </div>

      <div v-if="selected?.business_brief" class="battle-layout">
        <article class="battle-report-card">
          <span>一句话战报</span>
          <p>{{ selected.business_brief.battle_report || selected.business_brief.summary }}</p>
        </article>
        <article class="priority-card">
          <div class="mini-title">
            <span>优先处理清单</span>
            <b>{{ selected.business_brief.priority_actions?.length || 0 }}</b>
          </div>
          <div class="priority-list">
            <div
              v-for="action in selected.business_brief.priority_actions || []"
              :key="action.title"
              class="priority-item"
              :class="action.tone"
            >
              <strong>{{ action.title }}</strong>
              <p>{{ action.text }}</p>
            </div>
          </div>
        </article>
      </div>

      <div v-if="selected?.business_brief?.operational_profile?.length" class="profile-block">
        <div class="profile-title">
          <span>区域画像摘要</span>
          <b>{{ selected.collection_region }} / {{ selected.business_sector }}</b>
        </div>
        <div class="profile-strip">
          <div
            v-for="item in selected.business_brief.operational_profile"
            :key="item.label"
            class="profile-item"
            :class="item.tone"
          >
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
            <p>{{ item.detail }}</p>
          </div>
        </div>
      </div>

      <div class="category-strip">
        <button
          v-for="item in categoryTotals"
          :key="item.key"
          type="button"
          class="category-pill"
          :class="item.tone"
          @click="scrollToCategory(item.key)"
        >
          <span>{{ item.label }}</span>
          <strong>{{ fmt(item.count) }}</strong>
        </button>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title compact">
        <span class="title-text">{{ axisLabel }} × 业务板块</span>
        <span class="hint">{{ loading && matrix.length ? '正在刷新...' : '点击单元格切换简报对象' }}</span>
      </div>

      <div v-if="loading && matrix.length === 0" class="empty-state loading-pulse">加载{{ pageTitle }}...</div>
      <div v-else-if="errorMessage && matrix.length === 0" class="empty-state error-state">
        <span>{{ errorMessage }}</span>
        <button type="button" @click="fetchData">重试</button>
      </div>
      <div v-else-if="matrix.length === 0" class="empty-state">暂无{{ pageTitle }}样本</div>
      <div v-else class="heatmap" :style="matrixStyle">
        <div class="matrix-corner">{{ axisLabel }} / 板块</div>
        <div v-for="sector in sectorColumns" :key="sector" class="matrix-head">{{ sector }}</div>

        <template v-for="region in regionRows" :key="region">
          <div class="matrix-region">{{ region }}</div>
          <button
            v-for="sector in sectorColumns"
            :key="`${region}-${sector}`"
            type="button"
            class="matrix-cell"
            :class="{ active: selectedKey === `${region}::${sector}` }"
            :style="cellStyle(cellFor(region, sector))"
            @click="selectCell(cellFor(region, sector))"
          >
            <template v-if="cellFor(region, sector)">
              <strong>{{ cellFor(region, sector).business_intel?.top_category?.short_label || '资产' }}</strong>
              <span>{{ cellMeta(cellFor(region, sector)) }}</span>
            </template>
            <template v-else>
              <strong>—</strong>
              <span>暂无样本</span>
            </template>
          </button>
        </template>
      </div>
    </section>

    <section v-if="selected" class="intel-grid">
      <article
        v-for="card in selectedCards"
        :key="card.key"
        :id="`intel-${card.key}`"
        class="intel-card"
        :class="card.tone"
      >
        <div class="card-head">
          <div class="card-title-block">
            <span>{{ card.label }}</span>
            <h3>{{ card.card_title || card.label }}</h3>
          </div>
          <div class="card-score">
            <h2>{{ fmt(card.count) }}</h2>
            <b :class="card.action_status?.tone">{{ card.action_status?.label || card.score_label || card.short_label }}</b>
          </div>
        </div>

        <div class="decision-block conclusion">
          <span>上下文总结</span>
          <p>{{ card.ai_summary || card.conclusion || card.insight }}</p>
        </div>
        <div v-if="card.key_objects?.length" class="decision-block object-block">
          <span>关键对象</span>
          <div class="object-list">
            <i v-for="item in card.key_objects.slice(0, 5)" :key="item">{{ item }}</i>
          </div>
        </div>
        <div class="intel-note basis">
          <span>判断依据</span>
          <div v-if="basisItems(card).length" class="basis-list">
            <i v-for="item in basisItems(card)" :key="item">{{ item }}</i>
          </div>
          <p v-else>{{ card.judgment || card.insight }}</p>
        </div>
        <div v-if="card.ai_judgment" class="intel-note ai-card">
          <span>AI判断</span>
          <p>{{ card.ai_judgment }}</p>
          <b>{{ priorityText(card.ai_priority) }} · {{ fmtConfidence(card.ai_confidence) }}</b>
        </div>
        <div class="intel-note next">
          <span>缺口提示</span>
          <p>{{ missingText(card) }}</p>
        </div>
        <div class="intel-note action">
          <span>下一步</span>
          <ol v-if="card.next_steps?.length" class="step-list">
            <li v-for="step in card.next_steps.slice(0, 4)" :key="step">{{ step }}</li>
          </ol>
          <p v-else>{{ card.next_step || '继续观察，等待更多上下文确认。' }}</p>
        </div>
        <div class="card-footer">
          <span class="status-pill" :class="card.action_status?.tone">{{ card.action_status?.label || '仅观察' }}</span>
          <div class="library-list">
            <b>现有去向</b>
            <i v-for="lib in availableDestinations(card)" :key="lib">{{ lib }}</i>
          </div>
          <div v-if="plannedCapabilities(card).length" class="library-list planned-list">
            <b>待建能力</b>
            <i v-for="lib in plannedCapabilities(card)" :key="lib">{{ lib }}</i>
          </div>
        </div>
        <div v-if="card.terms?.length" class="term-list">
          <span v-for="term in card.terms" :key="term.key">{{ term.key }} {{ term.count }}</span>
        </div>
      </article>
    </section>

    <div class="read-layout">
      <section class="panel action-panel">
        <div class="panel-title compact">
          <span class="title-text">建议动作</span>
          <span class="hint">{{ selected?.collection_region || axisLabel }} / {{ selected?.business_sector || '板块' }}</span>
        </div>
        <div v-if="selected" class="next-actions">
          <p v-for="tip in selected.recommendations" :key="tip">{{ tip }}</p>
        </div>
      </section>

      <section class="panel action-panel">
        <div class="panel-title compact">
          <span class="title-text">经营结构</span>
          <span class="hint">沉淀方向和资产构成</span>
        </div>
        <div v-if="selected" class="structure-grid">
          <div>
            <h3>资产结构</h3>
            <div class="bar-list">
              <div v-for="item in selected.top_types" :key="item.key" class="bar-row">
                <span>{{ item.label }}</span>
                <i :style="{ width: barWidth(item.count, selected.total) }"></i>
                <b>{{ item.count }}</b>
              </div>
            </div>
          </div>
          <div>
            <h3>现有沉淀分布</h3>
            <div class="tag-list">
              <span v-for="item in selected.target_libraries" :key="item.key">{{ item.label }} {{ item.count }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div class="read-layout">
      <section class="panel">
        <div class="panel-title compact">
          <span class="title-text">高频实体</span>
          <span class="hint">可跳转到实体关系图谱</span>
        </div>
        <div class="entity-list">
          <button
            v-for="item in summary.top_entities.slice(0, 12)"
            :key="item.key"
            type="button"
            class="rank-row"
            @click="jumpGraph(item)"
          >
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
            <b>{{ item.count }}</b>
          </button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-title compact">
          <span class="title-text">长期上下文摘要</span>
          <span class="hint">不展示原文，只展示经营判断</span>
        </div>
        <div class="narrative-list">
          <article
            v-for="point in selected?.business_brief?.key_points || []"
            :key="point.title"
            class="narrative-item"
          >
            <strong>{{ point.title }}</strong>
            <p>{{ point.text }}</p>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/utils/request'

const router = useRouter()
const CATEGORY_ORDER = [
  { key: 'market', label: '市场情报', short_label: '市场', tone: 'blue' },
  { key: 'price', label: '价格情报', short_label: '价格', tone: 'amber' },
  { key: 'effect', label: '效果反馈', short_label: '效果', tone: 'green' },
  { key: 'resource', label: '资源情报', short_label: '资源', tone: 'cyan' },
  { key: 'risk', label: '风险情报', short_label: '风险', tone: 'red' },
  { key: 'fulfillment', label: '履约情报', short_label: '履约', tone: 'purple' },
]
const TONE_RGB = {
  market: '37, 99, 235',
  price: '180, 83, 9',
  effect: '4, 120, 87',
  resource: '8, 145, 178',
  risk: '185, 28, 28',
  fulfillment: '109, 40, 217',
}
const scopeOptions = [
  {
    key: 'market',
    label: '市场区域',
    description: '南亚、欧美、亚太、语音市场',
  },
  {
    key: 'domain',
    label: '业务域',
    description: '设备技术、客服、卡线等运营线',
  },
  {
    key: 'all',
    label: '全部归属',
    description: '用于排查混合口径',
  },
]

const loading = ref(false)
const errorMessage = ref('')
const filters = ref({ days: '30', region: '', sector: '', scope: 'market' })
let requestSeq = 0
let aiRequestSeq = 0
const REGION_DASHBOARD_TIMEOUT_MS = 12000
const summary = ref({
  view_scope: null,
  total: 0,
  formal_count: 0,
  candidate_count: 0,
  high_value: 0,
  message_count: 0,
  category_totals: {},
  matrix: [],
  regions: [],
  sectors: [],
  top_entities: [],
  top_actions: [],
  top_risks: [],
  top_assets: [],
  ai_judgment: null,
  ai_focus_key: '',
})
const selectedKey = ref('')

const matrix = computed(() => summary.value.matrix || [])
const scopeMeta = computed(() => summary.value.view_scope || scopeOptions.find(item => item.key === filters.value.scope) || scopeOptions[0])
const axisLabel = computed(() => scopeMeta.value.region_label || (filters.value.scope === 'domain' ? '业务域' : '区域'))
const pageTitle = computed(() => filters.value.scope === 'domain' ? '业务域运营情报' : '区域运营情报')
const regions = computed(() => summary.value.regions || [])
const sectors = computed(() => summary.value.sectors || [])
const regionRows = computed(() => filters.value.region ? [filters.value.region] : regions.value.slice(0, 12))
const sectorColumns = computed(() => filters.value.sector ? [filters.value.sector] : sectors.value.slice(0, 8))
const cellMap = computed(() => new Map(matrix.value.map(item => [item.key, item])))
const selected = computed(() => cellMap.value.get(selectedKey.value) || matrix.value[0] || null)
const matrixStyle = computed(() => ({ gridTemplateColumns: `150px repeat(${Math.max(1, sectorColumns.value.length)}, minmax(140px, 1fr))` }))
const maxHeat = computed(() => Math.max(1, ...matrix.value.map(item => businessHeat(item))))
const categoryTotals = computed(() => CATEGORY_ORDER.map(item => ({
  ...item,
  count: summary.value.category_totals?.[item.key] || 0,
})))
const selectedCards = computed(() => {
  const cards = selected.value?.business_brief?.categories || []
  const byKey = new Map(cards.map(item => [item.key, item]))
  return CATEGORY_ORDER.map(meta => ({
    ...meta,
    ...(byKey.get(meta.key) || {
      count: 0,
      terms: [],
      key_objects: [],
      basis: ['缺少稳定样本', '缺少可验证闭环'],
      missing_info: ['缺少稳定样本', '缺少可验证闭环'],
      target_libraries: ['区域运营情报'],
      available_destinations: ['区域运营情报'],
      planned_capabilities: [],
      next_steps: ['继续积累消息上下文', '等待出现明确对象、结果或闭环后再沉淀'],
      action_status: { label: '仅观察', tone: 'muted' },
      card_title: `${meta.label}：继续观察`,
      insight: '暂无明显信号。',
      conclusion: '暂无明显信号。',
      impact: '当前不足以支撑运营动作，建议继续观察。',
      judgment: '暂无明显信号。',
      next_step: '继续观察，等待更多上下文确认。',
    }),
  }))
})
const aiStatusClass = computed(() => summary.value.ai_judgment?.status || 'fallback')
const aiStatusText = computed(() => {
  const status = summary.value.ai_judgment?.status
  if (status === 'ready') return '已参与'
  if (status === 'loading') return '生成中'
  if (status === 'not_configured') return '未配置'
  if (status === 'disabled') return '已关闭'
  return '规则降级'
})
const aiReasons = computed(() => (summary.value.ai_judgment?.reasons || []).slice(0, 3))

const fmt = (value) => Number(value || 0).toLocaleString('zh-CN')
const missingText = (card) => (card.missing_info || []).slice(0, 3).join('、') || '暂未识别明确缺口。'
const labelList = (items) => (items || [])
  .map(item => (typeof item === 'string' ? item : item?.label || item?.key || ''))
  .filter(Boolean)
const basisItems = (card) => labelList(card.basis).slice(0, 5)
const availableDestinations = (card) => {
  const items = labelList(card.available_destinations?.length ? card.available_destinations : card.target_libraries)
  return items.length ? items.slice(0, 4) : ['区域运营情报']
}
const plannedCapabilities = (card) => labelList(card.planned_capabilities).slice(0, 3)
const priorityText = (priority) => {
  if (priority === 'high') return '高优先级'
  if (priority === 'low') return '低优先级'
  return '中优先级'
}
const priorityClass = (priority) => `priority-${priority || 'medium'}`
const fmtConfidence = (value) => {
  const n = Number(value || 0)
  return n > 0 ? `置信度 ${Math.round(n)}%` : '置信度待确认'
}
const pendingAiJudgment = () => ({
  enabled: false,
  status: 'loading',
  model: 'deepseek-v4-flash',
  summary: 'AI 判断生成中，当前先展示规则抽取和确定性总结。',
  judgment: '等待模型二次判断。',
  priority: 'medium',
  confidence: 0,
  reasons: ['规则层已先提取对话对象、集中群和代表信号'],
})
const barWidth = (count, total) => `${Math.max(8, Math.min(100, (Number(count || 0) / Math.max(1, Number(total || 1))) * 100))}%`
const cellFor = (region, sector) => cellMap.value.get(`${region}::${sector}`)
const categoryCount = (cell, key) => cell?.business_intel?.categories?.find(item => item.key === key)?.count || 0
const businessHeat = (cell) => {
  if (!cell) return 0
  return (categoryCount(cell, 'market') * 1.3) +
    (categoryCount(cell, 'price') * 1.7) +
    (categoryCount(cell, 'effect') * 1.5) +
    (categoryCount(cell, 'risk') * 1.2) +
    (cell.high_value || 0)
}
const cellStyle = (cell) => {
  if (!cell) return { background: '#f8fafc', color: '#94a3b8' }
  const score = businessHeat(cell) / maxHeat.value
  const alpha = Math.max(0.08, Math.min(0.3, score * 0.3))
  const rgb = TONE_RGB[cell.business_intel?.top_category?.key] || '71, 85, 105'
  return {
    background: `linear-gradient(135deg, rgba(${rgb}, ${alpha}), rgba(255,255,255,.92))`,
    borderColor: score > 0.55 ? `rgba(${rgb}, .42)` : 'var(--border)',
  }
}
const cellMeta = (cell) => {
  if (!cell) return '暂无样本'
  const top = cell.business_intel?.top_category
  const count = top?.count || cell.total || 0
  return `${count} 条 · 资产 ${cell.total || 0} · 高价值 ${cell.high_value || 0}`
}

const selectCell = (cell) => {
  if (!cell) return
  selectedKey.value = cell.key
  fetchRegionAiForSelected(cell)
}

const changeScope = (scope) => {
  if (filters.value.scope === scope) return
  filters.value.scope = scope
  filters.value.region = ''
  selectedKey.value = ''
  fetchData()
}

const scrollToCategory = (key) => {
  const el = document.getElementById(`intel-${key}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

const jumpGraph = (item) => {
  router.push({ path: '/entity-graph', query: { center: `${item.type}:${item.value}`, region: filters.value.region, sector: filters.value.sector } })
}

const fetchData = async () => {
  const seq = ++requestSeq
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.get('/api/knowledge-assets/intelligence/region-dashboard', {
      timeout: REGION_DASHBOARD_TIMEOUT_MS,
      params: { ...filters.value, ai: 0 },
    })
    if (seq !== requestSeq) return
    if (res.success) {
      summary.value = {
        ...(res.data || summary.value),
        ai_judgment: null,
        ai_focus_key: '',
      }
      selectedKey.value = summary.value.matrix?.[0]?.key || ''
      if (selected.value) fetchRegionAiForSelected(selected.value)
    } else {
      errorMessage.value = res.error || `${pageTitle.value}加载失败。`
    }
  } catch (err) {
    if (seq === requestSeq) {
      errorMessage.value = err.code === 'ECONNABORTED'
        ? `${pageTitle.value}加载超时，请稍后重试。`
        : `${pageTitle.value}加载失败，请稍后重试。`
    }
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

const fetchRegionAiForSelected = async (cell) => {
  if (!cell?.key) return
  const seq = ++aiRequestSeq
  summary.value = {
    ...summary.value,
    ai_judgment: pendingAiJudgment(),
    ai_focus_key: cell.key,
  }
  try {
    const res = await api.get('/api/knowledge-assets/intelligence/region-dashboard', {
      timeout: 30000,
      silentError: true,
      params: {
        ...filters.value,
        region: cell.collection_region,
        sector: cell.business_sector,
        focusKey: cell.key,
        ai: 1,
      },
    })
    if (seq !== aiRequestSeq || !res.success) return
    const aiData = res.data || {}
    const updatedRow = aiData.matrix?.[0]
    const rows = (summary.value.matrix || []).map((row) => (
      row.key === cell.key && updatedRow
        ? { ...row, business_brief: updatedRow.business_brief, recommendations: updatedRow.recommendations }
        : row
    ))
    summary.value = {
      ...summary.value,
      matrix: rows,
      ai_judgment: aiData.ai_judgment || summary.value.ai_judgment,
      ai_focus_key: cell.key,
    }
  } catch (_) {
    if (seq === aiRequestSeq) {
      summary.value = {
        ...summary.value,
        ai_judgment: {
          ...summary.value.ai_judgment,
          status: 'fallback',
          summary: 'AI 判断暂未返回，当前展示为规则抽取和确定性总结。',
        },
      }
    }
  }
}

onMounted(fetchData)
</script>

<style scoped>
.region-intel-page {
  --intel-surface: #f6f8fc;
  --intel-border: #dbe4f0;
  --intel-shadow: 0 12px 30px rgba(15, 23, 42, .06);
}
.region-intel-page .panel {
  border-color: var(--intel-border);
}
.compact-filters {
  justify-content: flex-end;
  margin: 0;
}
.compact-filters .form-control {
  max-width: 160px;
}
.scope-switch {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 16px;
}
.scope-switch button {
  border: 1px solid #dbe4f0;
  border-radius: 12px;
  background: rgba(255,255,255,.78);
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease, background .18s ease;
}
.scope-switch button strong {
  display: block;
  color: var(--t);
  font-size: 14px;
}
.scope-switch button span {
  display: block;
  margin-top: 5px;
  color: var(--t3);
  font-size: 12px;
  font-weight: 800;
}
.scope-switch button.active {
  border-color: #93c5fd;
  background: linear-gradient(135deg, #eff6ff, #fff);
  box-shadow: inset 0 4px 0 #2563eb, 0 10px 22px rgba(37,99,235,.08);
  transform: translateY(-1px);
}
.scope-switch button:nth-child(2).active {
  border-color: #a7f3d0;
  background: linear-gradient(135deg, #ecfdf5, #fff);
  box-shadow: inset 0 4px 0 #047857, 0 10px 22px rgba(4,120,87,.08);
}
.scope-switch button:nth-child(3).active {
  border-color: #ddd6fe;
  background: linear-gradient(135deg, #f5f3ff, #fff);
  box-shadow: inset 0 4px 0 #6d28d9, 0 10px 22px rgba(109,40,217,.08);
}
.intro-panel {
  border-top: 0;
  background:
    linear-gradient(135deg, rgba(37,99,235,.08), rgba(255,255,255,.9) 42%, rgba(245,158,11,.08)),
    #fff;
  box-shadow: var(--intel-shadow);
}
.brief-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 18px;
  align-items: stretch;
  margin-top: 18px;
}
.eyebrow {
  display: inline-flex;
  border: 1px solid #c7d2fe;
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 900;
}
.brief-hero h1 {
  margin: 8px 0 10px;
  color: var(--t);
  font-size: 28px;
  line-height: 1.25;
}
.brief-hero p {
  margin: 0;
  color: var(--t2);
  font-size: 15px;
  line-height: 1.8;
}
.brief-points {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.brief-points span {
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  background: rgba(239,246,255,.9);
  color: #1d4ed8;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 900;
}
.brief-points span:nth-child(2) {
  border-color: #a7f3d0;
  background: rgba(236,253,245,.92);
  color: #047857;
}
.brief-points span:nth-child(3) {
  border-color: #fed7aa;
  background: rgba(255,247,237,.92);
  color: #c2410c;
}
.hero-metrics {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.hero-metrics span {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255,255,255,.76);
  padding: 12px;
  color: var(--t3);
  font-size: 12px;
  font-weight: 800;
  box-shadow: 0 8px 18px rgba(15, 23, 42, .04);
}
.hero-metrics span:nth-child(1) {
  border-color: #bfdbfe;
  background: #eff6ff;
}
.hero-metrics span:nth-child(2) {
  border-color: #fde68a;
  background: #fffbeb;
}
.hero-metrics span:nth-child(3) {
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.hero-metrics b {
  display: block;
  color: var(--t);
  font-size: 24px;
}
.ai-summary {
  margin-top: 16px;
  border: 1px solid #cbd5e1;
  border-radius: 12px;
  background: rgba(255,255,255,.84);
  padding: 12px;
}
.ai-summary.ready {
  background: linear-gradient(135deg, #f0fdf4, #fff);
  border-color: #86efac;
}
.ai-summary.loading {
  background: linear-gradient(135deg, #eff6ff, #fff);
  border-color: #bfdbfe;
}
.ai-summary.fallback,
.ai-summary.not_configured,
.ai-summary.disabled {
  background: linear-gradient(135deg, #f8fafc, #fff);
}
.ai-title {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
}
.ai-title span {
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 900;
}
.ai-title i {
  color: var(--t3);
  font-size: 11px;
  font-style: normal;
  font-weight: 800;
}
.ai-summary p {
  margin: 8px 0 0;
  color: var(--t);
  line-height: 1.7;
}
.ai-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}
.ai-tags span,
.ai-tags b {
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  background: #fff;
  color: var(--t2);
  padding: 5px 9px;
  font-size: 11px;
  font-weight: 900;
}
.ai-tags b.priority-high { color: #991b1b; border-color: #fecaca; background: #fef2f2; }
.ai-tags b.priority-medium { color: #92400e; border-color: #fde68a; background: #fffbeb; }
.ai-tags b.priority-low { color: #047857; border-color: #a7f3d0; background: #ecfdf5; }
.error-state {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: center;
  color: #991b1b;
}
.error-state button {
  border: 1px solid #fecaca;
  border-radius: 8px;
  background: #fff;
  color: #991b1b;
  padding: 8px 14px;
  font-weight: 900;
  cursor: pointer;
}
.battle-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(360px, .9fr);
  gap: 14px;
  margin-top: 16px;
}
.battle-report-card,
.priority-card {
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: rgba(255,255,255,.82);
  box-shadow: 0 10px 24px rgba(15,23,42,.045);
  padding: 14px;
}
.battle-report-card {
  border-left: 5px solid #2563eb;
  background: linear-gradient(135deg, #eff6ff, #fff 58%);
}
.battle-report-card span,
.mini-title span {
  display: block;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 900;
}
.battle-report-card p {
  margin: 8px 0 0;
  color: var(--t);
  font-size: 15px;
  font-weight: 800;
  line-height: 1.75;
}
.mini-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.mini-title b {
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  padding: 3px 9px;
  font-size: 12px;
}
.priority-list {
  display: grid;
  gap: 8px;
}
.priority-item {
  border: 1px solid #e2e8f0;
  border-left: 4px solid #64748b;
  border-radius: 9px;
  background: #fff;
  padding: 9px 10px;
}
.priority-item strong {
  display: block;
  color: var(--t);
  font-size: 13px;
}
.priority-item p {
  margin: 4px 0 0;
  color: var(--t2);
  font-size: 12px;
  line-height: 1.55;
}
.priority-item.blue { border-left-color: #2563eb; background: #eff6ff; }
.priority-item.amber { border-left-color: #b45309; background: #fff7ed; }
.priority-item.green { border-left-color: #047857; background: #ecfdf5; }
.priority-item.cyan { border-left-color: #0891b2; background: #ecfeff; }
.priority-item.red { border-left-color: #b91c1c; background: #fef2f2; }
.priority-item.purple { border-left-color: #6d28d9; background: #f5f3ff; }
.profile-block {
  margin-top: 14px;
}
.profile-title {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}
.profile-title span {
  color: var(--t);
  font-size: 14px;
  font-weight: 900;
}
.profile-title b {
  color: var(--t3);
  font-size: 12px;
}
.profile-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}
.profile-item {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
  padding: 12px;
  min-height: 118px;
}
.profile-item span {
  display: block;
  color: var(--t3);
  font-size: 11px;
  font-weight: 900;
}
.profile-item strong {
  display: block;
  margin-top: 6px;
  color: var(--t);
  font-size: 22px;
}
.profile-item p {
  margin: 6px 0 0;
  color: var(--t2);
  font-size: 11px;
  line-height: 1.45;
}
.profile-item.strong {
  border-color: #fecaca;
  background: linear-gradient(180deg, #fff7f7, #fff);
}
.profile-item.medium {
  border-color: #fde68a;
  background: linear-gradient(180deg, #fffaf2, #fff);
}
.profile-item.low {
  border-color: #bfdbfe;
  background: linear-gradient(180deg, #f8fbff, #fff);
}
.profile-item.muted {
  background: #f8fafc;
}
.category-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  margin-top: 18px;
}
.category-pill {
  border: 1px solid var(--tone-line);
  border-radius: 12px;
  background: #fff;
  padding: 12px;
  text-align: left;
  cursor: pointer;
  box-shadow: inset 0 4px 0 var(--tone), 0 8px 20px rgba(15, 23, 42, .04);
  transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
}
.category-pill:hover {
  background: var(--tone-soft);
  box-shadow: inset 0 4px 0 var(--tone), 0 12px 24px rgba(15, 23, 42, .08);
  transform: translateY(-1px);
}
.category-pill span {
  display: block;
  color: var(--tone-dark);
  font-size: 12px;
  font-weight: 900;
}
.category-pill strong {
  display: block;
  margin-top: 6px;
  color: var(--tone);
  font-size: 22px;
}
.blue {
  --tone: #2563eb;
  --tone-dark: #1e40af;
  --tone-soft: #eff6ff;
  --tone-wash: #f8fbff;
  --tone-panel: linear-gradient(180deg, #f8fbff 0%, #fff 46%);
  --tone-line: #bfdbfe;
}
.amber {
  --tone: #b45309;
  --tone-dark: #92400e;
  --tone-soft: #fff7ed;
  --tone-wash: #fffaf2;
  --tone-panel: linear-gradient(180deg, #fffaf2 0%, #fff 48%);
  --tone-line: #fde68a;
}
.green {
  --tone: #047857;
  --tone-dark: #047857;
  --tone-soft: #ecfdf5;
  --tone-wash: #f3fcf8;
  --tone-panel: linear-gradient(180deg, #f3fcf8 0%, #fff 48%);
  --tone-line: #a7f3d0;
}
.cyan {
  --tone: #0891b2;
  --tone-dark: #0e7490;
  --tone-soft: #ecfeff;
  --tone-wash: #f1fcfe;
  --tone-panel: linear-gradient(180deg, #f1fcfe 0%, #fff 48%);
  --tone-line: #a5f3fc;
}
.red {
  --tone: #b91c1c;
  --tone-dark: #991b1b;
  --tone-soft: #fef2f2;
  --tone-wash: #fff7f7;
  --tone-panel: linear-gradient(180deg, #fff7f7 0%, #fff 48%);
  --tone-line: #fecaca;
}
.purple {
  --tone: #6d28d9;
  --tone-dark: #5b21b6;
  --tone-soft: #f5f3ff;
  --tone-wash: #faf8ff;
  --tone-panel: linear-gradient(180deg, #faf8ff 0%, #fff 48%);
  --tone-line: #ddd6fe;
}
.heatmap {
  display: grid;
  gap: 8px;
  overflow-x: auto;
}
.matrix-corner,
.matrix-head,
.matrix-region,
.matrix-cell {
  min-height: 62px;
  border-radius: 10px;
  border: 1px solid var(--border);
  padding: 10px;
}
.matrix-corner,
.matrix-head,
.matrix-region {
  background: #f8fafc;
  color: var(--t2);
  font-size: 12px;
  font-weight: 900;
  display: flex;
  align-items: center;
}
.matrix-head {
  justify-content: center;
  text-align: center;
}
.matrix-cell {
  text-align: left;
  cursor: pointer;
  color: var(--t);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.7);
  transition: transform .18s ease, box-shadow .18s ease;
}
.matrix-cell.active {
  outline: 2px solid rgba(37,99,235,.34);
  box-shadow: 0 10px 22px rgba(15, 23, 42, .08);
  transform: translateY(-1px);
}
.matrix-cell strong {
  display: block;
  font-size: 17px;
}
.matrix-cell span {
  display: block;
  margin-top: 6px;
  color: var(--t2);
  font-size: 11px;
  font-weight: 800;
}
.intel-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 20px;
}
.intel-card,
.action-panel,
.narrative-item {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
}
.intel-card {
  padding: 16px;
  border-color: var(--tone-line);
  background: var(--tone-panel);
  box-shadow: inset 0 4px 0 var(--tone), 0 10px 24px rgba(15, 23, 42, .045);
}
.card-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
}
.card-title-block {
  min-width: 0;
}
.card-head span {
  color: var(--tone-dark);
  font-size: 12px;
  font-weight: 900;
}
.card-head h3 {
  margin: 6px 0 0;
  color: var(--t);
  font-size: 16px;
  line-height: 1.35;
}
.card-score {
  flex: 0 0 auto;
  text-align: right;
}
.card-head h2 {
  margin: 0 0 6px;
  color: var(--t);
  font-size: 30px;
}
.card-head b {
  display: inline-flex;
  border-radius: 999px;
  background: var(--tone-soft);
  color: var(--tone-dark);
  border: 1px solid var(--tone-line);
  padding: 4px 9px;
  font-size: 12px;
}
.card-head b.red {
  background: #fef2f2;
  border-color: #fecaca;
  color: #991b1b;
}
.card-head b.green {
  background: #ecfdf5;
  border-color: #a7f3d0;
  color: #047857;
}
.card-head b.amber {
  background: #fff7ed;
  border-color: #fed7aa;
  color: #92400e;
}
.card-head b.cyan {
  background: #ecfeff;
  border-color: #a5f3fc;
  color: #0e7490;
}
.card-head b.purple {
  background: #f5f3ff;
  border-color: #ddd6fe;
  color: #5b21b6;
}
.card-head b.muted {
  background: #f8fafc;
  border-color: #e2e8f0;
  color: #64748b;
}
.decision-block {
  border: 1px solid var(--tone-line);
  border-radius: 10px;
  background: rgba(255,255,255,.78);
  padding: 10px;
  margin-top: 12px;
}
.decision-block span {
  display: block;
  color: var(--tone-dark);
  font-size: 11px;
  font-weight: 900;
}
.decision-block p {
  margin: 5px 0 0;
  color: var(--t);
  font-size: 13px;
  line-height: 1.65;
}
.decision-block.conclusion {
  background: #fff;
}
.object-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 7px;
}
.object-list i {
  border: 1px solid var(--tone-line);
  border-radius: 999px;
  background: rgba(255,255,255,.86);
  color: var(--tone-dark);
  padding: 4px 8px;
  font-size: 11px;
  font-style: normal;
  font-weight: 900;
}
.intel-note {
  border: 1px solid var(--tone-line);
  border-radius: 10px;
  background: rgba(255,255,255,.78);
  padding: 10px;
  margin-top: 10px;
}
.intel-note span {
  display: block;
  color: var(--tone-dark);
  font-size: 11px;
  font-weight: 900;
}
.intel-note p {
  margin: 5px 0 0;
  color: var(--t);
  font-size: 13px;
  line-height: 1.65;
}
.intel-note.next {
  background: #fff;
}
.intel-note.action {
  background: var(--tone-soft);
}
.intel-note.ai-card {
  background: linear-gradient(135deg, var(--tone-soft), #fff);
}
.intel-note.ai-card b {
  display: inline-flex;
  margin-top: 7px;
  border-radius: 999px;
  background: #fff;
  color: var(--tone-dark);
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 900;
}
.basis-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.basis-list i {
  border: 1px solid var(--tone-line);
  border-radius: 999px;
  background: rgba(255,255,255,.88);
  color: var(--t2);
  padding: 4px 8px;
  font-size: 11px;
  font-style: normal;
  font-weight: 850;
}
.step-list {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--t);
  font-size: 13px;
  line-height: 1.6;
}
.step-list li + li {
  margin-top: 3px;
}
.card-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: start;
  margin-top: 12px;
}
.status-pill {
  display: inline-flex;
  justify-content: center;
  border: 1px solid var(--tone-line);
  border-radius: 999px;
  background: var(--tone-soft);
  color: var(--tone-dark);
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 900;
  white-space: nowrap;
}
.status-pill.red { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
.status-pill.green { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
.status-pill.amber { background: #fff7ed; border-color: #fed7aa; color: #92400e; }
.status-pill.cyan { background: #ecfeff; border-color: #a5f3fc; color: #0e7490; }
.status-pill.purple { background: #f5f3ff; border-color: #ddd6fe; color: #5b21b6; }
.status-pill.muted { background: #f8fafc; border-color: #e2e8f0; color: #64748b; }
.library-list {
  display: flex;
  flex-wrap: wrap;
  flex: 1 1 180px;
  gap: 6px;
}
.library-list b {
  color: var(--t3);
  font-size: 11px;
  line-height: 24px;
}
.library-list i {
  border: 1px solid var(--tone-line);
  border-radius: 999px;
  background: #fff;
  color: var(--t2);
  padding: 4px 8px;
  font-size: 11px;
  font-style: normal;
  font-weight: 800;
}
.planned-list {
  flex-basis: 100%;
}
.planned-list b {
  color: #64748b;
}
.planned-list i {
  border-color: #e2e8f0;
  background: #f8fafc;
  color: #64748b;
}
.term-list,
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.term-list span,
.tag-list span {
  border-radius: 999px;
  border: 1px solid var(--tone-line, var(--border));
  background: rgba(255,255,255,.86);
  color: var(--t2);
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 800;
}
.read-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
}
.next-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.next-actions p {
  margin: 0;
  border-left: 4px solid #2563eb;
  border-radius: 8px;
  background: #eff6ff;
  padding: 12px;
  color: var(--t2);
  line-height: 1.65;
}
.next-actions p:nth-child(2) {
  border-left-color: #b45309;
  background: #fff7ed;
}
.next-actions p:nth-child(3) {
  border-left-color: #047857;
  background: #ecfdf5;
}
.structure-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.structure-grid h3 {
  margin: 0 0 12px;
  color: var(--t);
  font-size: 14px;
}
.bar-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.bar-row {
  display: grid;
  grid-template-columns: 96px 1fr 34px;
  gap: 8px;
  align-items: center;
  color: var(--t2);
  font-size: 12px;
}
.bar-row i {
  display: block;
  height: 8px;
  border-radius: 999px;
  background: linear-gradient(90deg, #2563eb, #0891b2);
}
.bar-row b {
  color: var(--t);
  text-align: right;
}
.entity-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.rank-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fff;
  padding: 10px;
  text-align: left;
  cursor: pointer;
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr) 36px;
  gap: 8px;
  align-items: center;
  box-shadow: 0 6px 16px rgba(15, 23, 42, .035);
}
.rank-row:nth-child(3n + 1) {
  border-left: 4px solid #2563eb;
}
.rank-row:nth-child(3n + 2) {
  border-left: 4px solid #0891b2;
}
.rank-row:nth-child(3n) {
  border-left: 4px solid #b45309;
}
.rank-row span {
  color: var(--t3);
  font-size: 11px;
  font-weight: 900;
}
.rank-row strong {
  color: var(--t);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-row b {
  color: #2563eb;
  text-align: right;
}
.narrative-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.narrative-item {
  padding: 12px;
  border-left: 4px solid #2563eb;
  background: linear-gradient(135deg, #eff6ff, #fff);
}
.narrative-item:nth-child(2) {
  border-left-color: #047857;
  background: linear-gradient(135deg, #ecfdf5, #fff);
}
.narrative-item:nth-child(3) {
  border-left-color: #b45309;
  background: linear-gradient(135deg, #fff7ed, #fff);
}
.narrative-item:nth-child(4) {
  border-left-color: #6d28d9;
  background: linear-gradient(135deg, #f5f3ff, #fff);
}
.narrative-item strong {
  display: block;
  color: var(--t);
  font-size: 13px;
}
.narrative-item p {
  margin: 8px 0;
  color: var(--t2);
  line-height: 1.6;
  font-size: 13px;
}
@media (max-width: 1180px) {
  .brief-hero,
  .battle-layout,
  .read-layout {
    grid-template-columns: 1fr;
  }
  .scope-switch,
  .category-strip,
  .intel-grid,
  .profile-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .scope-switch,
  .category-strip,
  .intel-grid,
  .profile-strip,
  .structure-grid,
  .entity-list {
    grid-template-columns: 1fr;
  }
}
</style>
