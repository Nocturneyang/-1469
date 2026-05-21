<template>
  <div class="view-enter">
    <!-- 详情视图 -->
    <div v-if="detailMode && detail">
      <nav style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--t3);margin-bottom:32px">
        <button @click="detailMode = false" class="el-btn">← 供应商矩阵</button>
        <span>/</span><span>{{ detail.business_sector || '未分类' }}</span><span>/</span>
        <span style="color:var(--t);font-weight:600">{{ detail.group_name }}</span>
      </nav>

      <!-- 标题 + SLA 圆环 -->
      <section style="display:flex;flex-wrap:wrap;gap:32px;margin-bottom:40px;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <h1 style="font-size:2rem;font-weight:700;color:var(--t);margin:0 0 12px 0;letter-spacing:-0.02em">{{ detail.group_name }}</h1>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            <span class="tag">{{ detail.business_sector || '未分类' }}</span>
            <span class="tag slate">{{ detail.region || '未知区' }}</span>
          </div>
        </div>
        <div class="panel" style="text-align:center;min-width:160px;padding:24px">
          <div style="font-size:11px;color:var(--t3);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">综合 SLA 评分</div>
          <div style="font-size:48px;font-weight:700;letter-spacing:-2px" :style="{ color: scoreColor(detail.reliability_score) }">{{ detail.reliability_score || 0 }}</div>
          <div style="font-size:12px;color:var(--t2);margin-top:4px">基于 {{ detail.total_messages || 0 }} 条消息</div>
        </div>
      </section>

      <!-- 4 列指标 -->
      <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:40px">
        <div class="panel" style="padding:20px;margin-bottom:0">
          <div style="font-size:11px;color:var(--t3);letter-spacing:0.05em;margin-bottom:4px">平均响应 P50</div>
          <div style="font-size:30px;font-weight:700;color:var(--t)">{{ fmtMin(detail.p50_response_mins) }}</div>
        </div>
        <div class="panel" style="padding:20px;margin-bottom:0">
          <div style="font-size:11px;color:var(--t3);letter-spacing:0.05em;margin-bottom:4px">P95 长尾</div>
          <div style="font-size:30px;font-weight:700;color:var(--t)">{{ fmtMin(detail.p95_response_mins) }}</div>
        </div>
        <div class="panel" style="padding:20px;margin-bottom:0">
          <div style="font-size:11px;color:var(--t3);letter-spacing:0.05em;margin-bottom:4px">平均解决 MTTR</div>
          <div style="font-size:30px;font-weight:700;color:var(--t)">{{ detail.avg_resolution_mins != null ? detail.avg_resolution_mins.toFixed(1) + 'min' : '-' }}</div>
        </div>
        <div class="panel" :style="{ borderColor: (detail.open_issues || 0) === 0 ? '#D1FAE5' : 'var(--border)', background: (detail.open_issues || 0) === 0 ? '#F0FDF9' : '#fff' }" style="padding:20px;margin-bottom:0">
          <div style="font-size:11px;color:var(--t3);letter-spacing:0.05em;margin-bottom:4px">逃逸告警</div>
          <div style="font-size:30px;font-weight:700;color:#059669">{{ detail.open_issues || 0 }}</div>
          <div style="font-size:12px;margin-top:4px" :style="{ color: (detail.open_issues || 0) === 0 ? '#059669' : '#DC2626' }">{{ (detail.open_issues || 0) === 0 ? 'SLA 100% 达成' : '待处理 ' + detail.open_issues + ' 项' }}</div>
        </div>
      </section>

      <!-- 双栏主内容 -->
      <div style="display:grid;grid-template-columns:7fr 5fr;gap:20px;margin-bottom:20px">
        <!-- 左栏 -->
        <div style="display:flex;flex-direction:column;gap:20px">

          <!-- 服务态度与配合度 -->
          <section class="panel" style="padding:24px">
            <h2 style="font-weight:600;font-size:18px;color:var(--t);margin:0 0 20px 0;display:flex;align-items:center;gap:8px"><span style="width:6px;height:20px;border-radius:4px;background:#4F46E5;display:inline-block"></span>服务态度与配合度</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
              <div style="background:var(--bg-tint);border-radius:12px;padding:16px">
                <div style="font-size:12px;color:var(--t2);margin-bottom:8px">主动上报率</div>
                <div style="font-size:30px;font-weight:700" :style="{ color: commitRate >= 60 ? '#059669' : '#DC2626' }">{{ commitRate != null ? commitRate + '%' : '—' }}</div>
                <div style="height:6px;background:#F5F5F4;border-radius:999px;overflow:hidden;margin-top:8px"><div :style="{ width: (commitRate || 0) + '%', background: commitRate >= 60 ? '#059669' : '#DC2626' }" style="height:100%;border-radius:999px"></div></div>
              </div>
              <div style="background:var(--bg-tint);border-radius:12px;padding:16px">
                <div style="font-size:12px;color:var(--t2);margin-bottom:8px">推诿指数</div>
                <div style="font-size:30px;font-weight:700" :style="{ color: deflectIdx <= 20 ? '#059669' : deflectIdx <= 40 ? '#D97706' : '#DC2626' }">{{ deflectIdx }}%</div>
                <div style="height:6px;background:#F5F5F4;border-radius:999px;overflow:hidden;margin-top:8px"><div :style="{ width: deflectIdx + '%', background: deflectIdx <= 20 ? '#059669' : '#DC2626' }" style="height:100%;border-radius:999px"></div></div>
              </div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              <span style="font-size:12px;color:var(--t2);font-weight:500">态度标签：</span>
              <span v-for="t in attitudeTags" :key="t.text" :style="tagStyle(t.cls)" style="font-size:12px;padding:2px 10px;border-radius:999px;font-weight:500">{{ t.text }}</span>
            </div>
          </section>

          <!-- 问题解决效率 -->
          <section class="panel" style="padding:24px">
            <h2 style="font-weight:600;font-size:18px;color:var(--t);margin:0 0 20px 0;display:flex;align-items:center;gap:8px"><span style="width:6px;height:20px;border-radius:4px;background:#059669;display:inline-block"></span>问题解决效率</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
              <div style="background:var(--bg-tint);border-radius:12px;padding:16px">
                <div style="font-size:12px;color:var(--t2);margin-bottom:8px">首问解决率 FCR</div>
                <div style="font-size:30px;font-weight:700;color:var(--t)">{{ fcr }}%</div>
              </div>
              <div style="background:var(--bg-tint);border-radius:12px;padding:16px">
                <div style="font-size:12px;color:var(--t2);margin-bottom:8px">平均交互回合</div>
                <div style="font-size:30px;font-weight:700;color:var(--t)">{{ detail.ai_avg_turns != null ? detail.ai_avg_turns.toFixed(1) : '—' }}</div>
              </div>
            </div>
            <!-- 分项评分 -->
            <div v-for="s in subScores" :key="s.label" style="margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
                <span style="color:var(--t2)">{{ s.label }}</span>
                <span style="font-weight:700" :style="{ color: s.color }">{{ s.pct != null ? s.pct + '%' : '—' }}</span>
              </div>
              <div style="height:6px;background:#F5F5F4;border-radius:999px;overflow:hidden"><div :style="{ width: (s.pct || 0) + '%', background: s.color }" style="height:100%;border-radius:999px"></div></div>
            </div>
          </section>
        </div>

        <!-- 右栏 -->
        <div style="display:flex;flex-direction:column;gap:20px">

          <!-- AI 综合洞察 -->
          <section class="panel" style="padding:24px">
            <h2 style="font-weight:600;font-size:18px;color:var(--t);margin:0 0 20px 0;display:flex;align-items:center;gap:8px"><span style="width:6px;height:20px;border-radius:4px;background:#7C3AED;display:inline-block"></span>AI 综合洞察</h2>
            <p style="font-size:14px;color:var(--t2);line-height:1.8;margin-bottom:12px">{{ insightSummary }}</p>
            <div v-if="insightTags.length" style="display:flex;flex-wrap:wrap;gap:6px">
              <span v-for="t in insightTags" :key="t.text" :style="tagStyle(t.cls)" style="font-size:12px;padding:2px 10px;border-radius:999px;font-weight:500">{{ t.text }}</span>
            </div>
          </section>

          <!-- 高频根因 -->
          <section v-if="detail.top_issue_types && detail.top_issue_types.length" class="panel" style="padding:24px">
            <h2 style="font-weight:600;font-size:18px;color:var(--t);margin:0 0 20px 0;display:flex;align-items:center;gap:8px"><span style="width:6px;height:20px;border-radius:4px;background:#DC2626;display:inline-block"></span>高频技术根因</h2>
            <div v-for="(t, i) in detail.top_issue_types" :key="i" style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px solid #F5F5F4">
              <span>{{ t }}</span>
            </div>
          </section>

          <!-- 综合诊断 -->
          <section class="panel" style="padding:24px">
            <h2 style="font-weight:600;font-size:18px;color:var(--t);margin:0 0 20px 0;display:flex;align-items:center;gap:8px"><span style="width:6px;height:20px;border-radius:4px;background:#D97706;display:inline-block"></span>综合诊断</h2>
            <div v-for="(d, i) in diagItems" :key="i" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #F5F5F4;font-size:13px">
              <span style="font-size:11px;padding:1px 8px;border-radius:999px;font-weight:600" :style="{ background: d.color === '#DC2626' ? '#FEF2F2' : d.color === '#D97706' ? '#FFFBEB' : '#ECFDF5', color: d.color }">{{ d.level }}</span>
              <span style="color:var(--t)">{{ d.text }}</span>
            </div>
          </section>

          <!-- 近期告警 -->
          <section v-if="detail.recent_alerts && detail.recent_alerts.length" class="panel" style="padding:24px">
            <h2 style="font-weight:600;font-size:18px;color:var(--t);margin:0 0 20px 0;display:flex;align-items:center;gap:8px"><span style="width:6px;height:20px;border-radius:4px;background:#DC2626;display:inline-block"></span>近期告警</h2>
            <div v-for="(a, i) in detail.recent_alerts" :key="i" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #F5F5F4;font-size:12px">
              <span style="font-size:10px;padding:1px 8px;border-radius:999px;font-weight:600" :style="{ background: a.alert_level === 'p0' ? '#FEF2F2' : '#FFFBEB', color: a.alert_level === 'p0' ? '#DC2626' : '#D97706' }">{{ (a.alert_level || '').toUpperCase() }}</span>
              <span style="color:var(--t);flex:1">{{ a.trigger_type || a.trigger_keywords || '' }}</span>
              <span style="color:var(--t3);font-size:11px">{{ a.created_at || '' }}</span>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-else>
      <div class="panel">
        <div class="panel-title">
          <div>
            <span class="title-text"><span class="panel-icon">🏷️</span> 供应商可靠性画像</span>
            <span class="hint">每日 03:00 自动更新 · 评分=100 - 告警扣分 - 承诺违约扣分 - 响应慢扣分</span>
          </div>
          <div style="display:flex;gap:8px">
            <select class="form-control" style="max-width:140px" v-model="sector" @change="fetchData">
              <option value="">全部板块</option>
              <option v-for="s in sectors" :key="s" :value="s">{{ s }}</option>
            </select>
            <select class="form-control" style="max-width:140px" v-model="sort" @change="fetchData">
              <option value="score">评分最高</option>
              <option value="issues">告警最多</option>
              <option value="response">响应最快</option>
              <option value="commitment">兑现率最高</option>
            </select>
          </div>
        </div>

        <div v-if="loading" class="empty-state loading-pulse">加载供应商画像数据...</div>
        <div v-else-if="items.length === 0" class="empty-state">暂无供应商画像数据，每日 03:00 自动生成</div>

        <div v-else class="pf-grid">
          <div v-for="item in items" :key="item.group_name" class="pf-card" @click="viewDetail(item.group_name)">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px">
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:15px;color:var(--t);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ item.group_name }}</div>
                <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
                  <span class="tag">{{ item.business_sector || '未分类' }}</span>
                  <span class="tag slate">{{ item.region || '未知' }}</span>
                </div>
              </div>
              <div class="pf-score-ring" :style="{ background: scoreBg(item.reliability_score) }">
                <span :style="{ color: scoreColor(item.reliability_score) }">{{ item.reliability_score || 0 }}</span>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding-top:12px;border-top:1px solid #F5F5F4">
              <div style="text-align:center">
                <div class="pf-metric-val">{{ fmtMin(item.p50_response_mins) }}</div>
                <div class="pf-metric-lbl">P50响应</div>
              </div>
              <div style="text-align:center">
                <div class="pf-metric-val" :style="{ color: (item.open_issues || 0) > 0 ? '#DC2626' : 'var(--t)' }">{{ item.open_issues || 0 }}</div>
                <div class="pf-metric-lbl">未闭环</div>
              </div>
              <div style="text-align:center">
                <div class="pf-metric-val">{{ fmtPct(item.commitment_rate) }}</div>
                <div class="pf-metric-lbl">兑现率</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '@/utils/request'

const sector = ref('')
const sort = ref('score')
const sectors = ref([])
const items = ref([])
const loading = ref(true)
const page = ref(1)
const total = ref(0)
const limit = 30

const detailMode = ref(false)
const detail = ref(null)

const scoreColor = (s) => (s || 0) >= 80 ? '#059669' : ((s || 0) >= 60 ? '#D97706' : '#DC2626')
const scoreBg = (s) => (s || 0) >= 80 ? '#ECFDF5' : ((s || 0) >= 60 ? '#FFFBEB' : '#FEF2F2')
const fmtMin = (v) => v != null ? v.toFixed(0) + 'min' : '-'
const fmtPct = (v) => v != null ? (v * 100).toFixed(0) + '%' : '-'

const viewDetail = async (name) => {
  try {
    const res = await api.get('/api/supplier-profiles/' + encodeURIComponent(name))
    if (res.success && res.data) {
      detail.value = res.data
      detailMode.value = true
    }
  } catch (e) { console.error(e) }
}

const commitRate = computed(() => {
  if (!detail.value?.commitment_rate) return null
  return Math.round(detail.value.commitment_rate * 100)
})
const deflectIdx = computed(() => Math.round((detail.value?.recurrence_rate || 0) * 100))
const fcr = computed(() => {
  if (detail.value?.ai_fcr != null) return Math.round(detail.value.ai_fcr * 100)
  return Math.round((1 - (detail.value?.recurrence_rate || 0)) * 100)
})

const tagStyle = (cls) => {
  if (cls === 'red') return { background: '#FEF2F2', color: '#DC2626' }
  if (cls === 'amber') return { background: '#FFFBEB', color: '#D97706' }
  if (cls === 'green') return { background: '#ECFDF5', color: '#059669' }
  return { background: '#F8FAFC', color: '#475569', border: '1px solid #E2E8F0' }
}

const attitudeTags = computed(() => {
  if (detail.value?.ai_attitude_tags?.length) {
    return detail.value.ai_attitude_tags.map(t => ({ text: t, cls: 'green' }))
  }
  const tags = []
  const cr = detail.value?.commitment_rate
  if (cr != null && cr < 0.5) tags.push({ text: '配合度低', cls: 'red' })
  else if (cr != null && cr < 0.8) tags.push({ text: '配合一般', cls: 'amber' })
  else if (cr != null) tags.push({ text: '配合积极', cls: 'green' })
  if ((detail.value?.recurrence_rate || 0) > 0.4) tags.push({ text: '复发率偏高', cls: 'red' })
  return tags.length ? tags : [{ text: '暂无负面标签', cls: 'green' }]
})

const insightTags = computed(() => {
  if (detail.value?.ai_insight_tags?.length) {
    return detail.value.ai_insight_tags.map(t => ({ text: t, cls: 'green' }))
  }
  return []
})

const insightSummary = computed(() => {
  if (detail.value?.ai_insight_summary) return detail.value.ai_insight_summary
  const parts = []
  const avg = detail.value?.avg_response_mins
  if (avg != null && avg < 30) parts.push('工作日响应极快')
  else if (avg != null) parts.push('响应速度偏慢')
  if ((detail.value?.recurrence_rate || 0) > 0.3) parts.push('问题复发率偏高')
  if (detail.value?.commitment_rate >= 0.8) parts.push('供应商配合积极')
  return parts.length ? parts.join('，') + '。' : '暂无足够数据生成综合评估。'
})

const subScores = computed(() => {
  const sub = detail.value?.ai_sub_scores || {}
  const cr = commitRate.value
  const barColor = (v) => v >= 70 ? '#059669' : v >= 40 ? '#D97706' : '#DC2626'
  if (Object.keys(sub).length) {
    return [
      { label: '主动上报与预警', pct: sub['主动上报与预警'], color: barColor(sub['主动上报与预警'] || 0) },
      { label: '首问解决率 FCR', pct: sub['首问解决率FCR'], color: barColor(sub['首问解决率FCR'] || 0) },
      { label: '技术配合态度', pct: sub['技术配合态度'], color: barColor(sub['技术配合态度'] || 0) },
      { label: '计划内变更占比', pct: sub['计划内变更占比'], color: barColor(sub['计划内变更占比'] || 0) },
    ]
  }
  return [
    { label: '主动上报与预警', pct: cr, color: cr != null ? barColor(cr) : '#A8A29E' },
    { label: '首问解决率 FCR', pct: fcr.value, color: barColor(fcr.value) },
    { label: '技术配合态度', pct: cr, color: cr != null ? barColor(cr) : '#A8A29E' },
    { label: '计划内变更占比', pct: null, color: '#A8A29E' },
  ]
})

const diagItems = computed(() => {
  if (!detail.value) return []
  const d = detail.value
  const sc = d.reliability_score || 0
  const items = []
  if (sc < 60) items.push({ color: '#DC2626', text: '综合评分偏低，需重点关注', level: '严重' })
  if ((d.open_issues || 0) >= 3) items.push({ color: '#DC2626', text: '未闭环事项较多：' + d.open_issues + ' 个', level: '严重' })
  if (d.p95_response_mins != null && d.p95_response_mins > 60) items.push({ color: '#D97706', text: 'P95 响应偏慢：' + d.p95_response_mins.toFixed(0) + 'min', level: '关注' })
  if ((d.recurrence_rate || 0) > 0.3) items.push({ color: '#D97706', text: '问题复发率偏高', level: '关注' })
  if (sc >= 80) items.push({ color: '#059669', text: '综合评分良好，运行稳定', level: '正常' })
  if (d.avg_response_mins != null && d.avg_response_mins < 30) items.push({ color: '#059669', text: '工作日响应速度达标', level: '亮点' })
  if (items.length === 0) items.push({ color: '#059669', text: '各项指标均在正常范围', level: '正常' })
  return items
})

const fetchData = async () => {
  loading.value = true
  try {
    const res = await api.get('/api/supplier-profiles', { params: { sector: sector.value, sort: sort.value, page: page.value, limit } })
    if (res.success) { items.value = res.data || []; total.value = res.total || 0 }
  } catch (e) { console.error(e) }
  loading.value = false
}

const fetchSectors = async () => {
  try {
    const res = await api.get('/api/supplier-profiles/sectors')
    if (res.success) sectors.value = res.data || []
  } catch (e) {}
}

onMounted(() => { fetchSectors(); fetchData() })
</script>

<style scoped>
/* Styles now use global style.css */
.pf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.pf-card { background: #fff; border: 1px solid var(--border); border-radius: var(--rs); padding: 20px; cursor: pointer; transition: all 0.2s ease; box-shadow: var(--out-shadow); }
.pf-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06); border-color: #D6BCFA; transform: translateY(-2px); }
.pf-score-ring { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-left: 12px; }
.pf-score-ring span { font-size: 18px; font-weight: 700; }
.pf-metric-val { font-size: 16px; font-weight: 700; color: var(--t); }
.pf-metric-lbl { font-size: 10px; color: var(--t3); margin-top: 1px; }
</style>
