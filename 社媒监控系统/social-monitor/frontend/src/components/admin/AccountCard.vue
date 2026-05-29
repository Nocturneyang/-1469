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

    <div v-if="acc.platform === 'whatsapp'" class="wa-runtime">
      <div class="wa-runtime-row">
        <span>调度状态</span>
        <strong>{{ formatHealthStatus(acc.orchestrator_state || acc.health_status) }}</strong>
      </div>
      <div class="wa-runtime-grid">
        <div>
          <span>Chrome RSS</span>
          <strong>{{ formatMb(acc.chrome_rss_mb) }}</strong>
        </div>
        <div>
          <span>进程数</span>
          <strong>{{ acc.chrome_process_count || 0 }}</strong>
        </div>
        <div>
          <span>Chrome</span>
          <strong>{{ acc.chrome_version || '未知' }}</strong>
        </div>
        <div>
          <span>{{ runtimeLabel }}</span>
          <strong>{{ formatRuntimeStatus(acc.pm2_status) }}</strong>
        </div>
        <div>
          <span>模式 / 实例</span>
          <strong>{{ formatRuntimeMode(acc.pm2_mode) }} / {{ acc.pm2_pid || 0 }}</strong>
        </div>
        <div>
          <span>重启次数</span>
          <strong>{{ acc.pm2_restart_count || 0 }}</strong>
        </div>
        <div>
          <span>检查时间</span>
          <strong>{{ formatShortTime(acc.last_supervisor_check_at) }}</strong>
        </div>
        <div>
          <span>Collector</span>
          <strong>{{ formatCollectorPhase(acc.collector_phase) }}</strong>
        </div>
        <div>
          <span>心跳</span>
          <strong>{{ formatHeartbeatAge(acc.collector_heartbeat_age_seconds) }}</strong>
        </div>
      </div>
      <div v-if="acc.collector?.last_error" class="wa-runtime-reason">
        最近错误: {{ acc.collector.last_error }}
      </div>
      <div v-if="acc.last_restart_reason" class="wa-runtime-reason">
        {{ formatRestartReason(acc.last_restart_reason) }}
      </div>
    </div>

    <div v-else-if="acc.collector" class="wa-runtime">
      <div class="wa-runtime-row">
        <span>Collector</span>
        <strong>{{ formatCollectorPhase(acc.collector_phase) }}</strong>
      </div>
      <div class="wa-runtime-grid">
        <div>
          <span>心跳</span>
          <strong>{{ formatHeartbeatAge(acc.collector_heartbeat_age_seconds) }}</strong>
        </div>
        <div>
          <span>实例</span>
          <strong>{{ acc.collector.collector_id || '未知' }}</strong>
        </div>
        <div>
          <span>状态</span>
          <strong>{{ formatRuntimeStatus(acc.collector.status) }}</strong>
        </div>
        <div>
          <span>PID</span>
          <strong>{{ acc.collector.pid || 0 }}</strong>
        </div>
      </div>
      <div v-if="acc.collector?.last_error" class="wa-runtime-reason">
        最近错误: {{ acc.collector.last_error }}
      </div>
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
         <button class="btn-secondary" @click="$emit('restart', acc)">重启进程</button>
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

defineEmits(['delete', 'restart', 'relogin', 'teams-backfill', 'teams-relogin', 'tgu-ratelimit', 'tgu-reconfig', 'tgu-backfill', 'tgu-revoke', 'tgu-relogin'])

const tguName = computed(() => props.acc.id.replace('tgu-', ''))
const runtimeLabel = computed(() => {
  const provider = String(props.acc.runtime_provider || 'pm2').toLowerCase()
  if (provider === 'k8s' || provider === 'kubernetes') return 'K8s'
  if (provider === 'rainbond') return 'Rainbond'
  return 'PM2'
})

const qrCodeUrl = computed(() => {
  if (!props.acc.qr_code) return ''
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(props.acc.qr_code)}`
})

const statusClass = computed(() => {
  const s = props.acc.runtime_status || props.acc.status
  if (['online', 'authenticated', 'monitoring'].includes(s)) return 'online'
  if (s === 'qr') return 'qr'
  if (['stale_online', 'stale_heartbeat', 'degraded_high_rss', 'queued', 'cooling_down', 'starting', 'recovering_pm2', 'recovering_runtime', 'recovering_init'].includes(s)) return 'warning'
  return ''
})

const formatStatus = (status, acc) => {
  if (acc.runtime_status === 'healthy') return '在线'
  if (acc.runtime_status === 'stale_online') return '假在线'
  if (acc.runtime_status === 'stale_heartbeat') return '心跳过期'
  if (acc.runtime_status === 'degraded_high_rss') return '降级'
  if (acc.runtime_status === 'queued') return '排队中'
  if (acc.runtime_status === 'cooling_down') return '冷却中'
  if (acc.runtime_status === 'starting') return '初始化中'
  if (acc.runtime_status === 'recovering_pm2' || acc.runtime_status === 'recovering_runtime') return '恢复中'
  if (acc.runtime_status === 'recovering_init') return '恢复中'
  if (acc.runtime_status === 'pm2_down' || acc.runtime_status === 'runtime_down') return '运行时异常'
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

const formatShortTime = (timeStr) => {
  if (!timeStr) return '无'
  try {
    const normalized = timeStr.includes('T') ? timeStr : timeStr.replace(' ', 'T')
    const d = new Date(normalized)
    if (Number.isNaN(d.getTime())) return timeStr
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch (e) {
    return timeStr
  }
}

const formatMb = (value) => {
  const n = Number(value || 0)
  return n > 0 ? `${Math.round(n)} MB` : '0 MB'
}

const formatHealthStatus = (status) => {
  const m = {
    healthy: '健康',
    qr_required: '待扫码',
    qr_timeout: '扫码超时',
    initializing: '初始化',
    starting: '启动中',
    no_chrome: '无 Chrome',
    disconnected: '已断开',
    timeout: '超时',
    pm2_down: 'PM2 异常',
    runtime_down: '运行时异常',
    recovering_pm2: 'PM2 恢复中',
    recovering_runtime: '运行时恢复中',
    recovering_init: '初始化恢复中',
    cooling_down: '初始化冷却',
    queued: '排队中',
    browser_starting: '浏览器启动',
    web_loading: 'WA Web加载',
    wa_injecting: 'WA注入',
    session_restoring: '会话恢复',
    wa_state: 'WA状态同步',
    stale_heartbeat: '心跳过期',
    stale_online: '假在线',
    degraded_high_rss: '高内存降级',
    auth_failure: '认证失败',
    init_timeout: '初始化超时',
    init_failed: '初始化失败',
    no_browser_timeout: '无浏览器',
    restarting_high_rss: '高内存重启',
    restarting_no_chrome: '无 Chrome 重启'
  }
  return m[status] || status || '未知'
}

const formatCollectorPhase = (phase) => {
  const m = {
    booting: '启动中',
    profile_cleanup: '清理锁',
    queued: '排队中',
    cooling_down: '冷却中',
    init_lock_acquired: '已拿锁',
    browser_starting: '浏览器启动',
    web_loading: 'WA Web加载',
    wa_injecting: '注入中',
    session_restoring: '会话恢复',
    wa_state: '状态同步',
    authenticated: '已认证',
    ready: '采集中',
    qr_required: '待扫码',
    qr_timeout: '扫码超时',
    init_retry: '重试中',
    init_timeout: '超时',
    init_failed: '失败',
    no_browser_timeout: '无 Chrome',
    stopping: '停止中',
    disconnected: '已断开',
    auth_failure: '认证失败'
  }
  return m[phase] || phase || '无'
}

const formatHeartbeatAge = (age) => {
  if (age === null || age === undefined) return '无'
  const n = Number(age)
  if (!Number.isFinite(n)) return '无'
  if (n < 60) return `${n}s 前`
  return `${Math.round(n / 60)}m 前`
}

const formatRuntimeStatus = (status) => {
  const m = {
    online: '在线',
    stopped: '停止',
    errored: '错误',
    launching: '启动中',
    waiting: '等待',
    missing: '未注册'
  }
  return m[status] || status || '未知'
}

const formatRuntimeMode = (mode) => {
  if (!mode) return '未知'
  return mode.replace('_mode', '')
}

const formatRestartReason = (reason) => {
  const m = {
    high_chrome_rss: '最近因 Chrome RSS 超预算触发重启',
    no_chrome_process: '最近因缺少 Chrome 子进程触发重启'
  }
  return m[reason] || `最近重启: ${reason}`
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
.acc-status.warning { background: rgba(221, 107, 32, 0.14); color: var(--color-warning, #b7791f); }
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
.wa-runtime {
  width: 100%;
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
  text-align: left;
}
.wa-runtime-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  align-items: center;
}
.wa-runtime-row span,
.wa-runtime-grid span {
  color: var(--t3);
  font-size: 12px;
}
.wa-runtime-row strong,
.wa-runtime-grid strong {
  color: var(--t);
  font-size: 12px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.wa-runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.wa-runtime-grid div {
  min-height: 52px;
  padding: 8px;
  border-radius: 8px;
  background: var(--bg-tint, #fcfcfc);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
}
.wa-runtime-reason {
  margin-top: 10px;
  color: var(--color-warning, #b7791f);
  font-size: 12px;
  line-height: 1.4;
}
</style>
