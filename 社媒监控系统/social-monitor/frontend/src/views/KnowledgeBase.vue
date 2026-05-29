<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">📖</span> QA 知识库</span>
        <span class="hint">问题闭环时自动提取，高置信度可作SOP参考</span>
        <div class="export-group">
          <button class="btn-export" @click="toggleExportMenu" :class="{ active: showExportMenu }">
            ⬇ 下载
            <span class="export-arrow">▾</span>
          </button>
          <div v-if="showExportMenu" class="export-menu">
            <div class="export-menu-header">选择导出格式</div>
            <button @click="downloadKB('jsonl')">
              <span class="fmt-icon">🤖</span>
              <span>
                <strong>JSONL</strong>
                <small>RAG / 微调训练集，每行 {instruction, output}</small>
              </span>
            </button>
            <button @click="downloadKB('json')">
              <span class="fmt-icon">{ }</span>
              <span>
                <strong>JSON</strong>
                <small>完整结构化数据，适合程序处理</small>
              </span>
            </button>
            <button @click="downloadKB('csv')">
              <span class="fmt-icon">📊</span>
              <span>
                <strong>CSV</strong>
                <small>表格格式，可用 Excel 打开</small>
              </span>
            </button>
          </div>
        </div>
      </div>

      <div class="filters">
        <input
          type="text"
          class="form-control"
          style="flex: 1; min-width: 200px; max-width: 360px"
          v-model="keyword"
          placeholder="搜索问题/关键词..."
          @keyup.enter="search"
        >
        <select class="form-control" style="max-width: 180px" v-model="sector" @change="search">
          <option value="">全部板块</option>
          <option v-for="s in sectors" :key="s" :value="s">{{ s }}</option>
        </select>
        <button class="btn-primary" @click="search">🔍 搜索</button>
      </div>

      <div v-if="loading" class="empty-state loading-pulse">加载知识库数据...</div>

      <div v-else-if="items.length === 0" class="empty-state">暂无匹配的知识条目</div>

      <div v-else>
        <div v-for="item in items" :key="item.id" class="msg-card" style="flex-direction: column; gap: 12px">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
            <span style="font-size: 16px; font-weight: 700; color: var(--t)">{{ item.question_summary }}</span>
            <span style="font-size: 12px; color: var(--t3)">置信度: {{ Math.round((item.confidence || 0) * 100) }}% · 频次: {{ item.frequency || 0 }}</span>
          </div>
          <div v-if="item.question_keywords && item.question_keywords.length" style="display: flex; gap: 6px; flex-wrap: wrap">
            <span v-for="kw in item.question_keywords" :key="kw"
              style="font-size: 11px; padding: 2px 8px; border-radius: 8px; background: rgba(107,70,193,0.1); color: var(--p); font-weight: 600">{{ kw }}</span>
          </div>
          <div v-if="item.answer_steps && item.answer_steps.length" style="font-size: 14px; color: var(--t2); line-height: 1.8">
            <div v-for="(step, i) in item.answer_steps" :key="i">{{ i + 1 }}. {{ step }}</div>
          </div>
          <div style="font-size: 12px; color: var(--t3)">📅 {{ formatDate(item.created_at) }}</div>
        </div>
      </div>

      <div v-if="totalPages > 1" class="pagination">
        <button :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
        <button v-for="p in visiblePages" :key="p" :class="{ active: p === page }" @click="goPage(p)">{{ p }}</button>
        <button :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import api from '@/utils/request'

const keyword = ref('')
const sector = ref('')
const sectors = ref([])
const items = ref([])
const loading = ref(true)
const page = ref(1)
const total = ref(0)
const limit = 20

const totalPages = computed(() => Math.ceil(total.value / limit) || 1)
const visiblePages = computed(() => {
  const pages = []
  for (let i = Math.max(1, page.value - 2); i <= Math.min(totalPages.value, page.value + 2); i++) pages.push(i)
  return pages
})

const search = () => { page.value = 1; fetchData() }
const goPage = (p) => { page.value = p; fetchData() }

const formatDate = (dateStr) => {
  if (!dateStr) return '--'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN', { 
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const fetchData = async () => {
  loading.value = true
  try {
    const res = await api.get('/api/knowledge-base', { params: { keyword: keyword.value, sector: sector.value, page: page.value, limit } })
    if (res.success) { items.value = res.data || []; total.value = res.total || 0 }
  } catch (e) { console.error(e) }
  loading.value = false
}

const fetchSectors = async () => {
  try {
    const res = await api.get('/api/knowledge-base/sectors')
    if (res.success) sectors.value = res.data || []
  } catch (e) {}
}

const showExportMenu = ref(false)

const toggleExportMenu = () => { showExportMenu.value = !showExportMenu.value }

const downloadKB = (format) => {
  showExportMenu.value = false
  const token = localStorage.getItem('token') || sessionStorage.getItem('token') || ''
  const url = `/api/knowledge-base/export?format=${format}`
  // 带鉴权的下载：用 fetch + blob
  fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(r => r.blob())
    .then(blob => {
      const ext = format === 'csv' ? 'csv' : format === 'jsonl' ? 'jsonl' : 'json'
      const filename = `qa-kb-${new Date().toISOString().slice(0,10)}.${ext}`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      a.click()
      URL.revokeObjectURL(a.href)
    })
    .catch(e => console.error('下载失败', e))
}

const handleOutsideClick = (e) => {
  if (!e.target.closest('.export-group')) showExportMenu.value = false
}

onMounted(() => { fetchSectors(); fetchData(); document.addEventListener('click', handleOutsideClick) })
onUnmounted(() => document.removeEventListener('click', handleOutsideClick))
</script>

<style scoped>
.export-group {
  position: relative;
  margin-left: auto;
}
.btn-export {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--p, #6b46c1);
  background: transparent;
  color: var(--p, #6b46c1);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all .18s;
  white-space: nowrap;
}
.btn-export:hover, .btn-export.active {
  background: var(--p, #6b46c1);
  color: #fff;
}
.export-arrow { font-size: 10px; }
.export-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 240px;
  background: var(--card, #1e1e2e);
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.35);
  z-index: 999;
  overflow: hidden;
  animation: fadeDown .15s ease;
}
@keyframes fadeDown {
  from { opacity:0; transform: translateY(-6px); }
  to   { opacity:1; transform: translateY(0); }
}
.export-menu-header {
  padding: 10px 14px 6px;
  font-size: 11px;
  color: var(--t3, #888);
  text-transform: uppercase;
  letter-spacing: .06em;
}
.export-menu button {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: transparent;
  color: var(--t, #fff);
  cursor: pointer;
  text-align: left;
  transition: background .15s;
}
.export-menu button:hover { background: rgba(107,70,193,0.15); }
.fmt-icon {
  width: 28px;
  text-align: center;
  font-size: 16px;
  flex-shrink: 0;
}
.export-menu button strong { display: block; font-size: 13px; }
.export-menu button small  { display: block; font-size: 11px; color: var(--t3, #888); margin-top: 1px; }
</style>
