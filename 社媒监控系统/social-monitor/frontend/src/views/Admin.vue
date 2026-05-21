<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">👥</span> 帐号管理</span>
        <button class="btn-primary" @click="openAddModal">+ 添加帐号</button>
      </div>

      <div v-if="loading" class="loading-state">
        <div style="text-align: center; padding: 40px; color: var(--t3)">加载中...</div>
      </div>

      <div v-else class="grid-acc">
        <AccountCard
          v-for="acc in accounts"
          :key="acc.id"
          :acc="acc"
          @delete="deleteAccount"
          @relogin="handleRelogin"
          @teams-backfill="handleTeamsBackfill"
          @teams-relogin="handleTeamsRelogin"
          @tgu-ratelimit="openRateLimitModal"
          @tgu-reconfig="openReconfigGroupsModal"
          @tgu-backfill="openBackfillModal"
          @tgu-revoke="tguRevokeSession"
        />
      </div>
    </div>

    <!-- Create Account Modal -->
    <el-dialog v-model="addModalVisible" title="新增终端设备" width="600px" @close="resetTguFlow">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="WhatsApp" name="wa">
          <el-form label-position="top">
            <el-form-item label="设备标识符 (只能为英文和数字)">
              <el-input v-model="newWaId" placeholder="例如: sales_01" />
            </el-form-item>
            <el-button type="primary" class="w-100" @click="createWaAccount">部署 WhatsApp 终端</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="Telegram Bot" name="tg-bot">
          <el-form label-position="top">
            <el-form-item label="设备标识符">
              <el-input v-model="newTgId" placeholder="bot_01" />
            </el-form-item>
            <el-form-item label="Bot Token (向 BotFather 申请)">
              <el-input v-model="newTgToken" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
            </el-form-item>
            <el-button type="primary" class="w-100" @click="createTgBot">部署 TG 官方机器人</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="Teams" name="teams">
           <el-form label-position="top">
            <el-form-item label="设备标识符">
              <el-input v-model="newTeamsId" placeholder="teams_01" />
            </el-form-item>
            <el-button type="primary" class="w-100" @click="createTeams">部署 Teams 终端</el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="TG 个人号协议" name="tgu">
          <el-alert title="严重警告: 个人号接口抓取极易封号，请配置低频拉取并使用老号！" type="error" show-icon class="mb-4" />
          
          <div v-if="tguStep === 1">
            <el-form label-position="top" size="small">
              <el-form-item label="账号名称 (仅小写字母数字,不含 tgu- 前缀)">
                <el-input v-model="tguForm.id" placeholder="例如: user01" />
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
    <el-dialog v-model="rlModalVisible" title="频控安全与风控设置" width="500px">
       <div class="mb-4 text-center">当前配置账号: <span class="font-bold">tgu-{{ _rlAccountName }}</span></div>
       <el-form label-width="120px" size="small">
          <el-form-item label="启用历史回溯">
             <el-switch v-model="rlForm.enable_backfill" />
          </el-form-item>
          <el-form-item label="自动回溯天数">
             <el-input-number v-model="rlForm.backfill_days" :min="0" :max="30" controls-position="right" />
          </el-form-item>
          <el-form-item label="每日拉取上限">
             <el-input-number v-model="rlForm.daily_limit" :min="0" :step="100" controls-position="right" />
          </el-form-item>
          <el-form-item label="登录预热期(秒)">
             <el-input-number v-model="rlForm.warmup_seconds" :min="0" controls-position="right" />
          </el-form-item>
          <el-form-item label="单次拉取批次回溯">
             <el-input-number v-model="rlForm.batch_size" :min="10" :max="100" controls-position="right" />
          </el-form-item>
          <el-form-item label="批次最小休眠(ms)">
             <el-input-number v-model="rlForm.sleep_min_ms" :min="0" :step="1000" controls-position="right" />
          </el-form-item>
          <el-form-item label="批次最大休眠(ms)">
             <el-input-number v-model="rlForm.sleep_max_ms" :min="1000" :step="1000" controls-position="right" />
          </el-form-item>
       </el-form>
       <template #footer>
          <el-button @click="rlModalVisible = false">取消</el-button>
          <el-button type="primary" @click="submitRateLimit" :loading="rlLoading">保存配置</el-button>
       </template>
    </el-dialog>

    <!-- TGU Reconfig Groups Modal -->
    <el-dialog v-model="rcModalVisible" title="重新配置监控群聊 (Whitelist)" width="500px">
       <div class="mb-4 text-center">当前配置账号: <span class="font-bold">tgu-{{ _rcAccountName }}</span></div>
       <el-form label-position="top">
          <el-form-item label="监控范围">
             <el-select v-model="rcMode" class="w-100">
                <el-option label="监听所有群聊 (高风险)" value="all" />
                <el-option label="仅监听指定群聊 (推荐)" value="partial" />
             </el-select>
          </el-form-item>
          
          <div v-show="rcMode === 'partial'" class="dialog-list-container" v-loading="rcDialogsLoading">
             <el-checkbox-group v-model="rcWhitelist">
                <el-checkbox v-for="item in rcDialogs" :key="item.id" :label="item.id" class="dialog-list-item">
                  {{ item.title }}
                </el-checkbox>
             </el-checkbox-group>
             <div v-if="!rcDialogsLoading && rcDialogs.length === 0" class="empty-text">未发现群组/频道</div>
          </div>
       </el-form>
       <template #footer>
          <el-button @click="rcModalVisible = false">取消</el-button>
          <el-button type="primary" @click="submitReconfigGroups" :loading="rcLoading">保存并重启服务</el-button>
       </template>
    </el-dialog>

    <!-- TGU Backfill Modal -->
    <el-dialog v-model="bfModalVisible" title="TG 历史回溯监控" width="600px">
       <div class="mb-4 flex-between">
         <span>当前配置账号: <span class="font-bold">tgu-{{ _bfAccountName }}</span></span>
         <div>
            <el-button size="small" type="warning" plain @click="backfillPauseAll">暂停全部</el-button>
            <el-button size="small" type="success" plain @click="backfillResumeAll">恢复全部</el-button>
         </div>
       </div>

       <el-table :data="bfTasks" style="width: 100%" v-loading="bfLoading">
          <el-table-column prop="chat_title" label="群组" show-overflow-tooltip width="200" />
          <el-table-column label="状态" width="100">
             <template #default="scope">
                <el-tag size="small" :type="getBfStatusType(scope.row.status)">{{ getBfStatusText(scope.row.status) }}</el-tag>
             </template>
          </el-table-column>
          <el-table-column prop="today_count" label="今日下载" align="right" />
          <el-table-column prop="total_count" label="总计" align="right" />
          <el-table-column label="操作" width="80" align="center">
             <template #default="scope">
                <el-button link type="danger" size="small" @click="resetBackfillTask(scope.row.chat_id)">重置</el-button>
             </template>
          </el-table-column>
       </el-table>
    </el-dialog>

  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, reactive } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Delete, RefreshRight } from '@element-plus/icons-vue'
import api from '@/utils/request'
import AccountCard from '@/components/admin/AccountCard.vue'

const accounts = ref([])
const loading = ref(true)
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
const rlLoading = ref(false)
const _rlAccountName = ref('')
const rlForm = reactive({
  enable_backfill: true,
  backfill_days: 7,
  daily_limit: 500,
  warmup_seconds: 600,
  batch_size: 50,
  sleep_min_ms: 3000,
  sleep_max_ms: 8000
})

// Reconfig Modal
const rcModalVisible = ref(false)
const rcLoading = ref(false)
const rcDialogsLoading = ref(false)
const _rcAccountName = ref('')
const rcMode = ref('partial')
const rcDialogs = ref([])
const rcWhitelist = ref([])

// Backfill Modal
const bfModalVisible = ref(false)
const bfLoading = ref(false)
const _bfAccountName = ref('')
const bfTasks = ref([])


let pollTimer = null

const fetchAccounts = async () => {
  try {
    const res = await api.get('/api/accounts')
    if (res.success) accounts.value = res.data || []
  } catch (e) {
    console.error(e)
  } finally {
    loading.value = false
  }
}

const openAddModal = () => {
  addModalVisible.value = true
}

const createWaAccount = async () => {
  if (!newWaId.value) return ElMessage.warning('请输入标识符')
  try {
    const res = await api.post('/api/accounts/create', { platform: 'whatsapp', id: newWaId.value })
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
    const res = await api.post('/api/accounts/create', { platform: 'telegram', id: newTgId.value, token: newTgToken.value })
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
    const res = await api.post('/api/accounts/create-teams', { id: newTeamsId.value })
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
    const res = await api.post('/api/accounts/delete', { id })
    if (res.success) {
      ElMessage.success('节点环境已销毁')
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
    const endpoint = isLogout ? '/api/accounts/logout' : '/api/accounts/relogin'
    const res = await api.post(endpoint, { id: acc.id })
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
    const res = await api.post('/api/teams/relogin/' + name)
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
      const res = await api.post('/api/teams/backfill/' + name + '/start', { days: parseInt(days) })
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
    const createRes = await api.post('/api/accounts/create-tg-user', {
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

    const loginRes = await api.post('/api/tg-user/start-login', {
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
    const res = await api.post('/api/tg-user/verify-code', {
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
    const res = await api.post('/api/tg-user/verify-2fa', {
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
    const res = await api.get('/api/tg-user/dialogs/' + tguForm.id)
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
    const res = await api.post('/api/tg-user/whitelist/' + tguForm.id, {
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
    const res = await api.post('/api/tg-user/revoke/' + name)
    if (res.success) {
       ElMessage.success('Session 已撤销')
       fetchAccounts()
    } else {
       ElMessage.error(res.error)
    }
  } catch(e) {}
}


// --- Rate Limit Modal ---
const openRateLimitModal = async (name) => {
  _rlAccountName.value = name
  rlModalVisible.value = true
  try {
    const res = await api.get('/api/tg-user/ratelimit/' + name)
    if (res.success && res.data) {
      const c = res.data
      rlForm.enable_backfill = c.enable_backfill
      rlForm.backfill_days = c.backfill_days
      rlForm.daily_limit = c.daily_limit
      rlForm.warmup_seconds = c.warmup_seconds
      rlForm.batch_size = c.batch_size
      rlForm.sleep_min_ms = c.sleep_min_ms
      rlForm.sleep_max_ms = c.sleep_max_ms
    }
  } catch(e) {}
}

const submitRateLimit = async () => {
  rlLoading.value = true
  try {
    const res = await api.post('/api/tg-user/ratelimit/' + _rlAccountName.value, rlForm)
    if (res.success) {
      ElMessage.success('频控配置已保存！')
      rlModalVisible.value = false
    } else {
      ElMessage.error(res.error)
    }
  } catch(e) {}
  rlLoading.value = false
}


// --- Reconfig Groups Modal ---
const openReconfigGroupsModal = async (name) => {
  _rcAccountName.value = name
  rcModalVisible.value = true
  rcDialogsLoading.value = true
  try {
    const res = await api.get('/api/tg-user/dialogs/' + name)
    if (res.success) {
       rcDialogs.value = res.data || []
       const wl = res.whitelist
       if (wl === null) {
          rcMode.value = 'all'
          rcWhitelist.value = rcDialogs.value.map(d => d.id)
       } else {
          rcMode.value = 'partial'
          rcWhitelist.value = []
          rcDialogs.value.forEach(d => {
             if(wl.includes(d.id.toString()) || wl.includes('-100'+d.id) || wl.includes(d.id)) {
                rcWhitelist.value.push(d.id)
             }
          })
       }
    } else {
       ElMessage.error(res.error)
    }
  } catch(e) {}
  rcDialogsLoading.value = false
}

const submitReconfigGroups = async () => {
  if (rcMode.value === 'partial' && rcWhitelist.value.length === 0) return ElMessage.warning('请至少选择一个群聊')
  rcLoading.value = true
  try {
    const res = await api.post('/api/tg-user/whitelist/' + _rcAccountName.value, {
       mode: rcMode.value,
       whitelist: rcWhitelist.value
    })
    if (res.success) {
       ElMessage.success('配置已保存！后台服务将自动生效')
       rcModalVisible.value = false
       await api.post('/api/accounts/relogin', { id: 'tgu-' + _rcAccountName.value })
    } else {
       ElMessage.error(res.error)
    }
  } catch(e) {}
  rcLoading.value = false
}


// --- Backfill Modal ---
const openBackfillModal = async (name) => {
  _bfAccountName.value = name
  bfModalVisible.value = true
  await loadBackfillTasks()
}

const loadBackfillTasks = async () => {
  bfLoading.value = true
  try {
    const res = await api.get('/api/tg-user/backfill/' + _bfAccountName.value)
    if (res.success) bfTasks.value = res.data || []
  } catch(e) {}
  bfLoading.value = false
}

const backfillPauseAll = async () => {
  await api.post('/api/tg-user/backfill/' + _bfAccountName.value + '/pause')
  ElMessage.success('已发送暂停指令')
  loadBackfillTasks()
}

const backfillResumeAll = async () => {
  await api.post('/api/tg-user/backfill/' + _bfAccountName.value + '/resume')
  ElMessage.success('已发送恢复指令')
  loadBackfillTasks()
}

const resetBackfillTask = async (chatId) => {
  try {
    await ElMessageBox.confirm('确定重置该群的回溯进度？将从头重新拉取', '提示', { type: 'warning' })
    await api.post('/api/tg-user/backfill/' + _bfAccountName.value + '/reset', { chat_id: chatId })
    ElMessage.success('已重置回溯进度')
    loadBackfillTasks()
  } catch(e) {}
}

const getBfStatusType = (status) => {
  const m = { pending: 'warning', running: 'success', paused: 'info', completed: 'success', error: 'danger' }
  return m[status] || 'info'
}
const getBfStatusText = (status) => {
  const m = { pending: '待处理', running: '进行中', paused: '已暂停', completed: '已完成', error: '出错' }
  return m[status] || status
}


onMounted(() => {
  fetchAccounts()
  pollTimer = setInterval(fetchAccounts, 5000)
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
</style>
