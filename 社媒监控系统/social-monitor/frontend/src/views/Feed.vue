<template>
  <div class="view-enter">
    <div class="panel">
      <div class="filters">
        <button
          v-for="p in platforms"
          :key="p.value"
          class="f-btn"
          :class="{ active: selectedPlatform === p.value }"
          @click="selectedPlatform = p.value"
        >
          {{ p.label }}
        </button>
        <input
          v-model="searchQuery"
          class="form-control"
          style="margin-left: auto; width: 280px"
          placeholder="搜索消息内容..."
          @input="handleSearch"
        >
      </div>

      <div v-if="loading" class="loading-state">
        <div style="text-align: center; padding: 40px; color: var(--t3)">加载中...</div>
      </div>

      <div v-else-if="paginatedMessages.length === 0" class="empty-state">
        暂无消息数据
      </div>

      <div v-else>
        <div
          v-for="msg in paginatedMessages"
          :key="msg.id"
          class="msg-card"
        >
          <span class="msg-avatar">{{ getPlatformIcon(msg.platform) }}</span>
          <div class="m-body">
            <div class="m-head">
              <span class="m-group">{{ msg.group_name || '未知群组' }}</span>
              <span class="m-sender">{{ msg.sender_name || msg.sender_id }}</span>
              <span class="m-acct">{{ msg.receiver_account || msg.account_id }}</span>
              <span class="m-region">{{ msg.region || '-' }}</span>
              <span class="m-time">{{ formatTime(msg.timestamp) }}</span>
            </div>
            <div class="m-text">{{ msg.content || msg.text }}</div>
            <div v-if="hasMediaLink(msg)" class="m-media">
              <a :href="mediaHref(msg)" target="_blank">📎 查看附件</a>
            </div>
          </div>
        </div>

        <div v-if="totalPages > 1" class="pagination">
          <button
            :disabled="currentPage === 1"
            @click="currentPage--"
          >
            上一页
          </button>
          <button
            v-for="page in displayedPages"
            :key="page"
            :class="{ active: currentPage === page }"
            @click="currentPage = page"
          >
            {{ page }}
          </button>
          <button
            :disabled="currentPage === totalPages"
            @click="currentPage++"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import api from '@/utils/request'
import { formatShanghaiDateTime } from '@/utils/time'

const platforms = [
  { label: '全部', value: 'all' },
  { label: 'WhatsApp', value: 'whatsapp' },
  { label: 'Telegram', value: 'telegram' },
  { label: 'Teams', value: 'teams' },
]

const selectedPlatform = ref('all')
const searchQuery = ref('')
const loading = ref(false)
const messages = ref([])
const currentPage = ref(1)
const pageSize = 20
let refreshTimer = null

const filteredMessages = computed(() => {
  let result = messages.value

  if (selectedPlatform.value !== 'all') {
    result = result.filter(m => m.platform === selectedPlatform.value)
  }

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    result = result.filter(m =>
      m.text?.toLowerCase().includes(query) ||
      m.sender_name?.toLowerCase().includes(query) ||
      m.group_name?.toLowerCase().includes(query)
    )
  }

  return result
})

const paginatedMessages = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  const end = start + pageSize
  return filteredMessages.value.slice(start, end)
})

const totalPages = computed(() => Math.ceil(filteredMessages.value.length / pageSize))

const displayedPages = computed(() => {
  const pages = []
  const max = 5
  let start = Math.max(1, currentPage.value - 2)
  let end = Math.min(totalPages.value, start + max - 1)
  if (end - start < max - 1) {
    start = Math.max(1, end - max + 1)
  }
  for (let i = start; i <= end; i++) {
    pages.push(i)
  }
  return pages
})

const initialLoad = ref(true)

const fetchMessages = async (silent = false) => {
  if (!silent) loading.value = true
  try {
    const res = await api.get('/api/messages', {
      params: {
        platform: selectedPlatform.value === 'all' ? undefined : selectedPlatform.value,
        limit: 100
      }
    })
    if (res.success) {
      const incoming = res.data || []
      if (silent && messages.value.length > 0) {
        // 静默刷新：只把真正新的消息追加到头部，不替换整个列表
        const existingIds = new Set(messages.value.map(m => m.id))
        const newMsgs = incoming.filter(m => !existingIds.has(m.id))
        if (newMsgs.length > 0) {
          messages.value = [...newMsgs, ...messages.value]
        }
      } else {
        messages.value = incoming
      }
    }
  } catch (err) {
    console.error('获取消息失败:', err)
  } finally {
    loading.value = false
    initialLoad.value = false
  }
}

const handleSearch = () => {
  currentPage.value = 1
}

const getPlatformIcon = (platform) => {
  const icons = {
    whatsapp: '📱',
    telegram: '✈️',
    teams: '👥'
  }
  return icons[platform] || '📨'
}

const formatTime = (timestamp) => {
  if (!timestamp) return ''
  return formatShanghaiDateTime(timestamp, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const hasMediaLink = (msg) => {
  return Boolean(msg?.media_available && mediaHref(msg))
}

const mediaHref = (msg) => {
  return msg?.media_path || msg?.media_url || ''
}

watch(selectedPlatform, () => {
  currentPage.value = 1
  messages.value = []
  fetchMessages(false)
})

onMounted(() => {
  fetchMessages(false)
  refreshTimer = setInterval(() => fetchMessages(true), 5000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<style scoped>
/* Styles now use global style.css */
</style>
