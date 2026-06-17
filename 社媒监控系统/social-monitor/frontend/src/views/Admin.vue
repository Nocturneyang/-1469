<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">👥</span> 帐号管理</span>
        <button class="btn-primary" @click="openAddModal">+ 添加帐号</button>
      </div>

      <WaSupervisorStatus
        :wa-supervisor="waSupervisor"
        :loading="waSupervisorLoading"
        @refresh="fetchWaSupervisor"
      />

      <div v-if="loading" class="loading-state">
        <div style="text-align: center; padding: 40px; color: var(--t3)">加载中...</div>
      </div>

      <div v-else class="grid-acc">
        <AccountCard
          v-for="acc in accounts"
          :key="acc.id"
          :acc="acc"
          @delete="deleteAccount"
          @restart="handleRestart"
          @relogin="handleRelogin"
          @teams-backfill="handleTeamsBackfill"
          @teams-relogin="handleTeamsRelogin"
          @tgu-ratelimit="openRateLimitModal"
          @tgu-reconfig="openReconfigGroupsModal"
          @tgu-backfill="openBackfillModal"
          @tgu-revoke="tguRevokeSession"
          @tgu-relogin="openTguReloginModal"
        />
      </div>
    </div>

    <!-- Create Account Modal -->
    <el-dialog v-model="addModalVisible" title="新增终端设备" width="600px" @close="resetTguFlow">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="WhatsApp" name="wa">
          <el-form label-position="top">
            <el-form-item label="设备标识符 (支持英文、数字、下划线、横线，可使用驼峰命名)">
              <el-input v-model="newWaId" placeholder="例如: sales_01 或 SalesAccount" />
            </el-form-item>
            <el-button type="primary" class="w-100" @click="createWaAccount">部署 WhatsApp 终端</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="Telegram Bot" name="tg-bot">
          <el-form label-position="top">
            <el-form-item label="设备标识符 (支持英文、数字、下划线、横线，可使用驼峰命名)">
              <el-input v-model="newTgId" placeholder="例如: bot_01 或 BotAccount" />
            </el-form-item>
            <el-form-item label="Bot Token (向 BotFather 申请)">
              <el-input v-model="newTgToken" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
            </el-form-item>
            <el-button type="primary" class="w-100" @click="createTgBot">部署 TG 官方机器人</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="Teams" name="teams">
           <el-form label-position="top">
            <el-form-item label="设备标识符 (支持英文、数字、下划线、横线，可使用驼峰命名)">
              <el-input v-model="newTeamsId" placeholder="例如: teams_01 或 TeamsAccount" />
            </el-form-item>
            <el-button type="primary" class="w-100" @click="createTeams">部署 Teams 终端</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="TG 个人号协议" name="tgu">
          <el-alert title="严重警告: 个人号接口抓取极易封号，请配置低频拉取并使用老号！" type="error" show-icon class="mb-4" />
          
          <div v-if="tguStep === 1">
            <el-form label-position="top" size="small">
              <el-form-item label="账号名称 (支持英文、数字、下划线、横线，可使用驼峰命名，不含 tgu- 前缀)">
                <el-input v-model="tguForm.id" placeholder="例如: user01 或 UserAccount" />
              </el-form-item>
              
              <el-row :gutter="10">
                <el-col :span="12">
                   <el-form-item label="API ID (从 my.telegram.org 获取)">
                     <el-input v-model="tguForm.apiId" placeholder="API ID" />
                   </el-form-item>
                </el-col>
                <el-col :span="12">
                   <el-form-item label="API Hash">
                     <el-input v-model="tguForm.apiHash" placeholder="API Hash" />
                   </el-form-item>
                </el-col>
              </el-row>
              
              <el-form-item label="登录手机号 (必须包含国家代码，如 +8613800138000)">
                 <el-input v-model="tguForm.phone" placeholder="+8613800138000" />
              </el-form-item>

              <el-row :gutter="10">
                <el-col :span="12">
                  <el-form-item label="每日私聊/群组抓取条数上限">
                    <el-input-number v-model="tguForm.dailyLimit" :min="0" :step="100" class="w-100" controls-position="right" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="初次回溯天数 (0为不回溯)">
                    <el-input-number v-model="tguForm.backfillDays" :min="0" :max="30" class="w-100" controls-position="right" />
                  </el-form-item>
                </el-col>
              </el-row>
              
              <div class="rate-presets mb-4">
                 <el-button size="small" type="success" plain @click="applyTguPreset('conservative')">保守模式(建议新号)</el-button>
                 <el-button size="small" type="warning" plain @click="applyTguPreset('standard')">标准模式</el-button>
                 <el-button size="small" type="danger" plain @click="applyTguPreset('unlimited')">激进模式(易封号)</el-button>
              </div>
              
              <el-button type="primary" class="w-100" @click="tguSendCode" :loading="tguLoading">
                📱 发送验证码
              </el-button>
            </el-form>
          </div>

          <div v-else-if="tguStep === 2">
            <el-alert title="验证码已发送至手机或其它在线设备" type="success" :closable="false" class="mb-4" />
            <el-form label-position="top">
              <el-form-item label="请输入 5 位数登录验证码">
                <el-input v-model="tguForm.code" placeholder="12345" />
              </el-form-item>
              <el-button type="primary" class="w-100" @click="tguVerifyCode" :loading="tguLoading">✅ 验证登录</el-button>
              <el-button class="w-100 mt-2" @click="tguStep = 1">返回修改</el-button>
            </el-form>
          </div>

          <div v-else-if="tguStep === 3">
            <el-alert title="此账号开启了二次验证 (2FA)" type="warning" :closable="false" class="mb-4" />
             <el-form label-position="top">
              <el-form-item label="请输入两步验证密码">
                <el-input v-model="tguForm.password" type="password" placeholder="密码" show-password />
              </el-form-item>
              <el-button type="primary" class="w-100" @click="tguVerify2FA" :loading="tguLoading">🔓 提交2FA密码</el-button>
            </el-form>
          </div>

          <div v-else-if="tguStep === 4">
             <el-alert title="登录成功！请配置要监控的具体防封控白名单群组。" type="success" :closable="false" class="mb-4" />
             <el-form label-position="top">
                <el-form-item label="监控范围">
                   <el-select v-model="tguForm.monitorMode" class="w-100">
                      <el-option label="监听所有群聊 (高风险)" value="all" />
                      <el-option label="仅监听指定群聊 (推荐)" value="partial" />
                   </el-select>
                </el-form-item>
                
                <div v-if="tguForm.monitorMode === 'partial'" class="dialog-list-container" v-loading="tguDialogsLoading">
                   <el-checkbox-group v-model="tguForm.whitelist">
                      <el-checkbox v-for="item in tguForm.dialogs" :key="item.id" :label="item.id">
                        {{ item.title }}
                      </el-checkbox>
                   </el-checkbox-group>
                   <div v-if="!tguDialogsLoading && tguForm.dialogs.length === 0" class="empty-text">未发现群组/频道</div>
                </div>

                <el-button type="primary" class="w-100 mt-4" @click="submitTguWhitelist" :loading="tguLoading">
                  💾 保存监控规则并启动
                </el-button>
             </el-form>
          </div>

        </el-tab-pane>
      </el-tabs>
    </el-dialog>

    <!-- TGU Rate Limit Modal -->
    <TguRateLimitModal
      v-model="rlModalVisible"
      :account-name="_rlAccountName"
    />

    <!-- TGU Reconfig Groups Modal -->
    <TguReconfigGroupsModal
      v-model="rcModalVisible"
      :account-name="_rcAccountName"
      @success="fetchAccounts"
    />

    <!-- TGU Backfill Modal -->
    <TguBackfillModal
      v-model="bfModalVisible"
      :account-name="_bfAccountName"
    />

  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getAccounts,
  getWaSupervisorStatus,
  createWaAccount as createWaAccountApi,
  createTeamsAccount,
  createTgUserAccount,
  restartAccount,
  reloginAccount,
  logoutAccount,
  deleteAccountApi,
  startTgUserLogin,
  verifyTgCode,
  verifyTg2FA,
  getTgUserDialogs,
  getTgUserConfig,
  updateTgUserWhitelist,
  reloginTeams,
  startTeamsBackfill,
  revokeTgUser,
  getTgRateLimit
} from '@/api/accounts'
import AccountCard from '@/components/admin/AccountCard.vue'
import WaSupervisorStatus from '@/components/admin/WaSupervisorStatus.vue'
import TguBackfillModal from '@/components/admin/TguBackfillModal.vue'
import TguRateLimitModal from '@/components/admin/TguRateLimitModal.vue'
import TguReconfigGroupsModal from '@/components/admin/TguReconfigGroupsModal.vue'

const accounts = ref([])
const loading = ref(true)
const waSupervisor = ref(null)
const waSupervisorLoading = ref(false)
const addModalVisible = ref(false)
const activeTab = ref('wa')

const newWaId = ref('')
const newTgId = ref('')
const newTgToken = ref('')
const newTeamsId = ref('')

// TGU Login Flow
const tguStep = ref(1)
const tguLoading = ref(false)
const tguDialogsLoading = ref(false)
const tguForm = reactive({
  id: '',
  apiId: '',
  apiHash: '',
  phone: '',
  dailyLimit: 500,
  backfillDays: 7,
  code: '',
  password: '',
  monitorMode: 'partial',
  dialogs: [],
  whitelist: []
})

// Rate Limit Modal
const rlModalVisible = ref(false)
const _rlAccountName = ref('')

// Reconfig Modal
const rcModalVisible = ref(false)
const _rcAccountName = ref('')

// Backfill Modal
const bfModalVisible = ref(false)
const _bfAccountName = ref('')

let pollTimer = null

const fetchAccounts = async () => {
  try {
    const res = await getAccounts()
    if (res.success) accounts.value = res.data || []
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

const fetchWaSupervisor = async () => {
  waSupervisorLoading.value = true
  try {
    const res = await getWaSupervisorStatus()
    if (res.success) waSupervisor.value = res.data
  } catch (e) {
    console.error(e)
  } finally {
    waSupervisorLoading.value = false
  }
}

const refreshAdminData = () => {
  fetchAccounts()
  fetchWaSupervisor()
}

const openAddModal = () => {
  addModalVisible.value = true
}

const createWaAccount = async () => {
  if (!newWaId.value) return ElMessage.warning('请输入标识符')
  try {
    const res = await createWaAccountApi({ platform: 'whatsapp', id: newWaId.value })
    if (res.success) {
      ElMessage.success('进程启动指令已下发！请查看列表获取扫描二维码')
      addModalVisible.value = false
      fetchAccounts()
    } else {
      ElMessage.error(res.error)
    }
  } catch (e) {}
}

const createTgBot = async () => {
  if (!newTgId.value || !newTgToken.value) return ElMessage.warning('请输入完整信息')
  try {
    const res = await createWaAccountApi({ platform: 'telegram', id: newTgId.value, token: newTgToken.value })
    if (res.success) {
      ElMessage.success('TG 机器人启动成功')
      addModalVisible.value = false
      fetchAccounts()
    } else {
      ElMessage.error(res.error)
    }
  } catch (e) {}
}

const createTeams = async () => {
  if (!newTeamsId.value) return ElMessage.warning('请输入标识符')
  try {
    const res = await createTeamsAccount({ id: newTeamsId.value })
    if (res.success) {
      ElMessage.success('Teams 进程已启动！请在账号管理页面点击「登录引导」')
      addModalVisible.value = false
      fetchAccounts()
    } else {
      ElMessage.error(res.error)
    }
  } catch (e) {}
}

const deleteAccount = async (id) => {
  try {
    await ElMessageBox.confirm('系统将停止 PM2 节点进程并销毁数据，确定删除吗？', '危险警告', {
      type: 'error', confirmButtonText: '删除'
    })
    const res = await deleteAccountApi(id)
    if (res.success) {
      ElMessage.success('节点环境已销毁')
      fetchAccounts()
    } else {
       ElMessage.error(res.error)
    }
  } catch (e) {}
}

const handleRestart = async (acc) => {
  try {
    await ElMessageBox.confirm('确定要重启该账号进程吗？这会保留登录态，不会清除 Session。', '提示', { type: 'warning' })
    const res = await restartAccount({ id: acc.id })
    if (res.success) {
      ElMessage.success('重启指令已发送，登录态已保留')
      fetchAccounts()
    } else {
      ElMessage.error(res.error)
    }
  } catch (e) {}
}

const handleRelogin = async (acc, actionType) => {
  try {
    const isLogout = actionType === 'logout'
    await ElMessageBox.confirm(isLogout ? '确定要注销下线该账号吗？' : '确定要重新启动该账号进行登录吗？', '提示', { type: 'warning' })
    const res = isLogout ? await logoutAccount({ id: acc.id }) : await reloginAccount({ id: acc.id })
    if (res.success) {
      ElMessage.success('指令已发送')
      fetchAccounts()
    } else {
      ElMessage.error(res.error)
    }
  } catch (e) {}
}

const handleTeamsRelogin = async (acc) => {
  try {
    const name = acc.id.replace('teams-', '')
    await ElMessageBox.confirm('确定要重新登录账号 ' + acc.id + '？ 这将清除已保存的 Session。', '警告', { type: 'warning' })
    const res = await reloginTeams(name)
    if (res.success) {
      ElMessage.success('Session 已清除，进程重启中...')
      fetchAccounts()
    } else {
      ElMessage.error(res.error)
    }
  } catch(e) {}
}

const handleTeamsBackfill = async (acc) => {
  try {
    const { value: days } = await ElMessageBox.prompt('请输入回溯天数（建议 7 天内）:', '回溯指令', {
      inputValue: '7',
      inputPattern: /^[0-9]+$/,
      inputErrorMessage: '请输入数字'
    })
    if(days) {
      const name = acc.id.replace('teams-', '')
      const res = await startTeamsBackfill(name, { days: parseInt(days) })
      if(res.success) ElMessage.success('回溯指令已发送，请查看日志确认状态')
      else ElMessage.error(res.error)
    }
  } catch(e) {}
}


// --- TG User Flow ---
const applyTguPreset = (preset) => {
  if (preset === 'conservative') {
    tguForm.dailyLimit = 500
    tguForm.backfillDays = 7
  } else if (preset === 'standard') {
    tguForm.dailyLimit = 2000
    tguForm.backfillDays = 7
  } else {
    tguForm.dailyLimit = 0
    tguForm.backfillDays = 0
  }
}

const resetTguFlow = () => {
  tguStep.value = 1
  tguForm.code = ''
  tguForm.password = ''
  tguForm.dialogs = []
  tguForm.whitelist = []
}

const tguSendCode = async () => {
  if (!tguForm.id || !tguForm.apiId || !tguForm.apiHash || !tguForm.phone) return ElMessage.warning('请填写所有必填项')
  tguLoading.value = true
  try {
    const createRes = await createTgUserAccount({
      id: tguForm.id,
      api_id: tguForm.apiId,
      api_hash: tguForm.apiHash,
      daily_limit: tguForm.dailyLimit,
      backfill_days: tguForm.backfillDays
    })

    if (!createRes.success && !createRes.message?.includes('创建成功')) {
      tguLoading.value = false
      return ElMessage.error('创建失败：' + createRes.error)
    }

    const loginRes = await startTgUserLogin({
      account_name: tguForm.id,
      phone: tguForm.phone,
      api_id: tguForm.apiId,
      api_hash: tguForm.apiHash
    })

    if (loginRes.success) {
      tguStep.value = 2
      ElMessage.success('验证码已发送！')
    } else {
      ElMessage.error(loginRes.error)
    }
  } catch(e) {
  } finally {
    tguLoading.value = false
  }
}

const tguVerifyCode = async () => {
  if (!tguForm.code) return ElMessage.warning('请输入验证码')
  tguLoading.value = true
  try {
    const res = await verifyTgCode({
      account_name: tguForm.id,
      code: tguForm.code
    })
    if (res.need2fa) {
      tguStep.value = 3
    } else if (res.success) {
      tguStep.value = 4
      ElMessage.success('验证成功！请配置监控范围')
      loadTguDialogs()
    } else {
      ElMessage.error('验证失败：' + res.error)
    }
  } catch(e) {}
  tguLoading.value = false
}

const tguVerify2FA = async () => {
  if (!tguForm.password) return ElMessage.warning('请输入密码')
  tguLoading.value = true
  try {
    const res = await verifyTg2FA({
      account_name: tguForm.id,
      password: tguForm.password
    })
    if (res.success) {
      tguStep.value = 4
      ElMessage.success('2FA 验证成功！请配置监控范围')
      loadTguDialogs()
    } else {
      ElMessage.error('验证失败：' + res.error)
    }
  } catch(e) {}
  tguLoading.value = false
}

const loadTguDialogs = async () => {
  tguDialogsLoading.value = true
  try {
    const res = await getTgUserDialogs(tguForm.id)
    if (res.success) {
      tguForm.dialogs = res.data || []
      tguForm.whitelist = tguForm.dialogs.map(d => d.id) // check all by default
    } else {
      ElMessage.error(res.error)
    }
  } catch(e) {}
  tguDialogsLoading.value = false
}

const submitTguWhitelist = async () => {
  if (tguForm.monitorMode === 'partial' && tguForm.whitelist.length === 0) {
    return ElMessage.warning('请至少选择一个群聊')
  }
  tguLoading.value = true
  try {
    const res = await updateTgUserWhitelist(tguForm.id, {
      mode: tguForm.monitorMode,
      whitelist: tguForm.whitelist
    })
    if (res.success) {
      ElMessage.success('账号配置完成！进入预热期...')
      addModalVisible.value = false
      fetchAccounts()
    } else {
      ElMessage.error(res.error)
    }
  } catch(e) {}
  tguLoading.value = false
}

const tguRevokeSession = async (name) => {
  try {
    await ElMessageBox.confirm('确定撤销账号 tgu-' + name + ' 的 Session 并停止进程吗？', '警告', { type: 'warning' })
    const res = await revokeTgUser(name)
    if (res.success) {
       ElMessage.success('Session 已撤销')
       fetchAccounts()
    } else {
       ElMessage.error(res.error)
    }
  } catch(e) {}
}

const openTguReloginModal = async (acc) => {
  const name = acc.id.replace('tgu-', '')
  tguLoading.value = true
  try {
    // 1. 获取现有 API 凭证
    const configRes = await getTgUserConfig(name)
    // 2. 获取现有频控与回溯配置
    const rlRes = await getTgRateLimit(name)
    
    // 3. 填充登录表单
    tguForm.id = name
    tguForm.phone = ''
    tguForm.code = ''
    tguForm.password = ''
    tguForm.apiId = configRes.success && configRes.api_id ? String(configRes.api_id) : ''
    tguForm.apiHash = configRes.success && configRes.api_hash ? configRes.api_hash : ''
    
    if (rlRes.success && rlRes.data) {
      tguForm.dailyLimit = rlRes.data.daily_limit || 2000
      tguForm.backfillDays = rlRes.data.backfill_days !== undefined ? rlRes.data.backfill_days : 7
    }
    
    // 4. 打开对话框并切到 TG 个人号 Tab
    tguStep.value = 1
    activeTab.value = 'tgu'
    addModalVisible.value = true
    
    ElMessage.info(`已自动载入账号 tgu-${name} 的 API 凭证与频控配置，请输入手机号以重新登录。`)
  } catch (e) {
    ElMessage.error('载入账号配置失败：' + (e.message || e))
  } finally {
    tguLoading.value = false
  }
}


// --- Rate Limit Modal ---
const openRateLimitModal = (name) => {
  _rlAccountName.value = name
  rlModalVisible.value = true
}

// --- Reconfig Groups Modal ---
const openReconfigGroupsModal = (name) => {
  _rcAccountName.value = name
  rcModalVisible.value = true
}

// --- Backfill Modal ---
const openBackfillModal = (name) => {
  _bfAccountName.value = name
  bfModalVisible.value = true
}

onMounted(() => {
  refreshAdminData()
  pollTimer = setInterval(refreshAdminData, 5000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
/* Styles now use global style.css */
.w-100 { width: 100%; }
.mb-4 { margin-bottom: 16px; }
.mt-4 { margin-top: 16px; }
.mt-2 { margin-top: 8px; }
.font-bold { font-weight: bold; }
.text-center { text-align: center; }
.flex-between { display: flex; justify-content: space-between; align-items: center; }
.rate-presets { display: flex; gap: 10px; justify-content: center; margin-top: 10px; }
.wa-supervisor-strip {
  margin: 0 0 18px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #ffffff;
  box-shadow: var(--out-shadow);
}
.wa-supervisor-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 14px;
}
.wa-supervisor-title {
  font-weight: 800;
  color: var(--t);
  font-size: 15px;
}
.wa-supervisor-sub {
  margin-top: 4px;
  color: var(--t3);
  font-size: 12px;
}
.wa-supervisor-metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(120px, 1fr));
  gap: 10px;
}
.wa-metric {
  min-height: 62px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-tint, #fcfcfc);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
}
.wa-metric span {
  color: var(--t3);
  font-size: 12px;
}
.wa-metric strong {
  color: var(--t);
  font-size: 14px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.dialog-list-container {
  max-height: 250px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  margin-top: 10px;
  background: var(--bg-tint);
}
.dialog-list-item {
  display: block;
  margin-bottom: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
}
.empty-text {
  text-align: center;
  color: var(--t3);
  font-size: 12px;
  padding: 10px 0;
}
@media (max-width: 980px) {
  .wa-supervisor-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .wa-supervisor-head {
    align-items: flex-start;
  }
  .wa-supervisor-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
