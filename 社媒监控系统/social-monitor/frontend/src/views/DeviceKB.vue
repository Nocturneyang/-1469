<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">🔧</span> 设备知识库</span>
      </div>
      <p style="font-size:13px;color:var(--t3);margin-bottom:20px">设备供应商闭环问题自动提取：型号 → 故障 → 方案。</p>

      <div class="filters">
        <input
          type="text"
          class="form-control"
          style="flex: 1; min-width: 200px; max-width: 360px"
          v-model="keyword"
          placeholder="搜索型号/故障/方案..."
          @keyup.enter="search"
        >
        <select class="form-control" style="max-width: 180px" v-model="category" @change="search">
          <option value="">全部分类</option>
          <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
        </select>
        <button class="btn-primary" @click="search">🔍 搜索</button>
      </div>

      <div v-if="loading" class="empty-state loading-pulse">加载设备知识数据...</div>

      <div v-else-if="items.length === 0" class="empty-state">输入关键词搜索设备故障知识</div>

      <div v-else>
        <div v-for="item in items" :key="item.id" class="msg-card" style="flex-direction: column; gap: 8px">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
            <span style="font-size: 15px; font-weight: 700; color: var(--t)">{{ item.device_model }}</span>
            <span style="font-size: 12px; color: var(--t3)">分类: {{ item.fault_category || '--' }} · 频次: {{ item.frequency || 0 }}</span>
          </div>
          <div style="font-size: 14px; color: var(--color-danger); font-weight: 600">故障: {{ item.fault_symptom }}</div>
          <div style="font-size: 14px; color: var(--t2); line-height: 1.6">方案: {{ item.solution_steps }}</div>
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
import { ref, computed, onMounted } from 'vue'
import api from '@/utils/request'

const keyword = ref('')
const category = ref('')
const categories = ref([])
const items = ref([])
const loading = ref(false)
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
    const res = await api.get('/api/device-kb', { params: { keyword: keyword.value, category: category.value, page: page.value, limit } })
    if (res.success) { items.value = res.data || []; total.value = res.total || 0 }
  } catch (e) { console.error(e) }
  loading.value = false
}

const fetchCategories = async () => {
  try {
    const res = await api.get('/api/device-kb/categories')
    if (res.success) categories.value = res.data || []
  } catch (e) {}
}

onMounted(() => { fetchCategories(); fetchData() })
</script>

<style scoped>
/* Styles now use global style.css */
</style>
