<template>
  <div class="view-enter domain-intel-page">
    <section class="panel domain-hero" :class="profile.tone || 'blue'">
      <div class="panel-title">
        <span class="title-text">{{ profile.title || pageFallbackTitle }}</span>
        <div class="filters compact-filters">
          <select v-model="filters.days" class="form-control" @change="fetchData">
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
            <option value="90">近 90 天</option>
          </select>
        </div>
      </div>

      <div class="hero-content">
        <div>
          <span class="eyebrow">{{ profile.short_title || '专项' }}情报</span>
          <h1>{{ data.brief?.title || pageFallbackTitle }}</h1>
          <p>{{ data.brief?.summary || profile.subtitle || '等待更多样本形成专项情报。' }}</p>
        </div>
        <div class="hero-metrics">
          <span><b>{{ fmt(data.summary?.message_count) }}</b>消息</span>
          <span><b>{{ fmt(data.summary?.asset_count) }}</b>资产</span>
          <span><b>{{ fmt(data.summary?.high_value) }}</b>高价值</span>
          <span><b>{{ fmt(data.summary?.active_group_count) }}</b>活跃群</span>
        </div>
      </div>

      <div v-if="data.ai_judgment" class="ai-summary" :class="aiStatusClass">
        <div class="ai-title">
          <span>AI判断</span>
          <i>{{ aiStatusText }} · {{ data.ai_judgment.model || '未配置模型' }}</i>
        </div>
        <p>{{ data.ai_judgment.summary || data.ai_judgment.judgment }}</p>
        <div class="ai-tags">
          <b :class="priorityClass(data.ai_judgment.priority)">{{ priorityText(data.ai_judgment.priority) }}</b>
          <span>{{ fmtConfidence(data.ai_judgment.confidence) }}</span>
          <span v-for="item in aiReasons" :key="item">{{ item }}</span>
        </div>
      </div>
    </section>

    <section v-if="loading" class="panel empty-state loading-pulse">加载{{ pageFallbackTitle }}...</section>

    <section v-else class="focus-grid">
      <article v-for="card in data.cards" :key="card.label" class="focus-card" :class="card.tone">
        <div class="focus-head">
          <span>{{ card.label }}</span>
          <strong>{{ fmt(card.value) }}</strong>
        </div>
        <div class="card-block">
          <b>上下文总结</b>
          <p>{{ card.ai_summary || card.summary }}</p>
        </div>
        <div v-if="basisItems(card).length" class="card-block basis-block">
          <b>判断依据</b>
          <div class="basis-list">
            <i v-for="item in basisItems(card)" :key="item">{{ item }}</i>
          </div>
        </div>
        <div v-if="card.ai_judgment" class="card-block ai-card">
          <b>AI判断</b>
          <p>{{ card.ai_judgment }}</p>
          <span>{{ priorityText(card.ai_priority) }} · {{ fmtConfidence(card.ai_confidence) }}</span>
        </div>
        <div class="action-box">
          <b>建议动作</b>
          <span>{{ card.action }}</span>
        </div>
        <div class="meta-list">
          <i v-for="item in card.meta" :key="item">{{ item }}</i>
        </div>
      </article>
    </section>

    <div class="read-layout">
      <section class="panel">
        <div class="panel-title compact">
          <span class="title-text">优先处理清单</span>
          <span class="hint">按专项目标生成</span>
        </div>
        <div class="priority-list">
          <p v-for="item in data.priority_actions" :key="item">{{ item }}</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-title compact">
          <span class="title-text">沉淀去向</span>
          <span class="hint">{{ profile.primary_library_label || '知识库' }}</span>
        </div>
        <div class="flow-list">
          <div v-for="item in data.knowledge_flow" :key="item.key" class="flow-row">
            <span>{{ item.label || item.key }}</span>
            <i :style="{ width: barWidth(item.count, data.summary?.asset_count) }"></i>
            <b>{{ item.count }}</b>
          </div>
        </div>
      </section>
    </div>

    <div class="read-layout">
      <section class="panel">
        <div class="panel-title compact">
          <span class="title-text">{{ listTitleLeft }}</span>
          <span class="hint">高频对象</span>
        </div>
        <div class="rank-grid">
          <div v-for="item in primaryList" :key="item.key" class="rank-item">
            <span>{{ item.label || item.key }}</span>
            <b>{{ item.count }}</b>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-title compact">
          <span class="title-text">{{ listTitleRight }}</span>
          <span class="hint">处理与风险</span>
        </div>
        <div class="rank-grid">
          <div v-for="item in secondaryList" :key="item.key" class="rank-item">
            <span>{{ item.label || item.key }}</span>
            <b>{{ item.count }}</b>
          </div>
        </div>
      </section>
    </div>

  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/utils/request'

const route = useRoute()
const loading = ref(false)
const filters = reactive({ days: '30' })
let requestSeq = 0
const data = ref({
  profile: {},
  brief: {},
  summary: {},
  ai_judgment: null,
  cards: [],
  priority_actions: [],
  knowledge_flow: [],
  top_groups: [],
  top_actions: [],
  top_risks: [],
  top_roles: [],
  top_contacts: [],
  top_resources: [],
})

const kind = computed(() => route.meta.domainKind || 'customer_service')
const profile = computed(() => data.value.profile || {})
const pageFallbackTitle = computed(() => kind.value === 'device_tech' ? '设备技术情报' : '客服运营情报')
const listTitleLeft = computed(() => kind.value === 'device_tech' ? '设备/资源对象' : '客户群与角色')
const listTitleRight = computed(() => kind.value === 'device_tech' ? '动作与风险' : '动作与风险')
const primaryList = computed(() => {
  if (kind.value === 'device_tech') return (data.value.top_resources?.length ? data.value.top_resources : data.value.top_groups).slice(0, 10)
  return [...(data.value.top_groups || []).slice(0, 5), ...(data.value.top_roles || []).slice(0, 5)]
})
const secondaryList = computed(() => {
  const rows = [...(data.value.top_actions || []).slice(0, 5), ...(data.value.top_risks || []).slice(0, 5)]
  return rows.slice(0, 10)
})
const aiStatusClass = computed(() => data.value.ai_judgment?.status || 'fallback')
const aiStatusText = computed(() => {
  const status = data.value.ai_judgment?.status
  if (status === 'ready') return '已参与'
  if (status === 'loading') return '生成中'
  if (status === 'not_configured') return '未配置'
  if (status === 'disabled') return '已关闭'
  return '规则降级'
})
const aiReasons = computed(() => (data.value.ai_judgment?.reasons || []).slice(0, 3))

const fmt = (value) => Number(value || 0).toLocaleString('zh-CN')
const barWidth = (count, total) => `${Math.max(8, Math.min(100, (Number(count || 0) / Math.max(1, Number(total || 1))) * 100))}%`
const basisItems = (card) => {
  const basis = card?.basis || []
  const objects = (card?.objects || []).map((item) => String(item || '').startsWith('对象') ? item : `对象：${item}`)
  return [...new Set([...basis, ...objects])].filter(Boolean).slice(0, 6)
}
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
const pendingAiJudgment = (base = {}) => ({
  enabled: false,
  status: 'loading',
  model: base.model || '模型配置',
  summary: 'AI 判断生成中，当前先展示规则抽取和确定性总结。',
  judgment: '等待模型二次判断。',
  priority: 'medium',
  confidence: 0,
  reasons: ['规则层已先提取对话对象、集中群和代表信号'],
})

const fetchData = async () => {
  const seq = ++requestSeq
  loading.value = true
  try {
    const res = await api.get('/api/knowledge-assets/intelligence/domain-dashboard', {
      params: { kind: kind.value, days: filters.days, ai: 0 },
    })
    if (seq !== requestSeq) return
    if (res.success) {
      data.value = {
        ...(res.data || data.value),
        ai_judgment: pendingAiJudgment(res.data?.ai_judgment || {}),
      }
      fetchAiData(seq)
    }
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

const fetchAiData = async (seq) => {
  try {
    const res = await api.get('/api/knowledge-assets/intelligence/domain-dashboard', {
      params: { kind: kind.value, days: filters.days },
    })
    if (seq === requestSeq && res.success) data.value = res.data || data.value
  } catch (_) {
    if (seq === requestSeq) {
      data.value = {
        ...data.value,
        ai_judgment: {
          ...data.value.ai_judgment,
          status: 'fallback',
          summary: 'AI 判断暂未返回，当前展示为规则抽取和确定性总结。',
        },
      }
    }
  }
}

watch(kind, fetchData)
onMounted(fetchData)
</script>

<style scoped>
.domain-intel-page {
  --tone: #2563eb;
  --tone-dark: #1d4ed8;
  --tone-soft: #eff6ff;
  --tone-line: #bfdbfe;
}
.compact-filters {
  margin: 0;
  justify-content: flex-end;
}
.compact-filters .form-control {
  max-width: 150px;
}
.domain-hero {
  background: linear-gradient(135deg, var(--tone-soft), #fff 55%);
  border-color: var(--tone-line);
  box-shadow: 0 12px 30px rgba(15, 23, 42, .06);
}
.domain-hero.cyan {
  --tone: #0891b2;
  --tone-dark: #0e7490;
  --tone-soft: #ecfeff;
  --tone-line: #a5f3fc;
}
.hero-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 20px;
  align-items: stretch;
  margin-top: 18px;
}
.eyebrow {
  display: inline-flex;
  border: 1px solid var(--tone-line);
  border-radius: 999px;
  background: #fff;
  color: var(--tone-dark);
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 900;
}
.hero-content h1 {
  margin: 10px 0;
  color: var(--t);
  font-size: 28px;
  line-height: 1.25;
}
.hero-content p {
  margin: 0;
  color: var(--t2);
  line-height: 1.8;
}
.hero-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.hero-metrics span {
  border: 1px solid var(--tone-line);
  border-radius: 12px;
  background: rgba(255,255,255,.82);
  padding: 12px;
  color: var(--t3);
  font-size: 12px;
  font-weight: 900;
}
.hero-metrics b {
  display: block;
  color: var(--t);
  font-size: 24px;
}
.ai-summary {
  margin-top: 16px;
  border: 1px solid var(--tone-line);
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
  color: var(--tone-dark);
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
  border: 1px solid var(--tone-line);
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
.focus-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
.focus-card,
.asset-item {
  border: 1px solid var(--tone-line);
  border-radius: 12px;
  background: #fff;
}
.focus-card {
  padding: 14px;
  box-shadow: inset 0 4px 0 var(--tone), 0 10px 24px rgba(15, 23, 42, .045);
}
.focus-card.blue { --tone: #2563eb; --tone-dark: #1d4ed8; --tone-line: #bfdbfe; --tone-soft: #eff6ff; }
.focus-card.cyan { --tone: #0891b2; --tone-dark: #0e7490; --tone-line: #a5f3fc; --tone-soft: #ecfeff; }
.focus-card.green { --tone: #047857; --tone-dark: #047857; --tone-line: #a7f3d0; --tone-soft: #ecfdf5; }
.focus-card.red { --tone: #b91c1c; --tone-dark: #991b1b; --tone-line: #fecaca; --tone-soft: #fef2f2; }
.focus-card.amber { --tone: #b45309; --tone-dark: #92400e; --tone-line: #fde68a; --tone-soft: #fff7ed; }
.focus-card.purple { --tone: #6d28d9; --tone-dark: #5b21b6; --tone-line: #ddd6fe; --tone-soft: #f5f3ff; }
.focus-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.focus-head span {
  color: var(--tone-dark);
  font-size: 12px;
  font-weight: 900;
}
.focus-head strong {
  color: var(--t);
  font-size: 28px;
}
.card-block {
  border: 1px solid var(--tone-line);
  border-radius: 10px;
  background: rgba(255,255,255,.76);
  padding: 10px;
  margin: 10px 0;
}
.card-block b {
  display: block;
  color: var(--tone-dark);
  font-size: 11px;
  font-weight: 900;
}
.card-block p {
  color: var(--t2);
  font-size: 13px;
  line-height: 1.65;
  margin: 6px 0 0;
}
.basis-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.basis-list i {
  border: 1px solid var(--tone-line);
  border-radius: 999px;
  background: var(--tone-soft);
  color: var(--tone-dark);
  padding: 4px 8px;
  font-size: 11px;
  font-style: normal;
  font-weight: 800;
}
.ai-card {
  background: linear-gradient(135deg, var(--tone-soft), #fff);
}
.ai-card span {
  display: inline-flex;
  margin-top: 7px;
  border-radius: 999px;
  background: #fff;
  color: var(--tone-dark);
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 900;
}
.action-box {
  border: 1px solid var(--tone-line);
  border-radius: 10px;
  background: var(--tone-soft);
  padding: 10px;
}
.action-box b,
.action-box span {
  display: block;
}
.action-box b {
  color: var(--tone-dark);
  font-size: 11px;
}
.action-box span {
  margin-top: 5px;
  color: var(--t);
  font-size: 13px;
  line-height: 1.55;
}
.meta-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.meta-list i {
  border: 1px solid var(--tone-line);
  border-radius: 999px;
  background: #fff;
  color: var(--t2);
  padding: 4px 8px;
  font-size: 11px;
  font-style: normal;
  font-weight: 800;
}
.read-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  margin-bottom: 18px;
}
.priority-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.priority-list p {
  margin: 0;
  border-left: 4px solid #2563eb;
  border-radius: 8px;
  background: #eff6ff;
  padding: 12px;
  color: var(--t2);
  line-height: 1.65;
}
.priority-list p:nth-child(2) { border-left-color: #047857; background: #ecfdf5; }
.priority-list p:nth-child(3) { border-left-color: #b45309; background: #fff7ed; }
.priority-list p:nth-child(4) { border-left-color: #6d28d9; background: #f5f3ff; }
.flow-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.flow-row {
  display: grid;
  grid-template-columns: 110px 1fr 42px;
  gap: 8px;
  align-items: center;
  color: var(--t2);
  font-size: 12px;
}
.flow-row i {
  height: 8px;
  border-radius: 999px;
  background: linear-gradient(90deg, #2563eb, #0891b2);
}
.flow-row b {
  color: var(--t);
  text-align: right;
}
.rank-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.rank-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px;
  gap: 8px;
  border: 1px solid var(--border);
  border-left: 4px solid #0891b2;
  border-radius: 10px;
  background: #fff;
  padding: 10px;
  align-items: center;
}
.rank-item span {
  color: var(--t);
  font-size: 13px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-item b {
  color: #2563eb;
  text-align: right;
}
.asset-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.asset-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  gap: 12px;
  padding: 14px;
}
.asset-type {
  display: inline-flex;
  border-radius: 999px;
  background: #f8fafc;
  color: var(--t3);
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 900;
}
.asset-item h3 {
  margin: 8px 0 6px;
  color: var(--t);
  font-size: 15px;
}
.asset-item p {
  margin: 0;
  color: var(--t2);
  line-height: 1.6;
  font-size: 13px;
}
.asset-item footer {
  margin-top: 8px;
  color: var(--t3);
  font-size: 11px;
  font-weight: 800;
}
.asset-item strong {
  color: #2563eb;
  font-size: 20px;
  text-align: right;
}
@media (max-width: 1180px) {
  .hero-content,
  .read-layout {
    grid-template-columns: 1fr;
  }
  .focus-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .hero-metrics,
  .focus-grid,
  .rank-grid,
  .asset-list {
    grid-template-columns: 1fr;
  }
}
</style>
