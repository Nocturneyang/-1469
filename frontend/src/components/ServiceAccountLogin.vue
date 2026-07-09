<template>
  <main class="service-login-page">
    <header class="service-login-header">
      <div>
        <h1>服务账号登录</h1>
        <p>按监控项目账号登录形态接入 WA/TG，任务和 session 仍只属于工作台</p>
      </div>
      <div class="service-login-actions">
        <el-button type="primary" @click="openAddModal">添加账号</el-button>
        <el-button @click="loadRequests">刷新</el-button>
        <el-button @click="$emit('back')">返回工作台</el-button>
      </div>
    </header>

    <section class="service-login-management">
      <div class="service-login-summary">
        <div>
          <span>全部账号</span>
          <strong>{{ loginSummary.total }}</strong>
        </div>
        <div>
          <span>待扫码</span>
          <strong>{{ loginSummary.waitingQr }}</strong>
        </div>
        <div>
          <span>已登录</span>
          <strong>{{ loginSummary.authenticated }}</strong>
        </div>
        <div>
          <span>异常/过期</span>
          <strong>{{ loginSummary.blocked }}</strong>
        </div>
      </div>

      <section class="service-login-panel service-login-task-panel">
        <div class="service-login-panel-head service-login-task-head">
          <div class="service-login-panel-title">
            <div class="service-login-request-head">
              <div>
                <h2>帐号管理</h2>
                <span>WA 扫码、TG Bot、TG 用户号和 StringSession 按账号卡片展示</span>
              </div>
            </div>
            <div class="service-login-panel-tools">
              <el-tag v-if="autoRefreshing" type="success">自动刷新中</el-tag>
              <el-button type="primary" @click="openAddModal">添加账号</el-button>
            </div>
          </div>
        </div>

        <div v-if="loading" class="service-login-empty">加载中...</div>
        <div v-else-if="!requests.length" class="service-login-empty">
          <strong>暂无账号</strong>
          <span>点击“添加账号”开始接入 WA 或 TG 服务账号。</span>
        </div>
        <div v-else class="service-login-list">
          <article
            v-for="request in requests"
            :key="request.request_id"
            class="service-login-account-card"
            :class="[
              `service-login-platform-${request.platform || 'unknown'}`,
              `service-login-status-${request.status || 'unknown'}`,
            ]"
          >
            <div class="service-login-card-status" :class="statusClass(request.status)">
              {{ statusText(request.status) }}
            </div>
            <div class="service-login-card-icon" :class="request.platform === 'tg' ? 'tg' : 'wa'">
              {{ platformIcon(request) }}
            </div>
            <div class="service-login-card-name">{{ accountKindText(request) }}</div>
            <div class="service-login-card-id">{{ request.account }}</div>
            <div v-if="request.display_name && request.display_name !== request.account" class="service-login-card-pushname">
              {{ request.display_name }}
            </div>

            <div class="service-login-runbox">
              <div>
                <span>运行评估</span>
                <strong :class="assessmentClass(request.status)">{{ assessmentText(request) }}</strong>
              </div>
              <div>
                <span>上次更新</span>
                <strong>{{ timeText(request.updated_at) }}</strong>
              </div>
            </div>

            <div v-if="request.login_mode === 'wa_qr'" class="service-login-qr">
              <div
                v-if="qrMatrices[request.request_id]"
                class="service-login-qr-grid"
                :style="{ '--qr-size': qrMatrices[request.request_id].size }"
                aria-label="WA 登录二维码"
              >
                <i
                  v-for="(cell, index) in qrMatrices[request.request_id].cells"
                  :key="`${request.request_id}-${index}`"
                  :class="{ dark: cell }"
                />
              </div>
              <div v-else class="service-login-qr-pending" :class="{ expired: request.status === 'expired' }">
                <strong>{{ qrPlaceholderTitle(request) }}</strong>
                <span>{{ qrPlaceholderText(request) }}</span>
              </div>
              <span v-if="qrMatrices[request.request_id]">请使用 WhatsApp 扫描二维码登录</span>
            </div>

            <div v-else class="service-login-credential-card">
              <strong>{{ tgCredentialTitle(request) }}</strong>
              <span>{{ tgCredentialHint(request) }}</span>
              <div
                v-if="shouldShowTgVerification(request) && verificationDrafts[request.request_id]"
                class="service-login-verify-form"
              >
                <el-input
                  v-if="request.status === 'waiting_code'"
                  v-model.trim="verificationDrafts[request.request_id].code"
                  placeholder="请输入 Telegram 验证码"
                  size="small"
                />
                <el-input
                  v-if="request.status === 'waiting_password'"
                  v-model="verificationDrafts[request.request_id].password"
                  type="password"
                  placeholder="请输入 Telegram 二步验证密码"
                  show-password
                  size="small"
                />
                <el-button
                  type="primary"
                  size="small"
                  :loading="isVerifying(request)"
                  @click="submitVerification(request)"
                >
                  验证登录
                </el-button>
              </div>
            </div>

            <div class="service-login-runtime-grid">
              <div>
                <span>登录方式</span>
                <strong>{{ loginModeText(request.login_mode) }}</strong>
              </div>
              <div>
                <span>请求人</span>
                <strong>{{ request.requested_by || '-' }}</strong>
              </div>
              <div>
                <span>凭据提示</span>
                <strong>{{ request.credential_hint || '-' }}</strong>
              </div>
              <div>
                <span>过期时间</span>
                <strong>{{ timeText(request.expires_at) }}</strong>
              </div>
              <div>
                <span>创建时间</span>
                <strong>{{ timeText(request.created_at) }}</strong>
              </div>
              <div>
                <span>更新时间</span>
                <strong>{{ timeText(request.updated_at) }}</strong>
              </div>
            </div>

            <p v-if="request.worker_message" class="service-login-worker-message">
              {{ request.worker_message }}
            </p>
            <p v-if="request.error_message" class="service-login-error">{{ request.error_message }}</p>

            <div class="service-login-card-actions">
              <el-button size="small" @click="openRelogin(request)">重新登录</el-button>
              <el-button
                size="small"
                type="danger"
                plain
                :icon="Delete"
                :loading="isDeleting(request)"
                @click="confirmDelete(request)"
              >
                删除
              </el-button>
            </div>
          </article>
        </div>
      </section>
    </section>

    <el-dialog
      v-model="addModalVisible"
      title="新增服务账号"
      width="620px"
      class="service-login-dialog"
      @close="resetCreateFlow"
    >
      <el-tabs v-model="activeTab">
        <el-tab-pane label="WhatsApp" name="wa">
          <el-form label-position="top" class="service-login-dialog-form">
            <el-form-item label="设备标识符">
              <el-input v-model.trim="form.account" placeholder="例如 wa_support_01 或 SalesAccount" />
            </el-form-item>
            <el-form-item label="展示名称">
              <el-input v-model.trim="form.display_name" placeholder="例如 客服一号" />
            </el-form-item>
            <div class="service-login-flow">
              <div
                v-for="step in flowSteps"
                :key="step.label"
                class="service-login-flow-step"
                :class="{ active: step.active }"
              >
                <strong>{{ step.label }}</strong>
                <span>{{ step.text }}</span>
              </div>
            </div>
            <el-button type="primary" class="service-login-dialog-submit" :loading="submitting" @click="submit">
              部署 WhatsApp 终端
            </el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="Telegram Bot" name="tg-bot">
          <el-form label-position="top" class="service-login-dialog-form">
            <el-form-item label="设备标识符">
              <el-input v-model.trim="form.account" placeholder="例如 bot_support_01 或 BotAccount" />
            </el-form-item>
            <el-form-item label="展示名称">
              <el-input v-model.trim="form.display_name" placeholder="例如 TG 客服机器人" />
            </el-form-item>
            <el-form-item label="Bot Token">
              <el-input
                v-model.trim="form.credential"
                type="password"
                placeholder="向 BotFather 申请的 token"
                show-password
              />
            </el-form-item>
            <el-button type="primary" class="service-login-dialog-submit" :loading="submitting" @click="submit">
              部署 TG 官方机器人
            </el-button>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="TG 用户号协议" name="tgu">
          <el-alert
            title="TG 用户号建议只用于低频人工服务场景，登录后仍由工作台 runtime worker 接管 session。"
            type="warning"
            show-icon
            :closable="false"
            class="service-login-dialog-alert"
          />
          <el-form v-if="tguStep === 1" label-position="top" class="service-login-dialog-form">
            <el-form-item label="账号名称">
              <el-input v-model.trim="form.account" placeholder="例如 user_support_01 或 UserAccount" />
            </el-form-item>
            <el-form-item label="展示名称">
              <el-input v-model.trim="form.display_name" placeholder="例如 TG 用户号客服" />
            </el-form-item>
            <div class="service-login-form-grid service-login-tg-api-grid">
              <el-form-item label="API ID">
                <el-input v-model.trim="form.tg_api_id" inputmode="numeric" placeholder="从 my.telegram.org 获取" />
              </el-form-item>
              <el-form-item label="API Hash">
                <el-input v-model.trim="form.tg_api_hash" type="password" placeholder="api_hash" show-password />
              </el-form-item>
            </div>
            <el-form-item label="登录手机号">
              <el-input v-model.trim="form.tg_phone_number" placeholder="必须包含国家代码，如 +8613800138000" />
            </el-form-item>
            <div class="service-login-flow">
              <div
                v-for="step in tguFlowSteps"
                :key="step.label"
                class="service-login-flow-step"
                :class="{ active: step.active }"
              >
                <strong>{{ step.label }}</strong>
                <span>{{ step.text }}</span>
              </div>
            </div>
            <el-button type="primary" class="service-login-dialog-submit" :loading="submitting" @click="submit">
              发送验证码
            </el-button>
          </el-form>

          <div v-else-if="tguStep === 2" class="service-login-dialog-form">
            <el-alert
              :title="tguStepAlertTitle"
              :type="tguStepAlertType"
              :closable="false"
              class="service-login-dialog-alert"
            />
            <div class="service-login-flow">
              <div
                v-for="step in tguFlowSteps"
                :key="step.label"
                class="service-login-flow-step"
                :class="{ active: step.active }"
              >
                <strong>{{ step.label }}</strong>
                <span>{{ step.text }}</span>
              </div>
            </div>
            <el-form label-position="top">
              <el-form-item label="请输入 5 位数登录验证码">
                <el-input v-model.trim="tguDraft.code" placeholder="12345" />
              </el-form-item>
              <el-button
                type="primary"
                class="service-login-dialog-submit"
                :loading="isActiveTguVerifying"
                :disabled="!canSubmitTguCode"
                @click="submitTguCode"
              >
                验证登录
              </el-button>
              <el-button class="service-login-dialog-submit" @click="returnToTguStart">返回修改</el-button>
            </el-form>
          </div>

          <div v-else-if="tguStep === 3" class="service-login-dialog-form">
            <el-alert
              title="此账号开启了 Telegram 二步验证"
              type="warning"
              :closable="false"
              class="service-login-dialog-alert"
            />
            <div class="service-login-flow">
              <div
                v-for="step in tguFlowSteps"
                :key="step.label"
                class="service-login-flow-step"
                :class="{ active: step.active }"
              >
                <strong>{{ step.label }}</strong>
                <span>{{ step.text }}</span>
              </div>
            </div>
            <el-form label-position="top">
              <el-form-item label="请输入两步验证密码">
                <el-input v-model="tguDraft.password" type="password" placeholder="密码" show-password />
              </el-form-item>
              <el-button
                type="primary"
                class="service-login-dialog-submit"
                :loading="isActiveTguVerifying"
                :disabled="!canSubmitTguPassword"
                @click="submitTguPassword"
              >
                提交 2FA 密码
              </el-button>
            </el-form>
          </div>

          <div v-else class="service-login-dialog-form">
            <el-alert
              title="登录成功，工作台 runtime worker 已保存 TG 用户号 session。"
              type="success"
              :closable="false"
              class="service-login-dialog-alert"
            />
            <div class="service-login-flow">
              <div
                v-for="step in tguFlowSteps"
                :key="step.label"
                class="service-login-flow-step"
                :class="{ active: step.active }"
              >
                <strong>{{ step.label }}</strong>
                <span>{{ step.text }}</span>
              </div>
            </div>
            <el-button type="primary" class="service-login-dialog-submit" @click="closeAddModal">
              完成
            </el-button>
          </div>
        </el-tab-pane>

        <el-tab-pane label="导入 StringSession" name="tg-session">
          <el-form label-position="top" class="service-login-dialog-form">
            <el-form-item label="设备标识符">
              <el-input v-model.trim="form.account" placeholder="例如 tg_session_01 或 SessionAccount" />
            </el-form-item>
            <el-form-item label="展示名称">
              <el-input v-model.trim="form.display_name" placeholder="例如 TG Session 客服号" />
            </el-form-item>
            <div class="service-login-form-grid service-login-tg-api-grid">
              <el-form-item label="API ID">
                <el-input v-model.trim="form.tg_api_id" inputmode="numeric" placeholder="从 my.telegram.org 获取" />
              </el-form-item>
              <el-form-item label="API Hash">
                <el-input v-model.trim="form.tg_api_hash" type="password" placeholder="api_hash" show-password />
              </el-form-item>
            </div>
            <el-form-item label="StringSession">
              <el-input
                v-model.trim="form.credential"
                type="password"
                placeholder="粘贴已生成或导出的 StringSession"
                show-password
              />
            </el-form-item>
            <el-button type="primary" class="service-login-dialog-submit" :loading="submitting" @click="submit">
              导入并校验 Session
            </el-button>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </el-dialog>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete } from '@element-plus/icons-vue';
import QRCodeModel from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import {
  createServiceAccountLoginRequest,
  deleteServiceAccountLoginRequest,
  fetchServiceAccountLoginRequests,
  verifyServiceAccountLoginRequest,
} from '../api';

defineEmits(['back']);

const platformOptions = [
  { label: 'WA', value: 'wa' },
  { label: 'TG', value: 'tg' },
];
const modeLabels = {
  wa_qr: 'WA 扫码登录',
  tg_bot_token: 'TG Bot Token',
  tg_user_phone: 'TG 用户号登录',
  tg_user_session: '导入 StringSession',
};
const form = reactive({
  platform: 'wa',
  login_mode: 'wa_qr',
  account: '',
  display_name: '',
  credential: '',
  tg_api_id: '',
  tg_api_hash: '',
  tg_phone_number: '',
});
const requests = ref([]);
const loading = ref(false);
const submitting = ref(false);
const deletingIds = ref(new Set());
const verifyingIds = ref(new Set());
const verificationDrafts = reactive({});
const showCredential = ref(false);
const qrMatrices = reactive({});
const addModalVisible = ref(false);
const activeTab = ref('wa');
const tguStep = ref(1);
const activeTguRequestId = ref('');
const tguDraft = reactive({
  code: '',
  password: '',
});
let refreshTimer = null;

const activeStatuses = new Set(['requested', 'waiting_qr', 'waiting_verification', 'waiting_code', 'waiting_password']);

const modeOptions = computed(() => (
  form.platform === 'wa'
    ? [{ label: modeLabels.wa_qr, value: 'wa_qr' }]
    : [
      { label: modeLabels.tg_user_phone, value: 'tg_user_phone' },
      { label: modeLabels.tg_bot_token, value: 'tg_bot_token' },
      { label: modeLabels.tg_user_session, value: 'tg_user_session' },
    ]
));

const needsCredential = computed(() => ['tg_bot_token', 'tg_user_session'].includes(form.login_mode));
const credentialLabel = computed(() => (
  form.login_mode === 'tg_user_session' ? 'StringSession' : 'TG Bot Token'
));
const credentialPlaceholder = computed(() => (
  form.login_mode === 'tg_user_session'
    ? '粘贴已生成或导出的 StringSession'
    : '粘贴 BotFather 生成的 token'
));
const createPanelHint = computed(() => (
  form.platform === 'wa'
    ? 'WA 任务提交后等待工作台 worker 生成二维码'
    : 'TG 登录由工作台 worker 校验，不在前端保存明文 token/session'
));
const submitHint = computed(() => {
  if (form.login_mode === 'wa_qr') return '提交后等待 WA worker 回写二维码，页面会自动刷新。';
  if (form.login_mode === 'tg_user_phone') return '提交后由 TG worker 发送验证码，下一步在弹窗内输入验证码。';
  if (form.login_mode === 'tg_user_session') return '提交后由 TG worker 用 API ID/Hash 校验 Session 并接管账号。';
  return '提交后由 TG worker 校验并接管登录，页面只显示脱敏提示。';
});
const flowSteps = computed(() => {
  if (form.login_mode === 'wa_qr') {
    return [
      { label: '1', text: '创建 WA 扫码任务', active: true },
      { label: '2', text: 'worker 回写二维码', active: false },
      { label: '3', text: '手机扫码后接入工作台', active: false },
    ];
  }
  if (form.login_mode === 'tg_user_phone') {
    return [
      { label: '1', text: '提交 API ID/Hash 和手机号', active: true },
      { label: '2', text: '输入 Telegram 验证码', active: false },
      { label: '3', text: '自动生成并接管 Session', active: false },
    ];
  }
  if (form.login_mode === 'tg_user_session') {
    return [
      { label: '1', text: '提交 API ID/Hash 和 Session', active: true },
      { label: '2', text: 'worker 校验账号', active: false },
      { label: '3', text: '写入工作台运行态', active: false },
    ];
  }
  return [
    { label: '1', text: '提交 Bot Token', active: true },
    { label: '2', text: 'worker 校验 Bot', active: false },
    { label: '3', text: '同步服务账号档案', active: false },
  ];
});
const tguFlowSteps = computed(() => [
  { label: '1', text: '填写 API ID/Hash 和手机号', active: tguStep.value === 1 },
  { label: '2', text: '输入 Telegram 验证码', active: tguStep.value === 2 },
  { label: '3', text: '按需提交二步验证密码', active: tguStep.value === 3 },
  { label: '4', text: '生成 Session 并接入工作台', active: tguStep.value === 4 },
]);
const loginSummary = computed(() => {
  const summary = {
    total: requests.value.length,
    waitingQr: 0,
    authenticated: 0,
    blocked: 0,
  };
  requests.value.forEach((request) => {
    if (request.status === 'waiting_qr') summary.waitingQr += 1;
    if (request.status === 'authenticated') summary.authenticated += 1;
    if (['failed', 'expired', 'canceled'].includes(request.status)) summary.blocked += 1;
  });
  return summary;
});
const autoRefreshing = computed(() => requests.value.some((request) => activeStatuses.has(request.status)));
const activeTguRequest = computed(() => (
  requests.value.find((request) => request.request_id === activeTguRequestId.value) || null
));
const isActiveTguVerifying = computed(() => (
  Boolean(activeTguRequest.value) && isVerifying(activeTguRequest.value)
));
const canSubmitTguCode = computed(() => (
  activeTguRequest.value?.status === 'waiting_code' && Boolean(String(tguDraft.code || '').trim())
));
const canSubmitTguPassword = computed(() => (
  activeTguRequest.value?.status === 'waiting_password' && Boolean(String(tguDraft.password || ''))
));
const tguStepAlertTitle = computed(() => {
  const request = activeTguRequest.value;
  if (!request) return '登录任务已提交，正在等待工作台 worker 发送验证码。';
  if (request.status === 'waiting_code') return request.worker_message || '验证码已发送至手机或其它在线设备。';
  if (request.status === 'waiting_verification') return request.worker_message || '验证信息已提交，正在等待 TG worker 返回结果。';
  if (request.status === 'failed') return request.error_message || request.worker_message || 'TG 用户号验证码发送失败。';
  if (request.status === 'expired') return '登录任务已过期，请重新发起。';
  return request.worker_message || '工作台 worker 正在处理 TG 用户号登录。';
});
const tguStepAlertType = computed(() => {
  const status = activeTguRequest.value?.status;
  if (status === 'failed') return 'error';
  if (status === 'expired' || status === 'canceled') return 'warning';
  return 'success';
});

watch(activeTab, applyActiveTab);

onMounted(async () => {
  await loadRequests();
});

onUnmounted(() => {
  stopAutoRefresh();
});

function openAddModal() {
  if (!addModalVisible.value) resetCreateForm();
  addModalVisible.value = true;
  applyActiveTab();
}

function closeAddModal() {
  addModalVisible.value = false;
}

function resetCreateFlow() {
  if (submitting.value) return;
  activeTab.value = 'wa';
  resetCreateForm();
}

function resetCreateForm() {
  form.platform = 'wa';
  form.login_mode = 'wa_qr';
  form.account = '';
  form.display_name = '';
  form.credential = '';
  form.tg_api_id = '';
  form.tg_api_hash = '';
  form.tg_phone_number = '';
  tguStep.value = 1;
  activeTguRequestId.value = '';
  tguDraft.code = '';
  tguDraft.password = '';
}

function applyActiveTab() {
  if (activeTab.value === 'wa') {
    form.platform = 'wa';
    form.login_mode = 'wa_qr';
  } else if (activeTab.value === 'tg-bot') {
    form.platform = 'tg';
    form.login_mode = 'tg_bot_token';
  } else if (activeTab.value === 'tgu') {
    form.platform = 'tg';
    form.login_mode = 'tg_user_phone';
  } else if (activeTab.value === 'tg-session') {
    form.platform = 'tg';
    form.login_mode = 'tg_user_session';
  }
  handleLoginModeChange();
  if (form.login_mode !== 'tg_user_phone') {
    tguStep.value = 1;
    activeTguRequestId.value = '';
    tguDraft.code = '';
    tguDraft.password = '';
  }
}

function handlePlatformChange() {
  form.login_mode = form.platform === 'wa' ? 'wa_qr' : 'tg_user_phone';
  form.credential = '';
  form.tg_api_id = '';
  form.tg_api_hash = '';
  form.tg_phone_number = '';
}

function handleLoginModeChange() {
  form.credential = '';
  if (!['tg_user_phone', 'tg_user_session'].includes(form.login_mode)) {
    form.tg_api_id = '';
    form.tg_api_hash = '';
    form.tg_phone_number = '';
  }
  if (form.login_mode !== 'tg_user_phone') {
    form.tg_phone_number = '';
  }
}

async function loadRequests() {
  loading.value = true;
  try {
    requests.value = await fetchServiceAccountLoginRequests();
    renderQrMatrices();
    syncVerificationDrafts();
    syncTguDialogFlow();
    syncAutoRefresh();
  } catch (err) {
    ElMessage.error('无法加载登录任务');
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!form.account) {
    ElMessage.warning('请输入服务账号标识');
    return;
  }
  if (needsCredential.value && !form.credential) {
    ElMessage.warning(`请输入${credentialLabel.value}`);
    return;
  }
  if (['tg_user_phone', 'tg_user_session'].includes(form.login_mode)) {
    const apiId = Number(form.tg_api_id);
    if (!Number.isInteger(apiId) || apiId <= 0) {
      ElMessage.warning('请输入有效的 TG API ID');
      return;
    }
    if (!form.tg_api_hash) {
      ElMessage.warning('请输入 App api_hash');
      return;
    }
  }
  if (form.login_mode === 'tg_user_phone' && !form.tg_phone_number) {
    ElMessage.warning('请输入 TG 用户号手机号');
    return;
  }
  submitting.value = true;
  try {
    const created = await createServiceAccountLoginRequest({
      platform: form.platform,
      account: form.account,
      display_name: form.display_name || form.account,
      login_mode: form.login_mode,
      credential: needsCredential.value ? form.credential : undefined,
      tg_api_id: ['tg_user_phone', 'tg_user_session'].includes(form.login_mode) ? Number(form.tg_api_id) : undefined,
      tg_api_hash: ['tg_user_phone', 'tg_user_session'].includes(form.login_mode) ? form.tg_api_hash : undefined,
      tg_phone_number: form.login_mode === 'tg_user_phone' ? form.tg_phone_number : undefined,
    });
    form.credential = '';
    form.tg_api_hash = '';
    if (created) {
      requests.value = [
        created,
        ...requests.value.filter((item) => item.request_id !== created.request_id),
      ];
      renderQrMatrices();
      syncVerificationDrafts();
      if (created.login_mode === 'tg_user_phone') {
        activeTguRequestId.value = created.request_id;
        tguStep.value = 2;
      }
      syncTguDialogFlow();
      syncAutoRefresh();
    }
    if (form.login_mode === 'tg_user_phone') {
      ElMessage.success('验证码发送任务已提交');
    } else {
      ElMessage.success('登录任务已创建');
      addModalVisible.value = false;
      resetCreateForm();
    }
    await loadRequests().catch(() => {
      ElMessage.warning('登录任务已创建，但列表刷新失败，请稍后手动刷新页面');
    });
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '登录任务创建失败');
  } finally {
    submitting.value = false;
  }
}

function openRelogin(request) {
  if (!request) return;
  activeTab.value = request.login_mode === 'wa_qr'
    ? 'wa'
    : request.login_mode === 'tg_bot_token'
      ? 'tg-bot'
      : request.login_mode === 'tg_user_session'
        ? 'tg-session'
        : 'tgu';
  applyActiveTab();
  form.account = request.account || '';
  form.display_name = request.display_name || request.account || '';
  form.credential = '';
  form.tg_api_hash = '';
  form.tg_phone_number = '';
  tguStep.value = 1;
  activeTguRequestId.value = '';
  addModalVisible.value = true;
}

function returnToTguStart() {
  tguStep.value = 1;
  activeTguRequestId.value = '';
  tguDraft.code = '';
  tguDraft.password = '';
}

async function submitTguCode() {
  await submitTguDialogVerification('code');
}

async function submitTguPassword() {
  await submitTguDialogVerification('password');
}

async function submitTguDialogVerification(kind) {
  const request = activeTguRequest.value;
  if (!request) {
    ElMessage.warning('未找到当前 TG 用户号登录任务');
    return;
  }
  if (kind === 'code' && request.status !== 'waiting_code') {
    ElMessage.warning('请等待 Telegram 验证码发送完成');
    return;
  }
  if (kind === 'password' && request.status !== 'waiting_password') {
    ElMessage.warning('请等待二步验证状态');
    return;
  }
  const draft = verificationDrafts[request.request_id] || { code: '', password: '' };
  if (kind === 'code') {
    draft.code = tguDraft.code;
    draft.password = '';
  } else {
    draft.code = '';
    draft.password = tguDraft.password;
  }
  verificationDrafts[request.request_id] = draft;
  await submitVerification(request);
}

async function submitVerification(request) {
  if (!request || isVerifying(request)) return;
  const draft = verificationDrafts[request.request_id] || {};
  if (request.status === 'waiting_code' && !String(draft.code || '').trim()) {
    ElMessage.warning('请输入 Telegram 验证码');
    return;
  }
  if (request.status === 'waiting_password' && !String(draft.password || '')) {
    ElMessage.warning('请输入 Telegram 二步验证密码');
    return;
  }

  setVerifying(request.request_id, true);
  try {
    const updated = await verifyServiceAccountLoginRequest(request.request_id, {
      code: draft.code,
      password: draft.password,
    });
    if (updated) {
      requests.value = requests.value.map((item) => (
        item.request_id === updated.request_id ? updated : item
      ));
    }
    draft.code = '';
    draft.password = '';
    syncVerificationDrafts();
    syncAutoRefresh();
    ElMessage.success('验证信息已提交');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '验证信息提交失败');
  } finally {
    setVerifying(request.request_id, false);
  }
}

async function confirmDelete(request) {
  if (!request || isDeleting(request)) return;
  try {
    await ElMessageBox.confirm(
      `删除后仅移除这条登录任务记录，不会删除 ${request.account} 的账号档案或已存在 session。`,
      '删除登录任务',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
      },
    );
  } catch (err) {
    return;
  }

  setDeleting(request.request_id, true);
  try {
    await deleteServiceAccountLoginRequest(request.request_id);
    requests.value = requests.value.filter((item) => item.request_id !== request.request_id);
    delete qrMatrices[request.request_id];
    syncAutoRefresh();
    ElMessage.success('登录任务已删除');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '删除登录任务失败');
  } finally {
    setDeleting(request.request_id, false);
  }
}

function isDeleting(request) {
  return deletingIds.value.has(request.request_id);
}

function setDeleting(requestId, deleting) {
  const next = new Set(deletingIds.value);
  if (deleting) next.add(requestId);
  else next.delete(requestId);
  deletingIds.value = next;
}

function isVerifying(request) {
  return verifyingIds.value.has(request.request_id);
}

function setVerifying(requestId, verifying) {
  const next = new Set(verifyingIds.value);
  if (verifying) next.add(requestId);
  else next.delete(requestId);
  verifyingIds.value = next;
}

function syncVerificationDrafts() {
  const activeIds = new Set();
  requests.value.forEach((request) => {
    activeIds.add(request.request_id);
    if (!verificationDrafts[request.request_id]) {
      verificationDrafts[request.request_id] = { code: '', password: '' };
    }
  });
  Object.keys(verificationDrafts).forEach((requestId) => {
    if (!activeIds.has(requestId)) delete verificationDrafts[requestId];
  });
}

function syncTguDialogFlow() {
  const request = activeTguRequest.value;
  if (!request) return;
  if (request.status === 'waiting_code') {
    tguStep.value = 2;
  } else if (request.status === 'waiting_password') {
    tguStep.value = 3;
  } else if (request.status === 'authenticated') {
    tguStep.value = 4;
    tguDraft.code = '';
    tguDraft.password = '';
  } else if (request.status === 'failed' || request.status === 'expired' || request.status === 'canceled') {
    tguStep.value = Math.max(2, tguStep.value);
  }
}

function renderQrMatrices() {
  const nextKeys = new Set();
  requests.value.forEach((request) => {
    if (!request.qr_payload) return;
    nextKeys.add(request.request_id);
    qrMatrices[request.request_id] = buildQrMatrix(request.qr_payload);
  });
  Object.keys(qrMatrices).forEach((key) => {
    if (!nextKeys.has(key)) delete qrMatrices[key];
  });
}

function buildQrMatrix(payload) {
  const qr = new QRCodeModel(-1, QRErrorCorrectLevel.M);
  qr.addData(payload);
  qr.make();
  const quietZone = 4;
  const moduleCount = qr.getModuleCount();
  const size = moduleCount + quietZone * 2;
  const cells = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const qrRow = row - quietZone;
      const qrCol = col - quietZone;
      const dark = qrRow >= 0 && qrRow < moduleCount && qrCol >= 0 && qrCol < moduleCount
        ? qr.isDark(qrRow, qrCol)
        : false;
      cells.push(dark);
    }
  }
  return { size, cells };
}

function syncAutoRefresh() {
  const shouldRefresh = requests.value.some((request) => activeStatuses.has(request.status));
  if (shouldRefresh && !refreshTimer) {
    refreshTimer = window.setInterval(() => {
      loadRequests();
    }, 3000);
  }
  if (!shouldRefresh) stopAutoRefresh();
}

function stopAutoRefresh() {
  if (!refreshTimer) return;
  window.clearInterval(refreshTimer);
  refreshTimer = null;
}

function platformText(platform) {
  if (platform === 'wa') return 'WA';
  if (platform === 'tg') return 'TG';
  return String(platform || '').toUpperCase();
}

function platformIcon(request) {
  if (request.platform === 'wa') return 'WA';
  if (request.login_mode === 'tg_user_session' || request.login_mode === 'tg_user_phone') return 'TG';
  return 'BOT';
}

function accountKindText(request) {
  if (request.platform === 'wa') return 'WhatsApp';
  if (request.login_mode === 'tg_bot_token') return 'Telegram Bot';
  if (request.login_mode === 'tg_user_session') return 'TG StringSession';
  if (request.login_mode === 'tg_user_phone') return 'TG 用户号';
  return platformText(request.platform);
}

function loginModeText(mode) {
  return modeLabels[mode] || mode || '-';
}

function statusText(status) {
  if (status === 'waiting_qr') return '等待二维码';
  if (status === 'waiting_code') return '等待验证码';
  if (status === 'waiting_password') return '等待二步密码';
  if (status === 'requested') return '已提交';
  if (status === 'waiting_verification') return '等待验证';
  if (status === 'authenticated') return '已登录';
  if (status === 'failed') return '失败';
  if (status === 'expired') return '已过期';
  if (status === 'canceled') return '已取消';
  return status || '-';
}

function statusClass(status) {
  if (status === 'authenticated') return 'online';
  if (['waiting_qr', 'waiting_verification', 'waiting_code', 'waiting_password'].includes(status)) return 'warning';
  if (status === 'failed' || status === 'expired') return 'danger';
  return 'neutral';
}

function assessmentText(request) {
  if (request.status === 'authenticated') return '已接入工作台';
  if (request.status === 'waiting_qr' && request.qr_payload) return '二维码已生成';
  if (request.status === 'waiting_qr') return '等待 worker 回写二维码';
  if (request.status === 'waiting_code') return '等待输入验证码';
  if (request.status === 'waiting_password') return '等待输入二步密码';
  if (request.status === 'requested') return '等待 worker 领取任务';
  if (request.status === 'waiting_verification') return '等待渠道验证';
  if (request.status === 'expired') return '任务已过期';
  if (request.status === 'failed') return '登录失败';
  if (request.status === 'canceled') return '任务已取消';
  return request.status || '未知';
}

function assessmentClass(status) {
  if (status === 'authenticated') return 'ok';
  if (['waiting_qr', 'waiting_verification', 'waiting_code', 'waiting_password', 'requested'].includes(status)) return 'pending';
  if (status === 'failed' || status === 'expired' || status === 'canceled') return 'bad';
  return '';
}

function qrPlaceholderTitle(request) {
  if (request.status === 'expired') return '二维码任务已过期';
  if (request.status === 'failed') return '二维码生成失败';
  if (request.status === 'authenticated') return '账号已登录';
  return '等待二维码';
}

function qrPlaceholderText(request) {
  if (request.status === 'expired') return '请重新发起 WA 扫码登录任务';
  if (request.status === 'failed') return request.error_message || '请检查 WA worker 状态后重试';
  if (request.status === 'authenticated') return '登录已完成，无需继续扫码';
  return '工作台 WA worker 领取任务后会在这里显示二维码';
}

function tgCredentialHint(request) {
  if (request.status === 'authenticated') return '校验完成，服务账号已接入工作台。';
  if (request.status === 'failed') return request.error_message || '校验失败，请检查凭据后重新发起。';
  if (request.status === 'expired') return '任务已过期，请重新提交凭据。';
  if (request.login_mode === 'tg_user_phone' && request.status === 'waiting_code') return 'Telegram 验证码已发送，请在这里输入验证码。';
  if (request.login_mode === 'tg_user_phone' && request.status === 'waiting_password') return '该账号启用了二步验证，请输入 Telegram 二步密码。';
  if (request.status === 'waiting_verification') return '正在等待 Telegram 返回验证结果。';
  if (request.login_mode === 'tg_user_phone') return '手机号和 App 信息已提交给工作台 worker，验证码不会保存在前端。';
  if (request.login_mode === 'tg_user_session') return 'API ID、api_hash 和 Session 已提交给工作台 worker，前端只保留脱敏提示。';
  return '凭据已提交给工作台 worker，前端只保留脱敏提示。';
}

function tgCredentialTitle(request) {
  if (request.login_mode === 'tg_bot_token') return 'TG Bot 校验任务';
  if (request.login_mode === 'tg_user_phone') return 'TG 用户号登录任务';
  return 'TG StringSession 校验任务';
}

function shouldShowTgVerification(request) {
  return request.login_mode === 'tg_user_phone' && ['waiting_code', 'waiting_password'].includes(request.status);
}

function timeText(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}
</script>
