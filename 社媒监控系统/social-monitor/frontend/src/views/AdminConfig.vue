<template>
  <div class="view-enter">
    <!-- 只读模式提示 -->
    <div v-if="!authStore.isAdmin" class="alert-error">
      🔒 只读模式：您当前以游客身份访问，只能查看配置，无法修改
    </div>

    <!-- 分析引擎运行摘要 -->
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">🔬</span> 分析引擎运行摘要</span>
      </div>
      <div v-if="analyticsLoading" class="empty-state loading-pulse">读取分析库数据...</div>
      <div v-else-if="!analyticsReady" class="empty-state">analytics.sqlite 尚未初始化</div>
      <div v-else class="analytics-grid">
        <div class="analytics-card">
          <div class="analytics-icon" style="background:#e9d8fd;color:#805ad5">📊</div>
          <div class="analytics-content">
            <div class="analytics-value">{{ analytics.totalAlerts }}</div>
            <div class="analytics-label">累计告警次数</div>
          </div>
        </div>
        <div class="analytics-card">
          <div class="analytics-icon" style="background:#fed7d7;color:#c53030">🚨</div>
          <div class="analytics-content">
            <div class="analytics-value" style="color:#c53030">{{ analytics.p0 }}</div>
            <div class="analytics-label">P0 紧急告警</div>
          </div>
        </div>
        <div class="analytics-card">
          <div class="analytics-icon" style="background:#feebc8;color:#c05621">⚠️</div>
          <div class="analytics-content">
            <div class="analytics-value" style="color:#c05621">{{ analytics.p1 }}</div>
            <div class="analytics-label">P1 聚合告警</div>
          </div>
        </div>
        <div class="analytics-card">
          <div class="analytics-icon" style="background:#bee3f8;color:#2b6cb0">📋</div>
          <div class="analytics-content">
            <div class="analytics-value" style="color:#2b6cb0">{{ analytics.openIssues }}</div>
            <div class="analytics-label">待处理问题</div>
          </div>
        </div>
        <div class="analytics-card">
          <div class="analytics-icon" style="background:#c6f6d5;color:#276749">✅</div>
          <div class="analytics-content">
            <div class="analytics-value" style="color:#276749">{{ analytics.closedIssues }}</div>
            <div class="analytics-label">已闭环问题</div>
          </div>
        </div>
      </div>
    </div>

    <WebhookConfig
      ref="webhookConfigRef"
      :envConfig="envConfig"
      :regionWebhooks="regionWebhooks"
      :loading="loading"
      :availableRegions="availableRegions"
      :readonly="!authStore.isAdmin"
      @save-env="handleSaveWebhookEnv"
      @clear-env="handleClearEnv"
      @delete-region-wh="handleDeleteRegionWh"
      @add-region-wh="handleAddRegionWh"
      @save-region-wh="fetchConfig"
    />

    <AiEnvConfig
      :envConfig="envConfig"
      :loading="loading"
      :readonly="!authStore.isAdmin"
      @save-env="handleSaveAiEnv"
      @delete-env="handleDeleteAiEnv"
      @test-ai="testAiConfig"
    />

    <ValueLabelConfig
      :valueLabels="valueLabels"
      :labelOverrides="labelOverrides"
      :loading="loading"
      :readonly="!authStore.isAdmin"
      @refresh="fetchConfig"
    />

    <!-- 内部员工白名单 -->
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">👥</span> 内部员工白名单</span>
      </div>
      <p style="font-size:13px;color:var(--t3);margin-bottom:16px;line-height:1.7">
        系统根据此列表识别哪些发言人属于内部运营或技术团队，以便过滤掉内部消息的告警并准确跟踪问题解决和审核进度。
      </p>
      <div style="display:grid;gap:12px">
        <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px">
          <div style="font-size:13px;font-weight:700;color:var(--t2);margin-bottom:8px">精确匹配 (Whitelist)</div>
          <div style="font-size:13px;color:var(--t3);word-break:break-all">{{ staffConfig.whitelist?.join('、') || '未配置' }}</div>
        </div>
        <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px">
          <div style="font-size:13px;font-weight:700;color:var(--t2);margin-bottom:8px">模糊匹配关键词 (Keywords)</div>
          <div style="font-size:13px;color:var(--t3);word-break:break-all">{{ staffConfig.keywords?.join('、') || '未配置' }}</div>
        </div>
      </div>
    </div>

    <!-- 区域账号映射 -->
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">🗺️</span> 区域账号映射</span>
        <button class="btn-primary" @click="openRegionModal()" :disabled="!authStore.isAdmin">+ 新增映射</button>
      </div>
      <p style="font-size:13px;color:var(--t3);margin-bottom:16px;line-height:1.7">
        告警路由与日报区域分组依赖此配置。新增 WhatsApp/Telegram 账号后，在此绑定区域负责人即可自动路由 @。
      </p>
      <div v-if="!availableRegions || availableRegions.length === 0" class="empty-state">暂无区域映射配置</div>
      <div v-else style="overflow-x:auto">
        <table style="width:100%;border-collapse:separate;border-spacing:0 10px">
          <thead>
            <tr style="font-size:12px;font-weight:800;color:var(--t3);text-transform:uppercase;letter-spacing:1px">
              <th style="padding:0 16px 4px;text-align:left">账号 ID</th>
              <th style="padding:0 16px 4px;text-align:left">平台</th>
              <th style="padding:0 16px 4px;text-align:left">业务板块</th>
              <th style="padding:0 16px 4px;text-align:left">区域</th>
              <th style="padding:0 16px 4px;text-align:left">标签</th>
              <th style="padding:0 16px 4px;text-align:left">负责人</th>
              <th style="padding:0 16px 4px;text-align:left">钉钉 ID</th>
              <th style="padding:0 16px 4px;text-align:left">备注</th>
              <th style="padding:0 16px 4px;text-align:center">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in availableRegions" :key="item.account" style="background:#fff">
              <td style="padding:14px 16px"><code>{{ item.account }}</code></td>
              <td style="padding:14px 16px">
                <span class="tag slate">{{ item.platform.toUpperCase() }}</span>
              </td>
              <td style="padding:14px 16px">{{ item.business_sector || '-' }}</td>
              <td style="padding:14px 16px;font-weight:700">{{ item.region }}</td>
              <td style="padding:14px 16px">
                <select v-model="item.value_label" @change="updateAccountLabel(item.account, item.value_label)" class="form-control" style="font-size:12px;padding:4px 8px">
                  <option value="L0">L0 关键</option>
                  <option value="L1">L1 常规</option>
                  <option value="L2">L2 低频</option>
                  <option value="L3">L3 静默</option>
                </select>
              </td>
              <td style="padding:14px 16px">{{ item.owner || '未设置' }}</td>
              <td style="padding:14px 16px">{{ item.owner_dingtalk_id || '-' }}</td>
              <td style="padding:14px 16px;max-width:200px;overflow:hidden;text-overflow:ellipsis">{{ item.description || '-' }}</td>
              <td style="padding:14px 16px;text-align:center">
                <button class="el-btn" @click="editRegion(item)" :disabled="!authStore.isAdmin">编辑</button>
                <button class="el-btn danger" @click="deleteRegion(item.account)" :disabled="!authStore.isAdmin">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 区域映射弹窗 -->
    <div v-if="regionModalVisible" class="modal-backdrop" @click.self="regionModalVisible = false">
      <div class="modal">
        <h3>新增 / 更新区域映射</h3>
        <div class="field-group">
          <label class="field-label">账号 ID <span style="color:var(--color-danger);font-size:12px">* 必填</span></label>
          <select class="field-input" v-model="regionForm.account">
            <option value="">-- 请选择账号 --</option>
            <option v-for="acc in allAccounts" :key="acc.id" :value="acc.id">{{ acc.id }} ({{ acc.platform }})</option>
          </select>
          <div style="font-size:12px;color:var(--t3);margin-top:6px">对应数据库 receiver_account 字段值，需先在「帐号管理」中添加</div>
        </div>
        <div class="field-group">
          <label class="field-label">平台 <span style="color:var(--color-danger);font-size:12px">* 必填</span></label>
          <select class="field-input" v-model="regionForm.platform">
            <option value="wa">WhatsApp</option>
            <option value="tg">Telegram Bot</option>
            <option value="tgu">Telegram User</option>
            <option value="teams">Teams</option>
          </select>
        </div>
        <div class="field-group">
          <label class="field-label">业务板块</label>
          <input class="field-input" v-model="regionForm.business_sector" placeholder="例如：设备技术、出海业务（非必填）" />
        </div>
        <div class="field-group">
          <label class="field-label">区域名称 <span style="color:var(--color-danger);font-size:12px">* 必填</span></label>
          <input class="field-input" v-model="regionForm.region" placeholder="例如：欧美区" />
        </div>
        <div class="field-group">
          <label class="field-label">区域负责人</label>
          <input class="field-input" v-model="regionForm.owner" placeholder="如：Jasmine-001" />
        </div>
        <div class="field-group">
          <label class="field-label">钉钉用户 ID <span style="color:var(--t3);font-size:12px">用于 P0 告警 @</span></label>
          <input class="field-input" v-model="regionForm.owner_dingtalk_id" placeholder="可留空，后续补充" />
        </div>
        <div class="field-group">
          <label class="field-label">备注说明</label>
          <input class="field-input" v-model="regionForm.description" placeholder="如：欧美区主力账号，覆盖巴西/墨西哥方向" />
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="regionModalVisible = false">取消</button>
          <button class="btn-primary" @click="submitRegion">保存映射</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '@/utils/request'
import { useAuthStore } from '@/store/auth'
import WebhookConfig from '@/components/admin/WebhookConfig.vue'
import AiEnvConfig from '@/components/admin/AiEnvConfig.vue'
import ValueLabelConfig from '@/components/admin/ValueLabelConfig.vue'

const authStore = useAuthStore()

const loading = ref(true)
const envConfig = ref({})
const regionWebhooks = ref({})
const availableRegions = ref([])
const webhookConfigRef = ref(null)
const allAccounts = ref([])
const regionModalVisible = ref(false)
const regionForm = reactive({
  account: '',
  platform: 'wa',
  business_sector: '',
  region: '',
  owner: '',
  owner_dingtalk_id: '',
  description: ''
})

const valueLabels = ref([])
const labelOverrides = ref([])

const analyticsLoading = ref(true)
const analyticsReady = ref(false)
const analytics = ref({ totalAlerts: 0, p0: 0, p1: 0, openIssues: 0, closedIssues: 0 })
const staffConfig = ref({ whitelist: [], keywords: [] })

const fetchConfig = async () => {
  loading.value = true
  try {
    const [resEnv, resWh, resLabels, resAnalytics, resStaff, resRegions] = await Promise.all([
      api.get('/api/config/env').catch(() => null),
      api.get('/api/config/webhooks').catch(() => null),
      api.get('/api/config/value-labels').catch(() => null),
      api.get('/api/analytics/summary').catch(() => null),
      api.get('/api/config/staff').catch(() => null),
      api.get('/api/config/regions').catch(() => null)
    ])

    if (resEnv && resEnv.success) {
      envConfig.value = resEnv.data || {}
    }

    if (resWh && resWh.success) {
      regionWebhooks.value = resWh.data || {}
    }

    if (resLabels && resLabels.success && resLabels.data) {
      valueLabels.value = resLabels.data.baseLabels || []
      labelOverrides.value = resLabels.data.overrides || []
    }

    if (resAnalytics && resAnalytics.success && resAnalytics.data) {
      analyticsReady.value = resAnalytics.data.ready || false
      if (resAnalytics.data.ready) {
        analytics.value = resAnalytics.data
      }
    }
    analyticsLoading.value = false

    if (resStaff && resStaff.success && resStaff.data) {
      staffConfig.value = resStaff.data
    }

    if (resRegions && resRegions.success) {
      availableRegions.value = resRegions.data || []
    }
  } catch (error) {
    console.error(error)
  } finally {
    loading.value = false
  }
}

const handleSaveWebhookEnv = async ({ key, url, secret }) => {
  try {
    const payload = {}
    payload[key] = url
    if (secret) payload[key + '_SECRET'] = secret
    const res = await api.post('/api/config/env', payload)
    if (res.success) {
      ElMessage.success('Webhook 已保存')
      fetchConfig()
    } else {
      ElMessage.error(res.error || '保存失败')
    }
  } catch (e) { ElMessage.error('保存失败') }
}

const handleClearEnv = async (key) => {
  try {
    await ElMessageBox.confirm('确定要清空此项配置吗？', '警告', { type: 'warning' })
    const payload = {}
    payload[key] = ''
    payload[key + '_SECRET'] = ''
    const res = await api.post('/api/config/env', payload)
    if (res.success) {
      ElMessage.success('已清空')
      fetchConfig()
    }
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('清空失败')
  }
}

const handleSaveAiEnv = async ({ key, value }) => {
  try {
    if (!key) return
    if (!value) {
      ElMessage.error('配置值不能为空，如需删除请点击删除')
      return
    }
    const payload = {}
    payload[key] = value
    const res = await api.post('/api/config/env', payload)
    if (res.success) {
      ElMessage.success('AI 配置已保存')
      fetchConfig()
    } else {
      ElMessage.error(res.error || '保存失败')
    }
  } catch (e) {
    ElMessage.error('保存失败')
  }
}

const handleDeleteAiEnv = async (key) => {
  try {
    await ElMessageBox.confirm(`确定删除 ${key} 配置吗？`, '警告', { type: 'warning' })
    const payload = {}
    payload[key] = ''
    const res = await api.post('/api/config/env', payload)
    if (res.success) {
      ElMessage.success('AI 配置已删除')
      fetchConfig()
    } else {
      ElMessage.error(res.error || '删除失败')
    }
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('删除失败')
  }
}

const testAiConfig = async () => {
  try {
    const res = await api.get('/api/ai/test')
    if (res.success) {
      ElMessage.success(`AI 接口正常：${res.reply || 'OK'} (${res.latencyMs}ms)`)
    } else {
      ElMessage.error(`AI 接口异常：${res.status || ''} ${res.error || '测试失败'}`)
    }
  } catch (e) {
    ElMessage.error('AI 接口测试失败')
  }
}

const handleDeleteRegionWh = async (whKey) => {
  try {
    await ElMessageBox.confirm(`确定删除区域配置 ${whKey} 吗？`, '警告', { type: 'warning' })
    const res = await api.delete('/api/config/webhooks/' + encodeURIComponent(whKey))
    if (res.success) {
      ElMessage.success('已删除')
      fetchConfig()
    }
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('删除失败')
  }
}

const handleAddRegionWh = (type) => {
  if (webhookConfigRef.value) {
    webhookConfigRef.value.openRegionModal(type)
  }
}

const fetchAllAccounts = async () => {
  try {
    const res = await api.get('/api/accounts')
    if (res.success) {
      allAccounts.value = res.data || []
    }
  } catch (e) {
    console.error('fetchAccounts error', e)
  }
}

const openRegionModal = async (editData = null) => {
  regionModalVisible.value = true
  await fetchAllAccounts()

  if (editData) {
    regionForm.account = editData.account
    regionForm.platform = editData.platform
    regionForm.business_sector = editData.business_sector || ''
    regionForm.region = editData.region
    regionForm.owner = editData.owner || ''
    regionForm.owner_dingtalk_id = editData.owner_dingtalk_id || ''
    regionForm.description = editData.description || ''
  } else {
    regionForm.account = ''
    regionForm.platform = 'wa'
    regionForm.business_sector = ''
    regionForm.region = ''
    regionForm.owner = ''
    regionForm.owner_dingtalk_id = ''
    regionForm.description = ''
  }
}

const editRegion = (item) => {
  openRegionModal(item)
}

const deleteRegion = async (account) => {
  try {
    await ElMessageBox.confirm(`确定删除区域映射「${account}」吗？`, '警告', { type: 'warning' })
    const res = await api.delete('/api/config/regions/' + encodeURIComponent(account))
    if (res.success) {
      ElMessage.success(res.message || '已删除')
      fetchConfig()
    } else {
      ElMessage.error(res.error || '删除失败')
    }
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('删除失败')
  }
}

const submitRegion = async () => {
  if (!regionForm.account || !regionForm.region || !regionForm.platform) {
    ElMessage.error('账号ID、区域名称和平台为必填项')
    return
  }

  try {
    const res = await api.post('/api/config/regions', {
      account: regionForm.account,
      platform: regionForm.platform,
      business_sector: regionForm.business_sector,
      region: regionForm.region,
      owner: regionForm.owner,
      owner_dingtalk_id: regionForm.owner_dingtalk_id,
      description: regionForm.description
    })
    if (res.success) {
      ElMessage.success(res.message || '保存成功')
      regionModalVisible.value = false
      fetchConfig()
    } else {
      ElMessage.error(res.error || '保存失败')
    }
  } catch (e) {
    ElMessage.error('保存失败')
  }
}

const updateAccountLabel = async (account, valueLabel) => {
  try {
    const res = await api.post('/api/config/value-labels', {
      type: 'account',
      key: account,
      value_label: valueLabel
    })
    if (res.success) {
      ElMessage.success(res.message || '标签更新成功')
      fetchConfig()
    } else {
      ElMessage.error(res.error || '更新失败')
    }
  } catch (e) {
    ElMessage.error('更新失败')
  }
}

onMounted(() => {
  fetchConfig()
})
</script>

<style scoped>
/* Styles now use global style.css */
.analytics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.analytics-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--rs);
  box-shadow: var(--out-shadow);
  transition: all 0.2s ease;
}

.analytics-card:hover {
  border-color: #D6BCFA;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  transform: translateY(-2px);
}

.analytics-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  font-size: 24px;
  flex-shrink: 0;
}

.analytics-content {
  flex: 1;
  min-width: 0;
}

.analytics-value {
  font-size: 28px;
  font-weight: 800;
  line-height: 1.2;
  margin-bottom: 4px;
}

.analytics-label {
  font-size: 13px;
  color: var(--t3);
  font-weight: 600;
}
</style>
