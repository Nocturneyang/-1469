<template>
  <div class="view-enter asset-workbench">
    <section class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">🧭</span> 知识资产发现</span>
        <div class="title-actions">
          <span class="hint">AI 先自动分流和沉淀，人工只复核少量不确定资产</span>
          <button class="btn-secondary compact-btn" :disabled="exporting" @click="exportAssets">
            {{ exporting ? '导出中...' : '导出候选' }}
          </button>
        </div>
      </div>

      <div v-if="summary.ready" class="summary-grid">
        <div class="summary-card">
          <strong>{{ formatNum(summary.total) }}</strong>
          <span>候选资产</span>
        </div>
        <div class="summary-card formal">
          <strong>{{ formatNum(formalSummary.total) }}</strong>
          <span>正式资产</span>
        </div>
        <div class="summary-card hot">
          <strong>{{ formatNum(summary.highValue) }}</strong>
          <span>高价值候选</span>
        </div>
        <div class="summary-card ai">
          <strong>{{ formatNum(summary.machineHandled) }}</strong>
          <span>AI已处理</span>
        </div>
        <div class="summary-card">
          <strong>{{ formatNum(summary.manualPending ?? summary.pending) }}</strong>
          <span>需人工复核</span>
        </div>
        <div class="summary-card">
          <strong>{{ formatNum(summary.confirmed) }}</strong>
          <span>已确认</span>
        </div>
      </div>

      <div v-if="summary.byType?.length" class="type-strip">
        <button
          v-for="item in summary.byType"
          :key="item.asset_type"
          type="button"
          class="type-chip"
          :class="{ active: filters.type === item.asset_type }"
          @click="toggleType(item.asset_type)"
        >
          <span>{{ typeLabel(item.asset_type) }}</span>
          <strong>{{ formatNum(item.count) }}</strong>
        </button>
      </div>

      <div v-if="summary.byInteraction?.length" class="interaction-strip">
        <button
          v-for="item in summary.byInteraction"
          :key="item.interaction_side || 'unknown'"
          type="button"
          class="interaction-card"
          :class="{ active: filters.interaction === item.interaction_side }"
          @click="toggleInteraction(item.interaction_side)"
        >
          <strong>{{ item.interaction_label || interactionLabel(item.interaction_side) }}</strong>
          <span>{{ formatNum(item.count) }} 条资产 · {{ formatNum(item.needs_review) }} 条需人工</span>
        </button>
      </div>

      <div class="filters">
        <input
          v-model="filters.keyword"
          type="text"
          class="form-control"
          style="flex: 1; min-width: 220px"
          placeholder="搜索客户/运营商/群名/证据/动作..."
          @keyup.enter="search"
        >
        <select v-model="filters.type" class="form-control" @change="search">
          <option value="">全部类型</option>
          <option v-for="t in facets.types" :key="t" :value="t">{{ typeLabel(t) }}</option>
        </select>
        <select v-model="filters.sector" class="form-control" @change="search">
          <option value="">全部板块</option>
          <option v-for="s in facets.sectors" :key="s" :value="s">{{ s }}</option>
        </select>
        <select v-model="filters.region" class="form-control" @change="search">
          <option value="">全部区域</option>
          <option v-for="r in facets.regions" :key="r" :value="r">{{ r }}</option>
        </select>
        <select v-model="filters.interaction" class="form-control" @change="search">
          <option value="">全部交互侧</option>
          <option value="resource_provider">资源提供方交互</option>
          <option value="resource_user">资源使用方交互</option>
          <option value="other">其他交互</option>
        </select>
        <select v-model="filters.machineDecision" class="form-control" @change="search">
          <option value="">全部机器结论</option>
          <option value="auto_ready">可自动沉淀</option>
          <option value="auto_index">自动索引</option>
          <option value="auto_insight">自动情报</option>
          <option value="needs_human_review">需人工复核</option>
        </select>
        <select v-model="filters.manualReview" class="form-control" @change="search">
          <option value="">全部处理方式</option>
          <option value="1">只看需人工</option>
          <option value="0">机器已判断</option>
        </select>
        <select v-model="filters.status" class="form-control" @change="search">
          <option value="">全部状态</option>
          <option value="pending_review">待审核</option>
          <option value="confirmed">已确认</option>
          <option value="rejected">已废弃</option>
          <option value="merged">已合并</option>
        </select>
        <select v-model="filters.effective" class="form-control" @change="search">
          <option value="">全部动作效果</option>
          <option value="1">动作有效</option>
          <option value="0">动作无明确恢复</option>
          <option value="checked">动作已验证</option>
        </select>
        <select v-model="filters.sort" class="form-control" @change="search">
          <option value="value">按价值</option>
          <option value="confidence">按置信度</option>
          <option value="recent">按最近出现</option>
          <option value="frequency">按频次</option>
        </select>
        <button class="btn-primary" @click="search">搜索</button>
      </div>
    </section>

    <section v-if="formalSummary.ready" class="panel">
      <div class="panel-title compact">
        <span class="title-text">正式资产库</span>
        <span class="hint">已审核确认并沉淀，可被供应商画像、告警和处理建议调用</span>
      </div>
      <div v-if="formalSummary.byType?.length" class="type-strip">
        <button
          v-for="item in formalSummary.byType"
          :key="item.asset_type"
          type="button"
          class="type-chip"
          @click="loadFormalByType(item.asset_type)"
        >
          <span>{{ typeLabel(item.asset_type) }}</span>
          <strong>{{ formatNum(item.count) }}</strong>
        </button>
      </div>
      <div v-if="formalAssets.length" class="formal-grid">
        <article v-for="item in formalAssets.slice(0, 8)" :key="item.asset_uid" class="formal-card">
          <div class="asset-head">
            <span class="asset-type">{{ typeLabel(item.asset_type) }}</span>
            <span class="value-pill high">{{ item.asset_value_score || 0 }}分</span>
          </div>
          <h3>{{ item.title }}</h3>
          <p>{{ item.summary || '暂无摘要' }}</p>
          <div class="asset-meta">
            <span>{{ item.collection_region || '未知区' }}</span>
            <span>{{ item.business_sector || '未分类' }}</span>
            <span>{{ item.group_name || '跨群资产' }}</span>
            <span>质量 {{ item.quality_score || 0 }}</span>
          </div>
        </article>
      </div>
      <div v-else class="empty-state compact-empty">暂无正式资产。确认候选资产后会自动沉淀到这里。</div>
    </section>

    <section v-if="regionalIntel.length" class="panel">
      <div class="panel-title compact">
        <span class="title-text">区域/板块情报</span>
        <span class="hint">近 30 天按区域和业务类型聚合，辅助判断哪里最值得先沉淀</span>
      </div>
      <div class="intel-grid">
        <button
          v-for="item in regionalIntel.slice(0, 8)"
          :key="`${item.collection_region}-${item.business_sector}`"
          type="button"
          class="intel-card"
          @click="applyIntelFilter(item)"
        >
          <div class="intel-head">
            <strong>{{ item.collection_region || '未知区' }}</strong>
            <span>{{ item.business_sector || '未分类' }}</span>
          </div>
          <div class="intel-metrics">
            <span><b>{{ item.total || 0 }}</b> 总量</span>
            <span><b>{{ item.high_value || 0 }}</b> 高价值</span>
            <span><b>{{ item.risk_count || 0 }}</b> 风险</span>
            <span><b>{{ item.cross_region_count || 0 }}</b> 跨区</span>
          </div>
          <div class="mini-bars">
            <i
              v-for="type in item.top_types"
              :key="type.asset_type"
              :style="{ width: `${Math.max(42, Math.min(100, (type.count / Math.max(1, item.total)) * 100))}%` }"
            >
              {{ typeLabel(type.asset_type) }} {{ type.count }}
            </i>
          </div>
        </button>
      </div>
    </section>

    <section v-if="summary.top?.length" class="panel">
      <div class="panel-title compact">
        <span class="title-text">今日人工复核</span>
        <span class="hint">AI 分流后仍需要人工判断的少量候选</span>
      </div>
      <div class="priority-grid">
        <button
          v-for="item in summary.top.slice(0, 6)"
          :key="item.dedupe_key"
          type="button"
          class="priority-card"
          @click="openDetail(item)"
        >
          <span class="asset-type">{{ typeLabel(item.asset_type) }}</span>
          <strong>{{ item.title }}</strong>
          <small>{{ item.collection_region }} / {{ item.business_sector }} · {{ item.asset_value_score }}分</small>
        </button>
      </div>
    </section>

    <section class="panel">
      <div class="panel-title compact">
        <span class="title-text">人工复核队列</span>
        <span class="hint">{{ formatNum(total) }} 条匹配结果</span>
      </div>

      <div v-if="items.length" class="batch-bar">
        <label class="select-all">
          <input type="checkbox" :checked="isPageSelected" @change="togglePageSelection">
          <span>选择本页</span>
        </label>
        <span class="batch-count">已选 {{ selectedKeys.length }} 条</span>
        <button class="btn-primary" :disabled="selectedKeys.length === 0" @click="batchReview('confirmed')">批量确认</button>
        <button class="btn-secondary" :disabled="selectedKeys.length === 0" @click="batchReview('merged')">批量合并</button>
        <button class="btn-danger" :disabled="selectedKeys.length === 0" @click="batchReview('rejected')">批量废弃</button>
      </div>

      <div v-if="loading" class="empty-state loading-pulse">加载候选资产...</div>
      <div v-else-if="items.length === 0" class="empty-state">暂无匹配的候选资产</div>
      <div v-else class="asset-list">
        <article v-for="item in items" :key="item.dedupe_key" class="asset-row" @click="openDetail(item)">
          <label class="row-check" @click.stop>
            <input
              type="checkbox"
              :checked="selectedSet.has(item.dedupe_key)"
              @change="toggleSelection(item.dedupe_key)"
            >
          </label>
          <div class="asset-main">
            <div class="asset-head">
              <span class="asset-type">{{ typeLabel(item.asset_type) }}</span>
              <span class="value-pill" :class="item.value_level">{{ item.asset_value_score || 0 }}分</span>
              <span class="status-pill-soft" :class="item.review_status">{{ statusLabel(item.review_status) }}</span>
              <span v-if="item.asset_type === 'operation_action'" class="effect-pill" :class="effectClass(item)">
                {{ actionEffectLabel(item) }}
              </span>
              <span v-if="item.asset_type === 'contact_role'" class="side-pill" :class="contactSide(item)">
                {{ contactSideLabel(item) }}
              </span>
              <span v-if="item.metrics?.asset_insight" class="insight-pill">已解读</span>
              <span v-if="item.metrics?.machine_assessment" class="machine-pill" :class="machineDecisionClass(item)">
                {{ item.metrics.machine_assessment.label || '机器评估' }}
              </span>
              <span v-if="item.metrics?.machine_assessment?.interaction_label" class="interaction-pill">
                {{ item.metrics.machine_assessment.interaction_label }}
              </span>
              <span v-if="item.metrics?.target_library_label" class="library-pill">
                → {{ item.metrics.target_library_label }}
              </span>
            </div>
            <h3>{{ item.title }}</h3>
            <p>{{ displayDescription(item) }}</p>
            <div class="asset-meta">
              <span>{{ item.collection_region || '未知区' }}</span>
              <span>{{ item.business_sector || '未分类' }}</span>
              <span>{{ item.group_name || '跨群汇总' }}</span>
              <span>置信度 {{ percent(item.confidence) }}</span>
              <span>频次 {{ item.frequency || 1 }}</span>
            </div>
          </div>
          <div class="asset-evidence">
            <div v-if="item.evidence?.length" class="quote">{{ item.evidence[0] }}</div>
            <div v-else class="quote muted">无文本证据，仅有来源消息索引</div>
            <small>来源消息：{{ (item.source_msg_ids || []).slice(0, 5).join(', ') || '-' }}</small>
          </div>
        </article>
      </div>

      <div v-if="totalPages > 1" class="pagination">
        <button :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
        <button v-for="p in visiblePages" :key="p" :class="{ active: p === page }" @click="goPage(p)">{{ p }}</button>
        <button :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
      </div>
    </section>

    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <div class="drawer-head">
          <div>
            <span class="asset-type">{{ typeLabel(detail.asset_type) }}</span>
            <h2>{{ detail.title }}</h2>
          </div>
          <button type="button" class="icon-btn" @click="closeDetail">×</button>
        </div>

        <div class="drawer-score">
          <div><strong>{{ detail.asset_value_score || 0 }}</strong><span>价值分</span></div>
          <div><strong>{{ percent(detail.confidence) }}</strong><span>置信度</span></div>
          <div><strong>{{ detail.frequency || 1 }}</strong><span>频次</span></div>
          <div><strong>{{ statusLabel(detail.review_status) }}</strong><span>审核状态</span></div>
        </div>

        <section v-if="linkedAsset" class="drawer-section linked-asset">
          <h3>正式资产沉淀结果</h3>
          <div class="formal-card inline">
            <div class="asset-head">
              <span class="asset-type">{{ typeLabel(linkedAsset.asset_type) }}</span>
              <span class="value-pill high">{{ linkedAsset.asset_value_score || 0 }}分</span>
            </div>
            <h3>{{ linkedAsset.title }}</h3>
            <p>{{ linkedAsset.summary || '已沉淀为正式资产' }}</p>
            <div class="asset-meta">
              <span>{{ linkedAsset.asset_uid }}</span>
              <span>质量 {{ linkedAsset.quality_score || 0 }}</span>
            </div>
          </div>
        </section>

        <section v-if="detail.metrics?.machine_assessment" class="drawer-section machine-section">
          <h3>机器评估</h3>
          <div class="machine-banner" :class="machineDecisionClass(detail)">
            <strong>{{ detail.metrics.machine_assessment.label || '机器评估' }}</strong>
            <span>{{ detail.metrics.machine_assessment.reason || '-' }}</span>
          </div>
          <div class="insight-grid">
            <div>
              <span>交互侧</span>
              <strong>{{ detail.metrics.machine_assessment.interaction_label || '-' }}</strong>
              <small>{{ detail.metrics.machine_assessment.interaction_description || '' }}</small>
            </div>
            <div>
              <span>是否需要人工</span>
              <strong>{{ detail.metrics.machine_assessment.manual_review_required ? '需要人工复核' : '机器已有明确结论' }}</strong>
              <small>{{ detail.metrics.machine_assessment.human_review_when || '' }}</small>
            </div>
            <div>
              <span>审核后变成什么</span>
              <strong>{{ detail.metrics.machine_assessment.after_confirm || '-' }}</strong>
            </div>
            <div>
              <span>建议动作</span>
              <strong>{{ detail.metrics.machine_assessment.review_action_label || '-' }}</strong>
              <small>{{ detail.metrics.machine_assessment.confidence_hint || '' }}</small>
            </div>
          </div>
        </section>

        <section v-if="detail.metrics?.asset_insight" class="drawer-section insight-section">
          <h3>资产解读</h3>
          <div class="insight-grid">
            <div>
              <span>可怎么用</span>
              <strong>{{ detail.metrics.asset_insight.primary_use || '-' }}</strong>
            </div>
            <div>
              <span>审核重点</span>
              <strong>{{ detail.metrics.asset_insight.review_focus || '-' }}</strong>
            </div>
            <div>
              <span>适用边界</span>
              <strong>{{ detail.metrics.asset_insight.limitation || '-' }}</strong>
            </div>
            <div>
              <span>下一步动作</span>
              <strong>{{ detail.metrics.asset_insight.suggested_next_step || '-' }}</strong>
            </div>
          </div>
          <p v-if="detail.metrics.asset_insight.reusable_summary" class="insight-summary">
            {{ detail.metrics.asset_insight.reusable_summary }}
          </p>
          <div v-if="detail.metrics.asset_insight.value_dimensions?.length" class="tag-list compact-tags">
            <span v-for="dim in detail.metrics.asset_insight.value_dimensions" :key="dim">{{ dim }}</span>
          </div>
        </section>

        <section v-if="detail.asset_type === 'operation_action'" class="drawer-section playbook-section">
          <h3>处理动作可用性</h3>
          <div v-if="detail.metrics?.action_playbook" class="playbook-grid">
            <div>
              <span>问题现象</span>
              <strong>{{ detail.metrics.action_playbook.problem_summary || '未识别到明确前置问题' }}</strong>
            </div>
            <div>
              <span>处理动作</span>
              <strong>{{ detail.metrics.action_playbook.action_label || '-' }}</strong>
              <small>{{ detail.metrics.action_playbook.action_text || '' }}</small>
            </div>
            <div>
              <span>执行方</span>
              <strong>{{ detail.metrics.action_playbook.action_actor || '-' }}</strong>
              <small>{{ detail.metrics.action_playbook.action_actor_role_label || '-' }}</small>
            </div>
            <div>
              <span>结果信号</span>
              <strong>{{ detail.metrics.action_playbook.result_signal || '暂未发现明确恢复信号' }}</strong>
              <small v-if="detail.metrics.action_playbook.result_delay_mins != null">约 {{ detail.metrics.action_playbook.result_delay_mins }} 分钟后</small>
            </div>
          </div>
          <p v-if="detail.metrics?.action_playbook?.reusable_summary" class="playbook-summary">
            {{ detail.metrics.action_playbook.reusable_summary }}
          </p>
          <p v-else class="muted">这条动作缺少前后文，暂不建议作为正式处理手册沉淀。</p>
        </section>

        <section v-if="detail.asset_type === 'contact_role'" class="drawer-section">
          <h3>联系人身份判断</h3>
          <div class="kv-grid">
            <span>身份来源</span><strong>{{ detail.metrics?.is_internal_staff ? '内部员工白名单' : '未命中内部白名单' }}</strong>
            <span>联系人侧</span><strong>{{ detail.metrics?.is_internal_staff ? '我方人员' : '外部/供应商联系人候选' }}</strong>
            <span>推断角色</span><strong>{{ detail.metrics?.inferred_role || '-' }}</strong>
          </div>
          <div class="contact-actions">
            <button class="btn-secondary" @click="tagContactSide('internal')">标记为我方人员</button>
            <button class="btn-secondary" @click="tagContactSide('external')">标记为外部联系人</button>
          </div>
        </section>

        <section class="drawer-section">
          <h3>业务上下文</h3>
          <div class="kv-grid">
            <span>采集区域</span><strong>{{ detail.collection_region || '-' }}</strong>
            <span>业务指向区域</span><strong>{{ detail.business_region || '-' }}</strong>
            <span>业务板块</span><strong>{{ detail.business_sector || '-' }}</strong>
            <span>来源群</span><strong>{{ detail.group_name || '-' }}</strong>
            <span>采集账号</span><strong>{{ detail.receiver_account || '-' }}</strong>
          </div>
        </section>

        <section class="drawer-section">
          <h3>为什么值得看</h3>
          <div v-if="detail.value_reasons?.length" class="tag-list">
            <span v-for="reason in detail.value_reasons" :key="reason">{{ reason }}</span>
          </div>
          <p v-else class="muted">暂无价值原因</p>
        </section>

        <section class="drawer-section">
          <h3>证据摘要</h3>
          <div v-if="detail.evidence?.length">
            <div v-for="(item, i) in detail.evidence" :key="i" class="quote">{{ item }}</div>
          </div>
          <p v-else class="muted">无文本证据，仅有来源消息索引。</p>
          <p class="source-line">来源消息 ID：{{ (detail.source_msg_ids || []).join(', ') || '-' }}</p>
        </section>

        <section class="drawer-section">
          <h3>来源消息片段</h3>
          <div v-if="sourceLoading" class="empty-state compact-empty">加载来源消息...</div>
          <div v-else-if="sourceMessages.length" class="source-list">
            <article v-for="msg in sourceMessages" :key="msg.id" class="source-card">
              <div>
                <strong>#{{ msg.id }} · {{ msg.sender_name || '未知发送人' }}</strong>
                <span>{{ msg.group_name || '-' }} / {{ msg.receiver_account || '-' }}</span>
              </div>
              <p>{{ msg.content_excerpt || (msg.has_media ? '媒体消息，无文本内容' : '空消息') }}</p>
              <small>{{ timeLabel(msg.timestamp) }} <b v-if="msg.has_media">含媒体</b></small>
            </article>
          </div>
          <p v-else class="muted">暂无可展示的来源消息片段。</p>
        </section>

        <section class="drawer-section">
          <h3>结构化指标</h3>
          <pre>{{ JSON.stringify(detail.metrics || {}, null, 2) }}</pre>
        </section>

        <section class="drawer-section">
          <h3>审核操作</h3>
          <textarea v-model="reviewNote" class="form-control note-input" placeholder="审核备注（可选）"></textarea>
          <div class="review-actions">
            <button class="btn-primary" @click="review('confirmed')">确认资产</button>
            <button class="btn-secondary" @click="review('merged')">标记已合并</button>
            <button class="btn-danger" @click="review('rejected')">废弃</button>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  getKnowledgeAssets,
  getKnowledgeAssetsSummary,
  getKnowledgeAssetsFacets,
  reviewKnowledgeAssetsBatch,
  getFormalAssets,
  getFormalAssetsSummary,
  getIntelligenceRegions,
  getKnowledgeAssetDetail,
  getKnowledgeAssetSources,
  reviewKnowledgeAsset,
  retagKnowledgeAssetContactSide
} from '@/api/analytics'
import { downloadAuthenticatedFile } from '@/utils/download'
import { formatShanghaiDateTime, shanghaiDateString } from '@/utils/time'

const TYPE_LABELS = {
  entity_relationship: '实体关系图谱',
  operation_action: '运营处理动作',
  regional_intelligence: '区域运营情报',
  risk_pattern: '风险模式',
  sla_commitment: 'SLA承诺履约',
  contact_role: '联系人角色',
  change_event: '变更维护事件',
  media_evidence: '媒体证据',
}

const STATUS_LABELS = {
  pending_review: '待审核',
  confirmed: '已确认',
  rejected: '已废弃',
  merged: '已合并',
}

const summary = ref({ ready: false, total: 0, top: [], byType: [], manualPending: 0, machineHandled: 0 })
const formalSummary = ref({ ready: false, total: 0, top: [], byType: [] })
const formalAssets = ref([])
const facets = ref({ types: [], sectors: [], regions: [], statuses: [], valueLevels: [] })
const filters = ref({ keyword: '', type: '', sector: '', region: '', interaction: '', machineDecision: '', manualReview: '1', status: 'pending_review', effective: '', sort: 'value' })
const items = ref([])
const loading = ref(false)
const page = ref(1)
const total = ref(0)
const limit = 20
const detail = ref(null)
const reviewNote = ref('')
const selectedKeys = ref([])
const regionalIntel = ref([])
const sourceMessages = ref([])
const sourceLoading = ref(false)
const linkedAsset = ref(null)
const exporting = ref(false)

const totalPages = computed(() => Math.ceil(total.value / limit) || 1)
const selectedSet = computed(() => new Set(selectedKeys.value))
const isPageSelected = computed(() => items.value.length > 0 && items.value.every(item => selectedSet.value.has(item.dedupe_key)))
const visiblePages = computed(() => {
  const pages = []
  for (let i = Math.max(1, page.value - 2); i <= Math.min(totalPages.value, page.value + 2); i++) pages.push(i)
  return pages
})

const typeLabel = (type) => TYPE_LABELS[type] || type || '-'
const statusLabel = (status) => STATUS_LABELS[status] || status || '-'
const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`
const formatNum = (value) => Number(value || 0).toLocaleString('zh-CN')
const timeLabel = (value) => {
  const n = Number(value)
  if (!n) return '-'
  return formatShanghaiDateTime(n)
}
const actionEffectLabel = (item) => {
  const metrics = item.metrics || {}
  if (!metrics.effect_checked) return '待验证效果'
  return metrics.effectiveness_signal ? `有效 ${metrics.effect_delay_mins || '-'}分钟` : '未见恢复'
}
const effectClass = (item) => {
  const metrics = item.metrics || {}
  if (!metrics.effect_checked) return 'pending'
  return metrics.effectiveness_signal ? 'effective' : 'ineffective'
}
const contactSide = (item) => item.metrics?.is_internal_staff ? 'internal' : 'external'
const contactSideLabel = (item) => item.metrics?.is_internal_staff ? '我方人员' : '外部候选'
const interactionLabel = (side) => ({
  resource_provider: '资源提供方交互',
  resource_user: '资源使用方交互',
  other: '其他交互',
})[side] || '未分类交互'
const machineDecisionClass = (item) => item.metrics?.machine_assessment?.decision || 'needs_human_review'
const displayDescription = (item) => {
  return item.metrics?.action_playbook?.reusable_summary ||
    item.metrics?.asset_insight?.reusable_summary ||
    item.metrics?.asset_insight?.primary_use ||
    item.description ||
    '暂无描述'
}

const toggleType = (type) => {
  filters.value.type = filters.value.type === type ? '' : type
  search()
}

const toggleInteraction = (interaction) => {
  filters.value.interaction = filters.value.interaction === interaction ? '' : interaction
  search()
}

const search = () => {
  page.value = 1
  fetchAssets()
}

const applyIntelFilter = (item) => {
  filters.value.region = item.collection_region || ''
  filters.value.sector = item.business_sector || ''
  page.value = 1
  fetchAssets()
}

const goPage = (p) => {
  page.value = p
  fetchAssets()
}

const fetchSummary = async () => {
  const res = await getKnowledgeAssetsSummary()
  if (res.success) summary.value = res.data || { ready: false, total: 0, top: [], byType: [], manualPending: 0, machineHandled: 0 }
}

const fetchFormalSummary = async () => {
  const res = await getFormalAssetsSummary()
  if (res.success) {
    formalSummary.value = res.data || { ready: false, total: 0, top: [], byType: [] }
    formalAssets.value = res.data?.top || []
  }
}

const loadFormalByType = async (type) => {
  const res = await getFormalAssets({ type, status: 'active', limit: 8, sort: 'value' })
  if (res.success) formalAssets.value = res.data || []
}

const fetchFacets = async () => {
  const res = await getKnowledgeAssetsFacets()
  if (res.success) facets.value = res.data || facets.value
}

const fetchRegionalIntel = async () => {
  const res = await getIntelligenceRegions({ days: 30 })
  if (res.success) regionalIntel.value = res.data || []
}

const fetchAssets = async () => {
  loading.value = true
  try {
    const res = await getKnowledgeAssets({ ...filters.value, page: page.value, limit })
    if (res.success) {
      items.value = res.data || []
      total.value = res.total || 0
      selectedKeys.value = selectedKeys.value.filter(key => items.value.some(item => item.dedupe_key === key))
    }
  } finally {
    loading.value = false
  }
}

const toggleSelection = (key) => {
  if (selectedSet.value.has(key)) selectedKeys.value = selectedKeys.value.filter(item => item !== key)
  else selectedKeys.value = [...selectedKeys.value, key]
}

const togglePageSelection = () => {
  if (isPageSelected.value) {
    const pageKeys = new Set(items.value.map(item => item.dedupe_key))
    selectedKeys.value = selectedKeys.value.filter(key => !pageKeys.has(key))
  } else {
    selectedKeys.value = Array.from(new Set([...selectedKeys.value, ...items.value.map(item => item.dedupe_key)]))
  }
}

const openDetail = async (item) => {
  const res = await getKnowledgeAssetDetail(item.dedupe_key)
  if (res.success) {
    detail.value = res.data
    linkedAsset.value = null
    reviewNote.value = res.data.review_note || ''
    fetchSources(res.data.dedupe_key)
  }
}

const closeDetail = () => {
  detail.value = null
  reviewNote.value = ''
  sourceMessages.value = []
  linkedAsset.value = null
}

const fetchSources = async (key) => {
  sourceLoading.value = true
  try {
    const res = await getKnowledgeAssetSources(key)
    if (res.success) sourceMessages.value = res.data || []
  } finally {
    sourceLoading.value = false
  }
}

const exportAssets = async () => {
  if (exporting.value) return
  exporting.value = true
  const ok = await downloadAuthenticatedFile(
    '/api/knowledge-assets/export',
    `knowledge-assets-${shanghaiDateString()}.json`
  )
  exporting.value = false
  if (ok) ElMessage.success('候选资产已导出')
}

const batchReview = async (status) => {
  if (selectedKeys.value.length === 0) return
  const res = await reviewKnowledgeAssetsBatch({
    status,
    dedupeKeys: selectedKeys.value,
    note: reviewNote.value,
  })
  if (res.success) {
    const suffix = res.promoted ? `，沉淀 ${res.promoted} 条正式资产` : ''
    ElMessage.success(`已更新 ${res.updated || 0} 条资产${suffix}`)
    selectedKeys.value = []
    await Promise.all([fetchSummary(), fetchFormalSummary(), fetchRegionalIntel(), fetchAssets()])
  }
}

const review = async (status) => {
  if (!detail.value) return
  const res = await reviewKnowledgeAsset(detail.value.dedupe_key, {
    status,
    note: reviewNote.value,
  })
  if (res.success) {
    detail.value = res.data
    linkedAsset.value = res.linkedAsset || null
    ElMessage.success(res.linkedAsset ? '已确认并沉淀为正式资产' : '审核状态已更新')
    await Promise.all([fetchSummary(), fetchFormalSummary(), fetchRegionalIntel(), fetchAssets()])
  }
}

const tagContactSide = async (side) => {
  if (!detail.value || detail.value.asset_type !== 'contact_role') return
  const res = await retagKnowledgeAssetContactSide(detail.value.dedupe_key, { side })
  if (res.success) {
    detail.value = res.data
    ElMessage.success(side === 'internal' ? '已标记为我方人员，并同步内部白名单' : '已标记为外部联系人')
    await Promise.all([fetchSummary(), fetchFacets(), fetchAssets()])
  }
}

onMounted(async () => {
  await Promise.all([fetchSummary(), fetchFormalSummary(), fetchFacets(), fetchRegionalIntel()])
  await fetchAssets()
})
</script>

<style scoped>
.summary-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
  margin: 18px 0;
}
.summary-card {
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  padding: 16px;
  background: #fff;
}
.summary-card strong {
  display: block;
  color: var(--t, #2d3748);
  font-size: 28px;
  line-height: 1;
}
.summary-card span {
  display: block;
  margin-top: 8px;
  color: var(--t3, #718096);
  font-size: 12px;
  font-weight: 700;
}
.summary-card.hot {
  border-color: rgba(221, 107, 32, .25);
  background: #fffaf5;
}
.summary-card.formal {
  border-color: rgba(5, 150, 105, .25);
  background: #f0fdf9;
}
.summary-card.ai {
  border-color: rgba(8, 145, 178, .28);
  background: #ecfeff;
}
.title-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.compact-btn {
  padding: 7px 10px;
  border-radius: 10px;
}
.type-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 10px;
  margin-bottom: 10px;
}
.type-chip {
  border: 1px solid var(--border, #e8edf5);
  border-radius: 999px;
  background: #fff;
  color: var(--t2, #4a5568);
  padding: 8px 12px;
  display: inline-flex;
  gap: 8px;
  align-items: center;
  white-space: nowrap;
  cursor: pointer;
}
.type-chip.active {
  border-color: rgba(107, 70, 193, .38);
  color: var(--p, #6b46c1);
  background: rgba(107, 70, 193, .08);
}
.interaction-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.interaction-card {
  text-align: left;
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  background: #fff;
  padding: 12px 14px;
  cursor: pointer;
}
.interaction-card.active {
  border-color: rgba(14, 116, 144, .32);
  background: #ecfeff;
}
.interaction-card strong {
  display: block;
  color: var(--t, #2d3748);
  font-size: 14px;
}
.interaction-card span {
  display: block;
  margin-top: 5px;
  color: var(--t3, #718096);
  font-size: 12px;
}
.intel-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.intel-card {
  text-align: left;
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  background: #fff;
  padding: 14px;
  cursor: pointer;
}
.intel-card:hover {
  border-color: rgba(14, 116, 144, .28);
  box-shadow: 0 8px 20px rgba(45, 55, 72, .08);
}
.intel-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--t, #2d3748);
}
.intel-head span {
  color: var(--t3, #718096);
  font-size: 12px;
  font-weight: 700;
}
.intel-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 12px 0;
  font-size: 12px;
  color: var(--t3, #718096);
}
.intel-metrics b {
  color: var(--t, #2d3748);
}
.mini-bars {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.mini-bars i {
  display: block;
  min-width: 42%;
  max-width: 100%;
  border-radius: 999px;
  background: #ecfeff;
  color: #0e7490;
  font-style: normal;
  font-size: 11px;
  font-weight: 800;
  padding: 3px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.priority-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.formal-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.formal-card {
  border: 1px solid rgba(5, 150, 105, .22);
  border-radius: 12px;
  background: #fbfffd;
  padding: 14px;
}
.formal-card.inline {
  background: #fff;
}
.formal-card h3 {
  margin: 10px 0 7px;
  color: var(--t, #2d3748);
  font-size: 15px;
}
.formal-card p {
  margin: 0 0 10px;
  color: var(--t2, #4a5568);
  font-size: 13px;
  line-height: 1.5;
}
.linked-asset {
  border-top: none;
  padding-top: 0;
}
.priority-card {
  text-align: left;
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  background: #fff;
  padding: 14px;
  cursor: pointer;
}
.priority-card strong {
  display: block;
  margin: 8px 0;
  color: var(--t, #2d3748);
  line-height: 1.35;
}
.priority-card small {
  color: var(--t3, #718096);
}
.asset-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.asset-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1.35fr) minmax(280px, .65fr);
  gap: 14px;
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  background: #fff;
  padding: 16px;
  cursor: pointer;
}
.batch-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  background: #fbfafc;
}
.select-all,
.row-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--t2, #4a5568);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.row-check {
  align-self: start;
  padding-top: 3px;
}
.batch-count {
  color: var(--t3, #718096);
  font-size: 12px;
  margin-right: auto;
}
.batch-bar button:disabled {
  opacity: .48;
  cursor: not-allowed;
}
.asset-row:hover,
.priority-card:hover {
  border-color: rgba(107,70,193,.28);
  box-shadow: 0 8px 20px rgba(45, 55, 72, .08);
}
.asset-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.asset-type {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: rgba(107,70,193,.08);
  color: var(--p, #6b46c1);
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 800;
}
.value-pill,
.status-pill-soft {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}
.value-pill.high { background: #fef3c7; color: #b45309; }
.value-pill.medium { background: #e0f2fe; color: #0369a1; }
.value-pill.low { background: #f1f5f9; color: #475569; }
.status-pill-soft.pending_review { background: #fff7ed; color: #c2410c; }
.status-pill-soft.confirmed { background: #ecfdf5; color: #047857; }
.status-pill-soft.rejected { background: #fef2f2; color: #b91c1c; }
.status-pill-soft.merged { background: #eef2ff; color: #4338ca; }
.effect-pill {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}
.effect-pill.pending { background: #f8fafc; color: #64748b; }
.effect-pill.effective { background: #ecfdf5; color: #047857; }
.effect-pill.ineffective { background: #fff7ed; color: #c2410c; }
.side-pill {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}
.side-pill.internal { background: #eff6ff; color: #1d4ed8; }
.side-pill.external { background: #f0fdf4; color: #15803d; }
.insight-pill {
  border-radius: 999px;
  background: #f0f9ff;
  color: #0369a1;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}
.machine-pill,
.interaction-pill {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}
.machine-pill.auto_ready { background: #ecfdf5; color: #047857; }
.machine-pill.auto_index { background: #eef2ff; color: #4338ca; }
.machine-pill.auto_insight { background: #f0f9ff; color: #0369a1; }
.machine-pill.needs_human_review { background: #fff7ed; color: #c2410c; }
.interaction-pill { background: #f8fafc; color: #475569; }
.library-pill {
  border-radius: 999px;
  background: #ecfdf5;
  color: #047857;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}
.asset-main h3 {
  margin: 10px 0 7px;
  font-size: 16px;
  color: var(--t, #2d3748);
}
.asset-main p {
  margin: 0 0 10px;
  color: var(--t2, #4a5568);
  font-size: 13px;
}
.asset-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  color: var(--t3, #718096);
  font-size: 12px;
}
.asset-evidence {
  border-left: 1px solid var(--border, #e8edf5);
  padding-left: 14px;
}
.quote {
  border-left: 3px solid var(--p, #6b46c1);
  padding-left: 10px;
  color: var(--t2, #4a5568);
  font-size: 13px;
  line-height: 1.55;
  margin-bottom: 8px;
}
.muted {
  color: var(--t3, #718096);
}
.compact-empty {
  padding: 14px;
}
.source-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.source-card {
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  padding: 12px;
  background: #fbfdff;
}
.source-card div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--t, #2d3748);
  font-size: 12px;
}
.source-card div span,
.source-card small {
  color: var(--t3, #718096);
}
.source-card p {
  margin: 8px 0;
  color: var(--t2, #4a5568);
  font-size: 13px;
  line-height: 1.55;
}
.source-card b {
  margin-left: 8px;
  color: #0e7490;
}
.asset-evidence small,
.source-line {
  color: var(--t3, #718096);
  font-size: 12px;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, .34);
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: min(720px, 100vw);
  height: 100%;
  overflow-y: auto;
  background: #fff;
  box-shadow: -16px 0 42px rgba(15, 23, 42, .18);
  padding: 22px;
}
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--border, #e8edf5);
  padding-bottom: 16px;
}
.drawer-head h2 {
  margin: 10px 0 0;
  font-size: 22px;
  color: var(--t, #2d3748);
}
.icon-btn {
  border: none;
  background: #f8fafc;
  border-radius: 10px;
  width: 36px;
  height: 36px;
  cursor: pointer;
  font-size: 22px;
}
.drawer-score {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 16px 0;
}
.drawer-score div {
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  padding: 12px;
}
.drawer-score strong {
  display: block;
  color: var(--t, #2d3748);
  font-size: 18px;
}
.drawer-score span {
  color: var(--t3, #718096);
  font-size: 12px;
}
.drawer-section {
  border-top: 1px solid var(--border, #e8edf5);
  padding: 16px 0;
}
.drawer-section h3 {
  margin: 0 0 12px;
  color: var(--t, #2d3748);
  font-size: 15px;
}
.playbook-section {
  background: #fbfffd;
  margin: 0 -4px;
  padding: 16px 4px;
}
.playbook-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.playbook-grid div {
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  background: #fff;
  padding: 12px;
}
.playbook-grid span {
  display: block;
  color: var(--t3, #718096);
  font-size: 12px;
  margin-bottom: 6px;
}
.playbook-grid strong {
  display: block;
  color: var(--t, #2d3748);
  font-size: 13px;
  line-height: 1.5;
}
.playbook-grid small {
  display: block;
  color: var(--t3, #718096);
  margin-top: 6px;
  line-height: 1.45;
}
.playbook-summary {
  margin: 12px 0 0;
  border-left: 3px solid #059669;
  padding: 10px 12px;
  background: #f0fdf9;
  color: var(--t2, #4a5568);
  border-radius: 0 10px 10px 0;
  font-size: 13px;
  line-height: 1.6;
}
.insight-section {
  background: #fbfdff;
  margin: 0 -4px;
  padding: 16px 4px;
}
.machine-section {
  background: #fffefa;
  margin: 0 -4px;
  padding: 16px 4px;
}
.machine-banner {
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 10px;
  background: #fff;
}
.machine-banner strong {
  display: block;
  color: var(--t, #2d3748);
  margin-bottom: 5px;
}
.machine-banner span {
  color: var(--t2, #4a5568);
  font-size: 13px;
  line-height: 1.55;
}
.machine-banner.auto_ready { border-color: rgba(5, 150, 105, .26); background: #f0fdf9; }
.machine-banner.auto_index { border-color: rgba(67, 56, 202, .22); background: #eef2ff; }
.machine-banner.auto_insight { border-color: rgba(3, 105, 161, .22); background: #f0f9ff; }
.machine-banner.needs_human_review { border-color: rgba(194, 65, 12, .22); background: #fff7ed; }
.insight-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.insight-grid div {
  border: 1px solid var(--border, #e8edf5);
  border-radius: 12px;
  background: #fff;
  padding: 12px;
}
.insight-grid span {
  display: block;
  color: var(--t3, #718096);
  font-size: 12px;
  margin-bottom: 6px;
}
.insight-grid strong {
  display: block;
  color: var(--t, #2d3748);
  font-size: 13px;
  line-height: 1.55;
}
.insight-grid small {
  display: block;
  color: var(--t3, #718096);
  margin-top: 6px;
  line-height: 1.45;
}
.insight-summary {
  margin: 12px 0 0;
  border-left: 3px solid #0284c7;
  padding: 10px 12px;
  background: #f0f9ff;
  color: var(--t2, #4a5568);
  border-radius: 0 10px 10px 0;
  font-size: 13px;
  line-height: 1.6;
}
.compact-tags {
  margin-top: 10px;
}
.kv-grid {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 8px 12px;
  font-size: 13px;
}
.kv-grid span {
  color: var(--t3, #718096);
}
.contact-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tag-list span {
  border-radius: 999px;
  background: #f8fafc;
  border: 1px solid var(--border, #e8edf5);
  padding: 5px 9px;
  color: var(--t2, #4a5568);
  font-size: 12px;
}
pre {
  white-space: pre-wrap;
  word-break: break-word;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 12px;
  padding: 14px;
  font-size: 12px;
  max-height: 280px;
  overflow: auto;
}
.note-input {
  min-height: 84px;
  resize: vertical;
  width: 100%;
}
.review-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.btn-secondary,
.btn-danger {
  border: none;
  border-radius: 12px;
  padding: 10px 14px;
  cursor: pointer;
  font-weight: 800;
}
.btn-secondary {
  background: #eef2ff;
  color: #4338ca;
}
.btn-danger {
  background: #fef2f2;
  color: #b91c1c;
}
@media (max-width: 900px) {
  .summary-grid,
  .intel-grid,
  .formal-grid,
  .interaction-strip,
  .priority-grid,
  .insight-grid,
  .playbook-grid,
  .asset-row,
  .drawer-score {
    grid-template-columns: 1fr;
  }
  .asset-evidence {
    border-left: none;
    border-top: 1px solid var(--border, #e8edf5);
    padding: 12px 0 0;
  }
}
</style>
