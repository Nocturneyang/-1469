<template>
  <div class="acc-card">
    <div class="acc-status" :class="statusClass">{{ formatStatus(acc.status, acc) }}</div>
    <div class="acc-icon">
      <span v-if="acc.platform === 'whatsapp'">🟢</span>
      <span v-else-if="acc.id.startsWith('tgu-')">🟣</span>
      <span v-else-if="acc.platform === 'telegram' && acc.id.startsWith('bot_')">🔵</span>
      <span v-else-if="acc.platform === 'teams'">🟦</span>
      <span v-else>📱</span>
    </div>
    <div class="acc-name">{{ getPlatformName(acc) }}</div>
    <div style="color:var(--t3);font-size:13px;margin-bottom:4px">{{ acc.id }}</div>
    <div v-if="acc.pushname && acc.pushname !== 'Loading...'" style="font-weight:700;color:var(--p);font-size:14px">{{ acc.pushname }}</div>

    <!-- 运行状态评估 -->
    <div style="margin-top: 14px; padding: 10px 14px; border-radius: 12px; background: var(--bg-tint, #fcfcfc); font-size: 13px; width: 100%; border: 1px solid var(--border); box-shadow: var(--in-shadow); text-align: left;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 6px; align-items: center;">
        <span style="color: var(--t3); font-size: 12px;">运行评估:</span>
        <span :style="{ color: acc.health_color || 'var(--t2)', fontWeight: 'bold', fontSize: '13px' }">
          {{ acc.health_assessment || '未知' }}
        </span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="color: var(--t3); font-size: 12px;">上条录入:</span>
        <span style="color: var(--t2); font-size: 12px; font-weight: 500;">
          {{ formatLatestMsgTime(acc.latest_msg_time) }}
        </span>
      </div>
    </div>

    <div v-if="acc.status === 'qr' && acc.qr_code && acc.platform === 'whatsapp'" class="qr-container">
      <img :src="qrCodeUrl" style="max-width:180px;display:block;margin:0 auto" />
      <div style="font-size:12px;color:var(--color-danger);margin-top:6px;text-align:center">请扫描二维码登录</div>
    </div>

    <div class="card-actions">
      <!-- Specific actions for Teams -->
      <template v-if="acc.platform === 'teams'">
        <template v-if="['authenticated', 'monitoring'].includes(acc.status)">
          <button class="btn-secondary" @click="$emit('teams-backfill', acc)">回溯</button>
          <button class="btn-secondary danger" @click="$emit('teams-relogin', acc)">重新登录</button>
        </template>
        <template v-else-if="acc.status === 'qr'">
          <button class="btn-secondary" @click="$emit('teams-relogin', acc)">登录引导</button>
        </template>
        <template v-else>
          <button class="btn-secondary" @click="$emit('teams-relogin', acc)">重新登录</button>
        </template>
        <button class="btn-secondary danger" @click="$emit('delete', acc.id)">删除</button>
      </template>

      <!-- Specific actions for TG User Protocol -->
      <template v-else-if="acc.id.startsWith('tgu-')">
        <template v-if="['authenticated','monitoring','warmup'].includes(acc.status)">
          <button class="btn-secondary" @click="$emit('tgu-ratelimit', tguName)">频控</button>
          <button class="btn-secondary" @click="$emit('tgu-reconfig', tguName)">监控群聊</button>
          <button class="btn-secondary" @click="$emit('tgu-backfill', tguName)">回溯</button>
          <button class="btn-secondary danger" @click="$emit('tgu-revoke', tguName)">撤销Session</button>
        </template>
        <template v-else>
          <button class="btn-secondary" @click="$emit('tgu-ratelimit', tguName)">频控</button>
          <button class="btn-secondary" @click="$emit('tgu-reconfig', tguName)">监控群聊</button>
          <button class="btn-secondary" @click="$emit('tgu-relogin', acc)">重新登录</button>
          <button class="btn-secondary danger" @click="$emit('delete', acc.id)">删除</button>
        </template>
      </template>

      <!-- Regular actions -->
      <template v-else>
         <button v-if="acc.status === 'authenticated'" class="btn-secondary" @click="$emit('relogin', acc, 'logout')">下线退出</button>
         <button v-else class="btn-secondary" @click="$emit('relogin', acc, 'relogin')">重新登录</button>
         <button class="btn-secondary danger" @click="$emit('delete', acc.id)">永久删除</button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  acc: { type: Object, required: true }
})

defineEmits(['delete', 'relogin', 'teams-backfill', 'teams-relogin', 'tgu-ratelimit', 'tgu-reconfig', 'tgu-backfill', 'tgu-revoke', 'tgu-relogin'])

const tguName = computed(() => props.acc.id.replace('tgu-', ''))

const qrCodeUrl = computed(() => {
  if (!props.acc.qr_code) return ''
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(props.acc.qr_code)}`
})

const statusClass = computed(() => {
  const s = props.acc.status
  if (['online', 'authenticated', 'monitoring'].includes(s)) return 'online'
  if (s === 'qr') return 'qr'
  return ''
})

const formatStatus = (status, acc) => {
  if (['authenticated', 'monitoring'].includes(status)) return acc.platform === 'telegram' && acc.id.startsWith('tgu-') ? '监听中' : '在线'
  if (status === 'warmup') return '预热中🟡'
  if (status === 'qr') return acc.platform === 'teams' ? '待网页授权' : '待扫码'
  if (status === 'session_invalid') return 'Session失效🔴'
  if (['logging_in','need_2fa'].includes(status)) return '登录中🟠'
  if (status === 'initializing') return '初始化中'
  if (status === 'timeout') return '未登录(超时)🔴'
  return status
}

const getPlatformName = (acc) => {
  if (acc.platform === 'whatsapp') return 'WhatsApp'
  if (acc.platform === 'teams') return 'Teams'
  if (acc.id.startsWith('tgu-')) return 'TG 用户号'
  return 'TG 机器人'
}

const formatLatestMsgTime = (timeStr) => {
  if (!timeStr) return '无记录'
  try {
    const formattedStr = timeStr.replace(' ', 'T') + 'Z'
    const d = new Date(formattedStr)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch (e) {
    return timeStr
  }
}
</script>

<style scoped>
.acc-card {
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: var(--rs);
  box-shadow: var(--out-shadow);
  padding: 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  position: relative;
  transition: all .3s ease;
}
.acc-card:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
  transform: translateY(-2px);
}
.acc-status {
  position: absolute;
  top: 20px;
  right: 20px;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 20px;
  background: rgba(0,0,0,0.05);
}
.acc-status.online { background: rgba(37, 211, 102, 0.15); color: var(--color-success); }
.acc-status.qr { background: rgba(252, 129, 129, 0.15); color: var(--color-danger); }
.acc-icon { font-size: 40px; margin-bottom: 12px; }
.acc-name { font-size: 18px; font-weight: 800; color: var(--t); margin-bottom: 6px; }
.card-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 18px;
  flex-wrap: wrap;
}
.qr-container {
  margin: 20px 0;
  padding: 12px;
  background: white;
  border-radius: 12px;
  box-shadow: var(--in-shadow);
}
</style>
