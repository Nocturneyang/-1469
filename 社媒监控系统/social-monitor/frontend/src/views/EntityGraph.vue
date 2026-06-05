<template>
  <div class="view-enter graph-page">
    <section class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">◎</span> 实体关系图谱</span>
        <div class="filters compact-filters">
          <select v-model="filters.days" class="form-control" @change="fetchGraph">
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
            <option value="90">近 90 天</option>
          </select>
          <select v-model="filters.region" class="form-control" @change="fetchGraph">
            <option value="">全部区域</option>
            <option v-for="r in facets.regions" :key="r" :value="r">{{ r }}</option>
          </select>
          <select v-model="filters.sector" class="form-control" @change="fetchGraph">
            <option value="">全部板块</option>
            <option v-for="s in facets.sectors" :key="s" :value="s">{{ s }}</option>
          </select>
          <select v-model="filters.type" class="form-control" @change="fetchGraph">
            <option value="">全部资产类型</option>
            <option v-for="t in facets.types" :key="t" :value="t">{{ typeLabel(t) }}</option>
          </select>
        </div>
      </div>

      <div class="graph-kpis">
        <div><strong>{{ graph.summary?.asset_count || 0 }}</strong><span>资产样本</span></div>
        <div><strong>{{ graph.summary?.node_count || 0 }}</strong><span>图谱节点</span></div>
        <div><strong>{{ graph.summary?.semantic_edge_count || 0 }}</strong><span>业务关系</span></div>
        <div><strong>{{ graph.active_view?.label || activeView.label }}</strong><span>当前视角</span></div>
      </div>

      <div class="view-tabs" role="tablist" aria-label="图谱视角">
        <button
          v-for="item in graphViews"
          :key="item.key"
          type="button"
          class="view-tab"
          :class="{ active: filters.view === item.key }"
          @click="changeView(item.key)"
        >
          <strong>{{ item.label }}</strong>
          <span>{{ item.description }}</span>
        </button>
      </div>
    </section>

    <div class="graph-layout">
      <aside class="panel graph-side">
        <div class="panel-title compact">
          <span class="title-text">中心对象</span>
        </div>
        <input
          v-model="centerKeyword"
          class="form-control"
          type="text"
          placeholder="搜索节点..."
        >
        <div class="center-list">
          <button
            v-for="item in filteredCenters"
            :key="item.id"
            type="button"
            class="center-row"
            :class="{ active: filters.center === item.id }"
            @click="focusCenter(item.id)"
          >
            <span>{{ item.type_label }}</span>
            <strong>{{ item.label }}</strong>
            <b>{{ item.weight }}</b>
          </button>
        </div>
      </aside>

      <section class="panel graph-canvas-panel">
        <div class="panel-title compact">
          <span class="title-text">关系拓扑</span>
          <div class="graph-actions">
            <button class="btn-secondary compact-btn" :disabled="!filters.center" @click="clearCenter">全局视图</button>
            <button class="btn-primary compact-btn" :disabled="!selectedNode" @click="focusCenter(selectedNode.id)">设为中心</button>
          </div>
        </div>

        <div v-if="loading" class="empty-state loading-pulse">加载实体关系...</div>
        <div v-else-if="graph.nodes.length === 0" class="empty-state">暂无图谱节点</div>
        <div v-else class="graph-shell">
          <svg viewBox="0 0 1000 620" class="topology" role="img" aria-label="实体关系拓扑图">
            <g class="edges">
              <line
                v-for="edge in positionedEdges"
                :key="edge.id"
                :x1="edge.x1"
                :y1="edge.y1"
                :x2="edge.x2"
                :y2="edge.y2"
                :stroke-width="edgeWidth(edge)"
                :class="{ highlighted: selectedNode && (edge.from === selectedNode.id || edge.to === selectedNode.id), semantic: edge.semantic }"
              />
            </g>
            <g class="nodes">
              <g
                v-for="node in positionedNodes"
                :key="node.id"
                class="graph-node"
                :class="{ selected: selectedNode?.id === node.id, center: filters.center === node.id }"
                :transform="`translate(${node.x}, ${node.y})`"
                @click="selectNode(node)"
                @dblclick="focusCenter(node.id)"
              >
                <circle :r="nodeRadius(node)" :fill="nodeColor(node.type)" />
                <text :y="nodeRadius(node) + 15" text-anchor="middle">{{ short(node.label, 16) }}</text>
                <text :y="nodeRadius(node) + 30" text-anchor="middle" class="node-type">{{ node.type_label }}</text>
              </g>
            </g>
          </svg>
        </div>
      </section>

      <aside class="panel graph-detail">
        <div class="panel-title compact">
          <span class="title-text">业务解读</span>
        </div>

        <template v-if="selectedNode">
          <div class="node-summary">
            <span class="tag purple">{{ selectedNode.type_label }}</span>
            <h2>{{ selectedNode.label }}</h2>
            <div class="node-metrics">
              <span>权重 <b>{{ selectedNode.weight }}</b></span>
              <span>资产 <b>{{ selectedNode.asset_count }}</b></span>
              <span>价值 <b>{{ selectedNode.value_score || 0 }}</b></span>
            </div>
          </div>

          <div class="brief-stack">
            <section class="brief-card main-brief">
              <span>结论</span>
              <p>{{ selectedNode.business_brief?.conclusion || '暂无业务解读' }}</p>
            </section>

            <section class="brief-card">
              <span>关键对象</span>
              <div v-if="selectedNode.business_brief?.key_objects?.length" class="object-chips">
                <b v-for="item in selectedNode.business_brief.key_objects" :key="`${item.type}-${item.label}`">
                  {{ item.type }} · {{ short(item.label, 18) }}
                </b>
              </div>
              <p v-else>暂未形成稳定关联对象。</p>
            </section>

            <section class="brief-card">
              <span>影响判断</span>
              <p>{{ selectedNode.business_brief?.impact || '需要结合更多来源资产判断。' }}</p>
            </section>

            <section class="brief-card next-card">
              <span>下一步</span>
              <ol>
                <li v-for="step in selectedNode.business_brief?.next_steps || []" :key="step">{{ step }}</li>
              </ol>
            </section>

            <section class="brief-card library-card">
              <span>沉淀去向</span>
              <div class="library-chips">
                <b v-for="library in selectedNode.business_brief?.target_libraries || []" :key="library">{{ library }}</b>
              </div>
            </section>
          </div>

          <div class="relation-list">
            <h3 class="section-heading">关键关系</h3>
            <article v-for="edge in selectedRelations" :key="edge.id" class="relation-card" :class="{ semantic: edge.semantic }">
              <div>
                <span>{{ edge.relation }}</span>
                <b>{{ edge.other?.type_label || '对象' }} · {{ edge.other?.label || '-' }}</b>
              </div>
              <p>{{ edge.business_meaning || '来自历史资产的关系证据。' }}</p>
              <footer>证据 {{ edge.evidence_count || edge.sources?.length || 0 }} · 权重 {{ edge.weight || 0 }} · 价值 {{ edge.value_score || 0 }}</footer>
            </article>
          </div>

          <div class="source-list">
            <h3 class="section-heading">来源资产</h3>
            <article v-for="source in selectedNode.sources" :key="`${source.source}-${source.id}`" class="source-card">
              <div class="source-head">
                <span class="tag slate">{{ source.asset_type_label }}</span>
                <b>{{ source.value_score || 0 }}分</b>
              </div>
              <h3>{{ source.title }}</h3>
              <p>{{ source.summary || '暂无摘要' }}</p>
              <footer>{{ source.collection_region || '未知区' }} / {{ source.business_sector || '未分类' }} · {{ source.group_name || '跨群汇总' }}</footer>
            </article>
          </div>
        </template>

        <div v-else class="empty-state compact-empty">点击节点查看证据</div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/utils/request'

const route = useRoute()
const TYPE_LABELS = {
  entity_relationship: '实体关系',
  operation_action: '处理动作',
  regional_intelligence: '区域情报',
  risk_pattern: '风险模式',
  sla_commitment: 'SLA履约',
  contact_role: '联系人',
  change_event: '变更事件',
  media_evidence: '媒体证据',
}

const DEFAULT_GRAPH_VIEWS = [
  { key: 'market', label: '市场情报', description: '国家、运营商、客户场景和需求热度' },
  { key: 'price', label: '价格情报', description: '报价、费率、成本和资源性价比' },
  { key: 'effect', label: '效果反馈', description: '测试、成功、失败、恢复反馈' },
  { key: 'resource', label: '资源情报', description: '设备、线路、Sender ID 和供应商资源' },
  { key: 'risk', label: '风险情报', description: '阻断、失败、超时、延迟风险' },
  { key: 'fulfillment', label: '履约情报', description: '承诺、ETA、联系人和完成结果' },
  { key: 'all', label: '全局图谱', description: '保留全部来源和共现上下文' },
]

const loading = ref(false)
const facets = ref({ types: [], sectors: [], regions: [] })
const filters = ref({
  days: '30',
  region: String(route.query.region || ''),
  sector: String(route.query.sector || ''),
  type: '',
  center: String(route.query.center || ''),
  view: String(route.query.view || 'market'),
})
const graph = ref({ nodes: [], edges: [], center_options: [], summary: {} })
const selectedNodeId = ref('')
const centerKeyword = ref('')

const typeLabel = (type) => TYPE_LABELS[type] || type || '-'
const short = (text, max) => {
  const value = String(text || '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
const nodeMap = computed(() => new Map((graph.value.nodes || []).map(node => [node.id, node])))
const selectedNode = computed(() => nodeMap.value.get(selectedNodeId.value) || nodeMap.value.get(filters.value.center) || graph.value.nodes?.[0] || null)
const graphViews = computed(() => graph.value.views?.length ? graph.value.views : DEFAULT_GRAPH_VIEWS)
const activeView = computed(() => graphViews.value.find(item => item.key === filters.value.view) || graphViews.value[0] || DEFAULT_GRAPH_VIEWS[0])
const filteredCenters = computed(() => {
  const keyword = centerKeyword.value.trim().toLowerCase()
  const rows = graph.value.center_options || []
  if (!keyword) return rows.slice(0, 24)
  return rows.filter(item => `${item.label} ${item.type_label}`.toLowerCase().includes(keyword)).slice(0, 24)
})
const selectedRelations = computed(() => {
  if (!selectedNode.value) return []
  return (graph.value.edges || [])
    .filter(edge => edge.from === selectedNode.value.id || edge.to === selectedNode.value.id)
    .map(edge => {
      const otherId = edge.from === selectedNode.value.id ? edge.to : edge.from
      return { ...edge, other: nodeMap.value.get(otherId) }
    })
    .sort((a, b) => Number(b.semantic) - Number(a.semantic) || (Number(b.value_score || 0) - Number(a.value_score || 0)) || (Number(b.weight || 0) - Number(a.weight || 0)))
    .slice(0, 8)
})

const positionedNodes = computed(() => {
  const nodes = graph.value.nodes || []
  if (!nodes.length) return []
  const centerId = filters.value.center && nodeMap.value.has(filters.value.center) ? filters.value.center : nodes[0].id
  const center = nodes.find(node => node.id === centerId)
  const rest = nodes.filter(node => node.id !== centerId)
  const typeIndex = new Map()
  const typeOrder = ['region', 'sector', 'supplier', 'customer', 'group', 'country', 'operator', 'device_model', 'route', 'sender_id', 'contact', 'role', 'action', 'outcome', 'risk_signal', 'issue_term', 'change', 'media', 'library', 'asset_type']
  typeOrder.forEach((type, index) => typeIndex.set(type, index))
  const sorted = rest.slice().sort((a, b) => (typeIndex.get(a.type) ?? 99) - (typeIndex.get(b.type) ?? 99) || b.weight - a.weight)
  const out = center ? [{ ...center, x: 500, y: 300 }] : []
  sorted.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, sorted.length) - Math.PI / 2
    const ring = 205 + ((typeIndex.get(node.type) ?? index) % 3) * 58
    out.push({
      ...node,
      x: Math.round(500 + Math.cos(angle) * ring),
      y: Math.round(300 + Math.sin(angle) * ring * 0.82),
    })
  })
  return out
})

const positionMap = computed(() => new Map(positionedNodes.value.map(node => [node.id, node])))
const positionedEdges = computed(() => (graph.value.edges || [])
  .map(edge => {
    const from = positionMap.value.get(edge.from)
    const to = positionMap.value.get(edge.to)
    if (!from || !to) return null
    return { ...edge, x1: from.x, y1: from.y, x2: to.x, y2: to.y }
  })
  .filter(Boolean))

const nodeColor = (type) => ({
  region: '#0e7490',
  sector: '#4f46e5',
  group: '#64748b',
  operator: '#059669',
  device_model: '#2563eb',
  route: '#7c3aed',
  sender_id: '#9333ea',
  customer: '#0369a1',
  supplier: '#0f766e',
  contact: '#c2410c',
  role: '#d97706',
  action: '#16a34a',
  risk_signal: '#dc2626',
  issue_term: '#ea580c',
  change: '#b45309',
  media: '#475569',
  outcome: '#15803d',
  library: '#7c2d12',
  asset_type: '#6b46c1',
})[type] || '#334155'

const nodeRadius = (node) => Math.max(14, Math.min(30, 12 + Math.sqrt(Number(node.weight || 1)) * 2.4))
const edgeWidth = (edge) => Math.max(1, Math.min(7, 1 + Math.sqrt(Number(edge.weight || 1))))

const selectNode = (node) => {
  selectedNodeId.value = node.id
}

const focusCenter = async (id) => {
  filters.value.center = id
  selectedNodeId.value = id
  await fetchGraph()
}

const clearCenter = async () => {
  filters.value.center = ''
  selectedNodeId.value = ''
  await fetchGraph()
}

const changeView = async (view) => {
  filters.value.view = view
  filters.value.center = ''
  selectedNodeId.value = ''
  await fetchGraph()
}

const fetchFacets = async () => {
  const res = await api.get('/api/knowledge-assets/facets')
  if (res.success) facets.value = res.data || facets.value
}

const fetchGraph = async () => {
  loading.value = true
  try {
    const res = await api.get('/api/knowledge-assets/entity-graph', { params: filters.value })
    if (res.success) {
      graph.value = res.data || { nodes: [], edges: [], center_options: [], summary: {} }
      selectedNodeId.value = filters.value.center && nodeMap.value.has(filters.value.center)
        ? filters.value.center
        : graph.value.center?.id || graph.value.nodes?.[0]?.id || ''
    }
  } finally {
    loading.value = false
  }
}

watch(() => route.query.center, (value) => {
  if (value && value !== filters.value.center) {
    filters.value.center = String(value)
    fetchGraph()
  }
})

watch(() => route.query.view, (value) => {
  if (value && value !== filters.value.view) {
    filters.value.view = String(value)
    fetchGraph()
  }
})

onMounted(async () => {
  await fetchFacets()
  await fetchGraph()
})
</script>

<style scoped>
.compact-filters {
  justify-content: flex-end;
  margin: 0;
}
.compact-filters .form-control {
  max-width: 155px;
}
.graph-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}
.graph-kpis div {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
  padding: 14px;
}
.graph-kpis strong {
  display: block;
  color: var(--t);
  font-size: 22px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.graph-kpis span {
  display: block;
  margin-top: 6px;
  color: var(--t3);
  font-size: 12px;
  font-weight: 800;
}
.view-tabs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: 10px;
  margin-top: 14px;
}
.view-tab {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
  padding: 12px;
  text-align: left;
  cursor: pointer;
  transition: .18s ease;
}
.view-tab strong {
  display: block;
  color: var(--t);
  font-size: 13px;
}
.view-tab span {
  display: block;
  margin-top: 6px;
  color: var(--t3);
  font-size: 11px;
  font-weight: 800;
  line-height: 1.45;
}
.view-tab.active {
  border-color: rgba(37, 99, 235, .42);
  background: linear-gradient(180deg, rgba(37,99,235,.08), #fff);
  box-shadow: inset 0 3px 0 rgba(37,99,235,.72);
}
.graph-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 320px;
  gap: 16px;
  align-items: start;
}
.graph-side,
.graph-detail {
  margin-bottom: 0;
  max-height: calc(100vh - 140px);
  overflow: auto;
}
.center-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.center-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 5px 8px;
  align-items: start;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fff;
  padding: 10px;
  text-align: left;
  cursor: pointer;
}
.center-row.active {
  border-color: rgba(107,70,193,.35);
  background: rgba(107,70,193,.06);
}
.center-row span {
  color: var(--t3);
  font-size: 11px;
  font-weight: 800;
}
.center-row strong {
  grid-column: 1 / -1;
  color: var(--t);
  font-size: 13px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
  word-break: break-word;
}
.center-row b {
  grid-column: 2;
  grid-row: 1;
  color: #0e7490;
  text-align: right;
}
.graph-canvas-panel {
  min-height: 680px;
}
.graph-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
.compact-btn {
  padding: 7px 10px;
  border-radius: 10px;
}
.compact-btn:disabled {
  opacity: .48;
  cursor: not-allowed;
}
.graph-shell {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: linear-gradient(180deg, #fbfdff 0%, #fff 100%);
  overflow: hidden;
}
.topology {
  display: block;
  width: 100%;
  min-height: 610px;
}
.edges line {
  stroke: rgba(100, 116, 139, .32);
  stroke-linecap: round;
}
.edges line.semantic {
  stroke: rgba(14, 116, 144, .42);
}
.edges line.highlighted {
  stroke: rgba(107,70,193,.62);
}
.graph-node {
  cursor: pointer;
}
.graph-node circle {
  stroke: #fff;
  stroke-width: 4;
  filter: drop-shadow(0 6px 10px rgba(45,55,72,.18));
}
.graph-node.selected circle,
.graph-node.center circle {
  stroke: #facc15;
  stroke-width: 5;
}
.graph-node text {
  fill: var(--t);
  font-size: 13px;
  font-weight: 800;
  paint-order: stroke;
  stroke: #fff;
  stroke-width: 4px;
  stroke-linejoin: round;
}
.graph-node .node-type {
  fill: var(--t3);
  font-size: 10px;
  font-weight: 800;
}
.node-summary {
  border-bottom: 1px solid var(--border);
  padding-bottom: 14px;
  margin-bottom: 14px;
}
.node-summary h2 {
  margin: 10px 0;
  color: var(--t);
  font-size: 20px;
  line-height: 1.3;
}
.node-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.node-metrics span {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px;
  color: var(--t3);
  font-size: 11px;
  font-weight: 800;
}
.node-metrics b {
  display: block;
  color: var(--t);
  font-size: 16px;
  margin-top: 3px;
}
.brief-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}
.brief-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
  padding: 12px;
}
.brief-card.main-brief {
  border-color: rgba(37, 99, 235, .24);
  background: linear-gradient(180deg, rgba(37,99,235,.06), #fff);
}
.brief-card span,
.section-heading {
  display: block;
  margin: 0 0 8px;
  color: #475569;
  font-size: 12px;
  font-weight: 900;
}
.brief-card p {
  margin: 0;
  color: var(--t);
  font-size: 13px;
  line-height: 1.65;
  font-weight: 750;
}
.object-chips,
.library-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.object-chips b,
.library-chips b {
  border: 1px solid rgba(14, 116, 144, .22);
  border-radius: 999px;
  background: rgba(14, 116, 144, .07);
  color: #0f766e;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 900;
}
.library-chips b {
  border-color: rgba(124, 45, 18, .2);
  background: rgba(124, 45, 18, .06);
  color: #9a3412;
}
.next-card ol {
  margin: 0;
  padding-left: 18px;
}
.next-card li {
  color: var(--t);
  font-size: 13px;
  line-height: 1.6;
  font-weight: 760;
}
.relation-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}
.relation-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
  padding: 12px;
}
.relation-card.semantic {
  border-color: rgba(14, 116, 144, .28);
  background: linear-gradient(180deg, rgba(14,116,144,.06), #fff);
}
.relation-card div {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.relation-card span {
  border-radius: 999px;
  background: rgba(79, 70, 229, .08);
  color: #4338ca;
  padding: 4px 7px;
  font-size: 11px;
  font-weight: 900;
  white-space: nowrap;
}
.relation-card b {
  color: var(--t);
  font-size: 12px;
  line-height: 1.35;
  text-align: right;
}
.relation-card p {
  margin: 9px 0 0;
  color: var(--t2);
  font-size: 12px;
  line-height: 1.55;
}
.relation-card footer {
  margin-top: 8px;
  color: var(--t3);
  font-size: 11px;
  font-weight: 800;
}
.source-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.source-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: #fff;
  padding: 12px;
}
.source-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.source-head b {
  color: #b45309;
  font-size: 12px;
}
.source-card h3 {
  margin: 8px 0 6px;
  color: var(--t);
  font-size: 14px;
  line-height: 1.35;
}
.source-card p {
  margin: 0;
  color: var(--t2);
  font-size: 12px;
  line-height: 1.55;
}
.source-card footer {
  margin-top: 10px;
  color: var(--t3);
  font-size: 11px;
}
@media (max-width: 1280px) {
  .graph-layout {
    grid-template-columns: 240px minmax(0, 1fr);
  }
  .graph-detail {
    grid-column: 1 / -1;
    max-height: none;
  }
}
@media (max-width: 860px) {
  .graph-layout,
  .graph-kpis,
  .view-tabs {
    grid-template-columns: 1fr;
  }
  .graph-side {
    max-height: none;
  }
}
</style>
