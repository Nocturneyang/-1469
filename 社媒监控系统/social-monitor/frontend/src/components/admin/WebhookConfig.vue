<template>
  <div class="panel">
    <div class="panel-title">
      <span class="title-text"><span class="panel-icon">🔔</span> 钉钉机器人 Webhook</span>
    </div>
    <p class="wh-desc">二级目录结构：点击展开配置各类告警通道。优先级回退链：<strong>区域专属 → 平台兜底 → 全局配置</strong>。</p>

    <div class="wh-accordion">
      <!-- 业务告警 -->
      <div class="wh-group">
        <div class="wh-group-header" :class="{ open: open.ALERT }" @click="open.ALERT = !open.ALERT">
          <div class="wh-hdr-left">🚨 <span>业务告警</span> <small>(P0/P1/P2/SID 实时推送)</small></div>
          <span class="wh-arrow">▶</span>
        </div>
        <div class="wh-group-body" :class="{ open: open.ALERT }">
          <div class="cli" v-for="item in alertItems" :key="item.label">
            <div style="flex:1">
              <div class="cli-row">
                <span v-if="item.tag" class="cli-tag" :class="item.tagClass">{{ item.tag }}</span>
                <span class="cli-label">{{ item.label }}</span>
              </div>
              <div v-if="item.hint" class="cli-hint">{{ item.hint }}</div>
              <span class="cli-badge" :class="{ set: isSet(item.envKey) }">{{ isSet(item.envKey) ? '✓ 已配置' : '未配置' }}</span>
            </div>
            <div class="cli-actions">
              <button class="el-btn" @click="openEdit(item.envKey, item.label)">编辑全局</button>
              <button class="el-btn" :disabled="readonly" @click="openRegionModal(item.type)">+ 区域/板块</button>
              <button class="el-btn danger" @click="$emit('clear-env', item.envKey)">清空</button>
            </div>
          </div>
          <template v-for="item in alertItems" :key="item.type + '-routes'">
            <template v-if="Object.keys(getGroupedRegions(item.type)).length">
              <div class="route-type-title">
                <span v-if="item.tag" class="cli-tag" :class="item.tagClass">{{ item.tag }}</span>
                <span>{{ item.label }} · 区域/板块专属</span>
              </div>
              <template v-for="(regions, platform) in getGroupedRegions(item.type)" :key="platform">
                <div class="platform-header">
                  <span class="cli-tag tag-p0">{{ platform }}</span>
                  <span style="font-size:13px;font-weight:600;color:var(--t2)">{{ platform }} 平台 · {{ Object.keys(regions).length }} 条路由</span>
                </div>
                <div class="cli" v-for="(val, routeKey) in regions" :key="routeKey">
                  <div style="flex:1">
                    <div class="cli-label">{{ routeLabel(val) }}</div>
                    <div class="cli-url">{{ getUrlPreview(val) }}</div>
                  </div>
                  <div class="cli-actions">
                    <button class="el-btn" @click="openViewRegion(val)">查看</button>
                    <button class="el-btn" :disabled="readonly" @click="openEditRegionWebhook(item.type, platform, routeKey, val)">编辑</button>
                    <button class="el-btn danger" @click="$emit('delete-region-wh', val.key)">删除</button>
                  </div>
                </div>
              </template>
            </template>
          </template>
          <button class="btn-add" @click="openRegionModal('ALERT')">+ 新增通用告警区域/板块</button>
        </div>
      </div>

      <!-- 日报 -->
      <div class="wh-group">
        <div class="wh-group-header" :class="{ open: open.DIGEST }" @click="open.DIGEST = !open.DIGEST">
          <div class="wh-hdr-left">📋 <span>日报</span> <small>(每日 09:00 群汇总)</small></div>
          <span class="wh-arrow">▶</span>
        </div>
        <div class="wh-group-body" :class="{ open: open.DIGEST }">
          <div class="cli">
            <div style="flex:1">
              <span class="cli-label">全局配置（兜底）</span>
              <span class="cli-badge" :class="{ set: isSet('DINGTALK_DIGEST') }">{{ isSet('DINGTALK_DIGEST') ? '✓ 已配置' : '未配置' }}</span>
            </div>
            <div class="cli-actions">
              <button class="el-btn" @click="openEdit('DINGTALK_DIGEST', '日报全局配置')">编辑</button>
              <button class="el-btn danger" @click="$emit('clear-env', 'DINGTALK_DIGEST')">清空</button>
            </div>
          </div>
          <!-- 按平台分组的区域配置 -->
          <template v-for="(regions, platform) in getGroupedRegions('DIGEST')" :key="platform">
            <div class="platform-header">
              <span class="cli-tag tag-digest">{{ platform }}</span>
              <span style="font-size:13px;font-weight:600;color:var(--t2)">{{ platform }} 平台 · {{ Object.keys(regions).length }} 个区域</span>
            </div>
            <div class="cli" v-for="(val, routeKey) in regions" :key="routeKey">
              <div style="flex:1">
                <div class="cli-row">
                  <div class="cli-label">{{ routeLabel(val) }}</div>
                  <span class="digest-mode-pill" :class="{ link: getRegionDigestMode(platform, val.region) === 'link' }">
                    {{ getRegionDigestMode(platform, val.region) === 'link' ? '链接日报' : '长文日报' }}
                  </span>
                </div>
                <div class="cli-url">{{ getUrlPreview(val) }}</div>
              </div>
              <div class="cli-actions">
                <button class="el-btn" @click="openViewRegion(val)">查看</button>
                <button class="el-btn" :disabled="readonly" @click="openEditRegionWebhook('DIGEST', platform, routeKey, val)">编辑</button>
                <button class="el-btn danger" @click="$emit('delete-region-wh', val.key)">删除</button>
              </div>
            </div>
          </template>
          <button class="btn-add" @click="openRegionModal('DIGEST')">+ 新增区域/板块</button>
        </div>
      </div>

      <!-- 周报 -->
      <div class="wh-group">
        <div class="wh-group-header" :class="{ open: open.WEEKLY }" @click="open.WEEKLY = !open.WEEKLY">
          <div class="wh-hdr-left">📊 <span>周报</span> <small>(每周一 09:00 供应商评分)</small></div>
          <span class="wh-arrow">▶</span>
        </div>
        <div class="wh-group-body" :class="{ open: open.WEEKLY }">
          <div class="cli">
            <div style="flex:1">
              <span class="cli-label">全局配置（兜底）</span>
              <span class="cli-badge" :class="{ set: isSet('DINGTALK_WEEKLY') }">{{ isSet('DINGTALK_WEEKLY') ? '✓ 已配置' : '未配置' }}</span>
            </div>
            <div class="cli-actions">
              <button class="el-btn" @click="openEdit('DINGTALK_WEEKLY', '周报全局配置')">编辑</button>
              <button class="el-btn danger" @click="$emit('clear-env', 'DINGTALK_WEEKLY')">清空</button>
            </div>
          </div>
          <template v-for="(regions, platform) in getGroupedRegions('WEEKLY')" :key="platform">
            <div class="platform-header">
              <span class="cli-tag tag-weekly">{{ platform }}</span>
              <span style="font-size:13px;font-weight:600;color:var(--t2)">{{ platform }} 平台 · {{ Object.keys(regions).length }} 个区域</span>
            </div>
            <div class="cli" v-for="(val, routeKey) in regions" :key="routeKey">
              <div style="flex:1">
                <div class="cli-label">{{ routeLabel(val) }}</div>
                <div class="cli-url">{{ getUrlPreview(val) }}</div>
              </div>
              <div class="cli-actions">
                <button class="el-btn" @click="openViewRegion(val)">查看</button>
                <button class="el-btn" :disabled="readonly" @click="openEditRegionWebhook('WEEKLY', platform, routeKey, val)">编辑</button>
                <button class="el-btn danger" @click="$emit('delete-region-wh', val.key)">删除</button>
              </div>
            </div>
          </template>
          <button class="btn-add" @click="openRegionModal('WEEKLY')">+ 新增区域/板块</button>
        </div>
      </div>

      <!-- 系统运维 -->
      <div class="wh-group">
        <div class="wh-group-header" :class="{ open: open.OPS }" @click="open.OPS = !open.OPS">
          <div class="wh-hdr-left">🔧 <span>系统运维</span> <small>(WA/TG/TGU/Teams 账号健康)</small></div>
          <span class="wh-arrow">▶</span>
        </div>
        <div class="wh-group-body" :class="{ open: open.OPS }">
          <p class="cli-hint" style="margin-bottom:10px">建议单独建一个「运维通知群」，接收全平台账号掉线/Session过期/进程崩溃告警。</p>
          <div class="cli">
            <div style="flex:1">
              <span class="cli-label">全平台统一通道</span>
              <span class="cli-badge" :class="{ set: isSet('DINGTALK_SYSTEM_OPS') }">{{ isSet('DINGTALK_SYSTEM_OPS') ? '✓ 已配置' : '未配置' }}</span>
            </div>
            <div class="cli-actions">
              <button class="el-btn" @click="openEdit('DINGTALK_SYSTEM_OPS', '系统运维 Webhook')">编辑</button>
              <button class="el-btn danger" @click="$emit('clear-env', 'DINGTALK_SYSTEM_OPS')">清空</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 查看弹窗 -->
    <div v-if="viewVisible" class="modal-backdrop" @click.self="viewVisible = false">
      <div class="modal">
        <h3>查看 Webhook 详情</h3>
        <div style="background:var(--bg-tint);padding:16px;border-radius:12px;font-family:monospace;font-size:13px;word-break:break-all;line-height:1.8">
          <div v-if="viewData.url"><strong>URL:</strong> {{ viewData.url }}</div>
          <div v-if="viewData.secret"><strong>Secret:</strong> {{ viewData.secret }}</div>
          <div v-if="viewData._comment"><strong>备注:</strong> {{ viewData._comment }}</div>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="viewVisible = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="editVisible" class="modal-backdrop" @click.self="editVisible = false">
      <div class="modal">
        <h3>编辑 {{ editTitle }}</h3>
        <div class="field-group">
          <label class="field-label">Webhook URL</label>
          <input class="field-input" v-model="editUrl" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
        </div>
        <div class="field-group">
          <label class="field-label">加签 Secret（可选）</label>
          <input class="field-input" v-model="editSecret" placeholder="SEC..." />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="editVisible = false">取消</button>
          <button class="btn-primary" @click="submitEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- 区域Webhook配置弹窗 -->
    <div v-if="regionModalVisible" class="modal-backdrop" @click.self="regionModalVisible = false">
      <div class="modal">
        <h3>{{ regionModalTitle }}</h3>
        <div class="field-group">
          <label class="field-label">生效平台</label>
          <select class="field-input" v-model="regionForm.platform" :disabled="regionForm.mode === 'edit'">
            <option value="wa">WhatsApp</option>
            <option value="tg">Telegram Bot</option>
            <option value="tgu">Telegram 用户账号</option>
            <option value="teams">Microsoft Teams</option>
          </select>
        </div>
        <div class="field-group">
          <label class="field-label">生效区域（可多选）</label>
          <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
            <label v-for="region in modalRegionOptions" :key="region.region" style="display:block;margin-bottom:6px;cursor:pointer">
              <input
                type="checkbox"
                :value="region.region"
                v-model="regionForm.regions"
                :disabled="regionForm.mode === 'edit'"
                style="margin-right:8px"
              >
              {{ region.region }} ({{ region.accounts.join('、') }})
            </label>
            <div v-if="modalRegionOptions.length === 0" class="cli-hint">当前平台暂无区域映射，请先在「区域账号映射」中添加账号。</div>
          </div>
        </div>
        <div v-if="regionForm.type === 'DIGEST'" class="field-group">
          <label class="field-label">日报推送形式</label>
          <select class="field-input" v-model="regionForm.pushMode">
            <option value="body">长文日报</option>
            <option value="link">日报链接</option>
          </select>
          <div class="field-hint">保存后，对所选平台和区域下的账号生效；链接日报只在钉钉推送入口链接，完整内容仍在生产前端查看。</div>
        </div>
        <div class="field-group">
          <label class="field-label">业务板块（可选）</label>
          <div style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
            <label v-for="sector in modalSectorOptions" :key="sector" style="display:block;margin-bottom:6px;cursor:pointer">
              <input
                type="checkbox"
                :value="sector"
                v-model="regionForm.sectors"
                :disabled="regionForm.mode === 'edit'"
                style="margin-right:8px"
              >
              {{ sector }}
            </label>
            <div v-if="modalSectorOptions.length === 0" class="cli-hint">当前平台/区域暂无板块信息；不选择则作为区域兜底通道。</div>
          </div>
          <div class="field-hint">不选择板块表示区域兜底；选择板块后会优先匹配「区域 + 业务板块」精确路由。</div>
        </div>
        <div class="field-group">
          <label class="field-label">Webhook URL</label>
          <input class="field-input" v-model="regionForm.url" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
        </div>
        <div class="field-group">
          <label class="field-label">加签 Secret（可选）</label>
          <input class="field-input" v-model="regionForm.secret" placeholder="SEC..." />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="regionModalVisible = false">取消</button>
          <button class="btn-primary" @click="submitRegionWebhook">保存配置</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/utils/request'

const props = defineProps({
  envConfig: { type: Object, required: true },
  regionWebhooks: { type: Object, default: () => ({}) },
  loading: { type: Boolean, default: false },
  availableRegions: { type: Array, default: () => [] },
  readonly: { type: Boolean, default: false }
})

const emit = defineEmits(['save-env', 'clear-env', 'delete-region-wh', 'add-region-wh', 'test-webhook', 'save-region-wh', 'save-digest-mode'])

const open = reactive({ ALERT: false, DIGEST: false, WEEKLY: false, OPS: false })

const editVisible = ref(false)
const editKey = ref('')
const editTitle = ref('')
const editUrl = ref('')
const editSecret = ref('')
const viewVisible = ref(false)
const viewData = ref({})
const DEFAULT_LINK_ONLY_ACCOUNTS = ['wa-wa_shebi', 'tgu-tgu_supplier']
const digestModeByAccount = reactive({})

const regionModalVisible = ref(false)
const regionModalTitle = ref('')
const regionForm = reactive({
  mode: 'add',
  type: '',
  platform: 'wa',
  regions: [],
  sectors: [],
  url: '',
  secret: '',
  pushMode: 'body'
})

const openEdit = (key, title) => {
  editKey.value = key
  editTitle.value = title
  editUrl.value = ''
  editSecret.value = ''
  editVisible.value = true
}

const submitEdit = () => {
  if (!editUrl.value) return
  emit('save-env', { key: editKey.value, url: editUrl.value, secret: editSecret.value })
  editVisible.value = false
}

const parseLinkOnlyAccounts = () => {
  const raw = props.envConfig?.DIGEST_LINK_ONLY_ACCOUNTS
  const accounts = raw && String(raw).trim()
    ? String(raw).split(',').map(item => item.trim()).filter(Boolean)
    : DEFAULT_LINK_ONLY_ACCOUNTS
  return new Set(accounts.filter(item => item !== '__none__'))
}

const digestAccounts = computed(() => {
  const seen = new Set()
  return (props.availableRegions || [])
    .filter(item => item?.account && !seen.has(item.account) && seen.add(item.account))
    .sort((a, b) => a.account.localeCompare(b.account))
})

const refreshDigestModes = () => {
  const linkAccounts = parseLinkOnlyAccounts()
  for (const item of digestAccounts.value) {
    digestModeByAccount[item.account] = linkAccounts.has(item.account) ? 'link' : 'body'
  }
}

const saveDigestModes = () => {
  const accounts = Object.entries(digestModeByAccount)
    .filter(([, mode]) => mode === 'link')
    .map(([account]) => account)
    .sort()
  emit('save-digest-mode', accounts)
}

const getAccountsForRegionSelection = (platform, regions) => {
  const regionSet = new Set(regions || [])
  return (props.availableRegions || [])
    .filter(item => item?.account && item.platform === platform && regionSet.has(item.region))
    .map(item => item.account)
}

const getRegionDigestMode = (platform, region) => {
  const accounts = getAccountsForRegionSelection(platform, [region])
  if (accounts.length === 0) return 'body'
  const linkAccounts = parseLinkOnlyAccounts()
  return accounts.every(account => linkAccounts.has(account)) ? 'link' : 'body'
}

const modalRegionOptions = computed(() => {
  const grouped = new Map()
  for (const item of props.availableRegions || []) {
    if (!item?.region || item.platform !== regionForm.platform) continue
    if (!grouped.has(item.region)) {
      grouped.set(item.region, { region: item.region, accounts: [] })
    }
    if (item.account) grouped.get(item.region).accounts.push(item.account)
  }
  return Array.from(grouped.values())
    .map(item => ({ ...item, accounts: item.accounts.sort() }))
    .sort((a, b) => a.region.localeCompare(b.region))
})

const modalSectorOptions = computed(() => {
  const regionSet = new Set(regionForm.regions || [])
  const sectors = new Set()
  for (const item of props.availableRegions || []) {
    if (item?.platform !== regionForm.platform) continue
    if (regionSet.size > 0 && !regionSet.has(item.region)) continue
    if (item.business_sector) sectors.add(item.business_sector)
  }
  return Array.from(sectors).sort((a, b) => a.localeCompare(b))
})

const openViewRegion = (val) => {
  viewData.value = typeof val === 'object' ? val : { url: String(val) }
  viewVisible.value = true
}

const routeLabel = (val) => {
  const region = val?.region || '未知区域'
  return val?.sector ? `${region} / ${val.sector}` : `${region} / 全板块`
}

const getUrlPreview = (val) => {
  const url = typeof val === 'object' ? (val.url || '') : String(val)
  if (!url) return ''
  return url.length > 50 ? url.slice(0, 45) + '...' : url
}

const knownPlatforms = new Set(['wa', 'tg', 'tgu', 'teams'])

const webhookPrefixMatches = (key, prefix) => {
  if (!key.startsWith(prefix + '_')) return false
  const rest = key.slice(prefix.length + 1)
  const idx = rest.indexOf('_')
  if (idx < 0) return false
  return knownPlatforms.has(rest.slice(0, idx))
}

const parseWebhookKey = (prefix, key) => {
  if (!webhookPrefixMatches(key, prefix)) return null
  const rest = key.slice(prefix.length + 1)
  const idx = rest.indexOf('_')
  const platform = rest.slice(0, idx)
  const route = rest.slice(idx + 1)
  const sectors = Array.from(new Set((props.availableRegions || []).map(item => item.business_sector).filter(Boolean)))
    .sort((a, b) => b.length - a.length)
  for (const sector of sectors) {
    const suffix = '_' + sector
    if (route.endsWith(suffix)) {
      return { platform, region: route.slice(0, -suffix.length), sector }
    }
  }
  return { platform, region: route, sector: '' }
}

const getGroupedRegions = (prefix) => {
  const grouped = {}
  for (const key of Object.keys(props.regionWebhooks)) {
    const parsed = parseWebhookKey(prefix, key)
    if (!parsed) continue
    const { platform, region, sector } = parsed
    if (!grouped[platform]) grouped[platform] = {}
    const routeKey = sector ? `${region}_${sector}` : region
    grouped[platform][routeKey] = {
      ...props.regionWebhooks[key],
      key,
      region,
      sector
    }
  }
  return grouped
}

const alertItems = [
  { envKey: 'DINGTALK_ALERT', type: 'ALERT', label: '通用告警 全局配置（最终兜底）', tag: null, tagClass: '', hint: '' },
  { envKey: 'DINGTALK_ALERT', type: 'ALERT_P0', label: '严重业务中断', tag: 'P0', tagClass: 'tag-p0', hint: '通道故障/0%送达率，直接触发' },
  { envKey: 'DINGTALK_ALERT', type: 'ALERT_P1', label: '业务异常告警', tag: 'P1', tagClass: 'tag-p1', hint: '5分钟窗口聚合 + AI评分 ≥7' },
  { envKey: 'DINGTALK_ALERT', type: 'ALERT_P2', label: '无响应告警', tag: 'P2', tagClass: 'tag-p2', hint: '外部问题15分钟内未回复' },
  { envKey: 'DINGTALK_ALERT', type: 'ALERT_SID', label: 'SID 变更告警', tag: 'SID', tagClass: 'tag-sid', hint: '3个以上节点批量更新' },
]

const isSet = (key) => {
  const v = props.envConfig?.[key]
  const setKey = key + '_set'
  if (props.envConfig?.[setKey] !== undefined) return !!props.envConfig[setKey]
  return !!(v && v !== '' && v !== '未配置')
}

watch(() => [props.envConfig?.DIGEST_LINK_ONLY_ACCOUNTS, props.availableRegions], refreshDigestModes, { immediate: true, deep: true })
watch(() => regionForm.platform, () => {
  if (regionForm.mode === 'add') {
    regionForm.regions = []
    regionForm.sectors = []
  }
})
watch(() => regionForm.regions.slice(), () => {
  if (regionForm.mode === 'add') regionForm.sectors = []
})

const openRegionModal = (type) => {
  regionForm.mode = 'add'
  regionForm.type = type
  regionForm.platform = 'wa'
  regionForm.regions = []
  regionForm.sectors = []
  regionForm.url = ''
  regionForm.secret = ''
  regionForm.pushMode = 'body'

  const typeLabels = {
    ALERT: '业务告警',
    ALERT_P0: 'P0 严重告警',
    ALERT_P1: 'P1 业务告警',
    ALERT_P2: 'P2 无响应告警',
    ALERT_SID: 'SID 变更告警',
    DIGEST: '日报',
    WEEKLY: '周报'
  }
  regionModalTitle.value = '新增 ' + (typeLabels[type] || type) + ' 区域/板块 Webhook'
  regionModalVisible.value = true
}

const openEditRegionWebhook = (type, platform, routeKey, val) => {
  const data = typeof val === 'object' ? val : { url: String(val) }
  const typeLabels = {
    ALERT: '业务告警',
    ALERT_P0: 'P0 严重告警',
    ALERT_P1: 'P1 业务告警',
    ALERT_P2: 'P2 无响应告警',
    ALERT_SID: 'SID 变更告警',
    DIGEST: '日报',
    WEEKLY: '周报'
  }
  regionForm.mode = 'edit'
  regionForm.type = type
  regionForm.platform = platform
  regionForm.regions = [data.region || routeKey]
  regionForm.sectors = data.sector ? [data.sector] : []
  regionForm.url = data.url || ''
  regionForm.secret = data.secret || ''
  regionForm.pushMode = type === 'DIGEST' ? getRegionDigestMode(platform, data.region || routeKey) : 'body'
  regionModalTitle.value = '编辑 ' + (typeLabels[type] || type) + ' 区域/板块 Webhook'
  regionModalVisible.value = true
}

const saveDigestModeForRegionForm = async () => {
  if (regionForm.type !== 'DIGEST') return
  const affectedAccounts = getAccountsForRegionSelection(regionForm.platform, regionForm.regions)
  if (affectedAccounts.length === 0) return

  const linkAccounts = parseLinkOnlyAccounts()
  for (const account of affectedAccounts) {
    if (regionForm.pushMode === 'link') {
      linkAccounts.add(account)
      digestModeByAccount[account] = 'link'
    } else {
      linkAccounts.delete(account)
      digestModeByAccount[account] = 'body'
    }
  }

  const value = Array.from(linkAccounts).sort().join(',') || '__none__'
  const res = await api.post('/api/config/env', { DIGEST_LINK_ONLY_ACCOUNTS: value })
  if (!res.success) {
    throw new Error(res.error || '日报推送形式保存失败')
  }
}

const submitRegionWebhook = async () => {
  if (!regionForm.url) {
    ElMessage.error('请输入 Webhook URL')
    return
  }
  if (regionForm.regions.length === 0) {
    ElMessage.error('请至少选择一个区域')
    return
  }

  try {
    const res = await api.post('/api/config/webhooks', {
      type: regionForm.type,
      platform: regionForm.platform,
      regions: regionForm.regions,
      sectors: regionForm.sectors,
      url: regionForm.url,
      secret: regionForm.secret
    })
    if (res.success) {
      await saveDigestModeForRegionForm()
      ElMessage.success('区域 Webhook 保存成功')
      regionModalVisible.value = false
      emit('save-region-wh')
    } else {
      ElMessage.error(res.error || '保存失败')
    }
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  }
}

defineExpose({ openRegionModal })
</script>

<style scoped>
/* Styles now use global style.css */
.wh-desc { font-size: 13px; color: var(--t3); margin-bottom: 20px; line-height: 1.6; }
.wh-accordion { margin-top: 10px; }
.wh-group { border: 1px solid var(--border); border-radius: var(--rs); margin-bottom: 12px; overflow: hidden; transition: box-shadow 0.2s; background: #fff; box-shadow: var(--out-shadow); }
.wh-group:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
.wh-group-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; cursor: pointer; background: var(--bg-tint); user-select: none; transition: background 0.15s; }
.wh-group-header:hover { background: #F0F4FF; }
.wh-group-header.open { background: #F0F4FF; border-bottom: 1px solid var(--border); }
.wh-hdr-left { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 14px; color: var(--t); }
.wh-hdr-left small { font-size: 11px; font-weight: 600; color: var(--t3); }
.wh-arrow { font-size: 12px; color: var(--t3); transition: transform 0.2s; display: inline-block; }
.wh-group-header.open .wh-arrow { transform: rotate(90deg); }
.wh-group-body { display: none; padding: 14px 18px; }
.wh-group-body.open { display: block; }

.cli { padding: 12px 16px; border-bottom: 1px solid #f7fafc; display: flex; align-items: center; justify-content: space-between; }
.cli:last-child { border-bottom: none; }
.cli-row { display: flex; align-items: center; gap: 8px; }
.cli-label { font-size: 14px; font-weight: 600; color: var(--t); }
.cli-hint { font-size: 11px; color: var(--t3); margin-top: 2px; }
.cli-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 6px; background: rgba(0,0,0,0.04); color: var(--t3); display: inline-block; margin-top: 4px; }
.cli-badge.set { background: rgba(56,161,105,0.1); color: var(--color-success); }
.cli-tag { font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 10px; }
.tag-p0 { background: rgba(229,62,62,0.1); color: #c53030; }
.tag-p1 { background: rgba(237,137,54,0.1); color: #c05621; }
.tag-p2 { background: rgba(236,201,75,0.12); color: #b7791f; }
.tag-sid { background: rgba(107,70,193,0.1); color: #6b46c1; }
.tag-digest { background: rgba(66,153,225,0.1); color: #2b6cb0; }
.tag-weekly { background: rgba(72,187,120,0.1); color: #276749; }

.platform-header { display: flex; align-items: center; gap: 8px; padding: 10px 16px; background: var(--bg-tint); border: 1px solid var(--border); border-radius: 8px; margin: 12px 0 6px 0; }
.route-type-title { display: flex; align-items: center; gap: 8px; padding: 12px 4px 4px; font-size: 13px; font-weight: 700; color: var(--t2); }
.cli-url { font-size: 12px; color: var(--t3); font-family: monospace; margin-top: 2px; word-break: break-all; }
.cli-actions { display: flex; gap: 8px; flex-shrink: 0; }
.btn-add { display: block; margin-top: 10px; background: none; border: 1px dashed var(--border); border-radius: 8px; padding: 8px; width: 100%; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--p); transition: all 0.15s; }
.btn-add:hover { border-color: var(--p); background: rgba(107,70,193,0.04); }
.digest-mode-pill { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: rgba(107,70,193,0.08); color: #6b46c1; }
.digest-mode-pill.link { background: rgba(49,130,206,0.12); color: #2b6cb0; }
.field-hint { font-size: 12px; color: var(--t3); margin-top: 6px; line-height: 1.5; }
</style>
