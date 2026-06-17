<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">📝</span> 内容模板库</span>
      </div>
      <p style="font-size:13px;color:var(--t3);margin-bottom:20px">客服审核对话中自动提取短信模板及合规要点。</p>

      <div class="filters">
        <input
          type="text"
          class="form-control"
          style="flex: 1; min-width: 200px; max-width: 300px"
          v-model="keyword"
          placeholder="搜索模板内容/合规备注..."
          @keyup.enter="search"
        >
        <select class="form-control" style="max-width: 160px" v-model="customer" @change="search">
          <option value="">全部客户</option>
          <option v-for="c in customers" :key="c" :value="c">{{ c }}</option>
        </select>
        <select class="form-control" style="max-width: 160px" v-model="type" @change="search">
          <option value="">全部类型</option>
          <option value="OTP验证码">OTP验证码</option>
          <option value="Marketing营销">Marketing营销</option>
          <option value="Notification通知">Notification通知</option>
          <option value="其他">其他</option>
        </select>
        <button class="btn-primary" @click="search">🔍 搜索</button>
      </div>

      <div v-if="loading" class="empty-state loading-pulse">加载模板数据...</div>

      <div v-else-if="items.length === 0" class="empty-state">输入关键词搜索内容模板</div>

      <div v-else>
        <div v-for="item in items" :key="item.id" class="msg-card" style="flex-direction: column; gap: 8px">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
            <span style="font-size: 14px; font-weight: 700; color: var(--t)">{{ item.customer_name || '未知客户' }}</span>
            <div style="display: flex; gap: 8px; font-size: 12px; color: var(--t3)">
              <span v-if="item.source_type === 'asset_discovery'" class="tag">资产发现</span>
              <span class="tag">{{ item.template_type || '未分类' }}</span>
              <span>频次: {{ item.frequency || 0 }}</span>
            </div>
          </div>
          <div style="font-size: 14px; color: var(--t2); line-height: 1.6; background: var(--bg-tint); padding: 12px; border-radius: 8px; font-family: monospace; white-space: pre-wrap">{{ item.template_content }}</div>
          <div v-if="item.compliance_notes" style="font-size: 13px; color: var(--color-warning)">📋 合规备注: {{ item.compliance_notes }}</div>
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
import { formatShanghaiDateTime } from '@/utils/time'

const keyword = ref('')
const customer = ref('')
const type = ref('')
const customers = ref([])
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
  return formatShanghaiDateTime(dateStr, {
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
    const res = await api.get('/api/content-templates', { params: { keyword: keyword.value, customer: customer.value, type: type.value, page: page.value, limit } })
    if (res.success) { items.value = res.data || []; total.value = res.total || 0 }
  } catch (e) { console.error(e) }
  loading.value = false
}

const fetchCustomers = async () => {
  try {
    const res = await api.get('/api/content-templates/customers')
    if (res.success) customers.value = res.data || []
  } catch (e) {}
}

onMounted(() => { fetchCustomers(); fetchData() })
</script>

<style scoped>
/* Styles now use global style.css */
</style>
