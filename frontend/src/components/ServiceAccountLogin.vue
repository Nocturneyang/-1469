<template>
  <main class="service-login-page">
    <header class="service-login-header">
      <div>
        <h1>服务账号登录</h1>
        <p>工作台独立 WA/TG 接入入口，任务、二维码和运行状态只写入工作台运行库</p>
      </div>
      <div class="service-login-actions">
        <el-button @click="loadRequests">刷新</el-button>
        <el-button @click="$emit('back')">返回工作台</el-button>
      </div>
    </header>

    <section class="service-login-layout">
      <section class="service-login-panel service-login-create-panel">
        <div class="service-login-panel-head">
          <h2>新增登录任务</h2>
          <span>{{ createPanelHint }}</span>
        </div>

        <el-form label-position="top" class="service-login-form">
          <div class="service-login-form-grid">
            <el-form-item label="平台">
              <el-segmented v-model="form.platform" :options="platformOptions" @change="handlePlatformChange" />
            </el-form-item>
            <el-form-item label="登录方式">
              <el-select v-model="form.login_mode">
                <el-option
                  v-for="mode in modeOptions"
                  :key="mode.value"
                  :label="mode.label"
                  :value="mode.value"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="服务账号标识">
              <el-input v-model.trim="form.account" placeholder="例如 wa-support-01 或 tg-support-bot" />
            </el-form-item>
            <el-form-item label="展示名称">
              <el-input v-model.trim="form.display_name" placeholder="例如 客服一号" />
            </el-form-item>
          </div>

          <el-form-item v-if="needsCredential" :label="credentialLabel">
            <el-input
              v-model.trim="form.credential"
              :type="showCredential ? 'text' : 'password'"
              :placeholder="credentialPlaceholder"
              show-password
            />
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

          <div class="service-login-submit">
            <span>{{ submitHint }}</span>
            <el-button type="primary" :loading="submitting" @click="submit">发起登录</el-button>
          </div>
        </el-form>
      </section>

      <section class="service-login-workspace">
        <div class="service-login-summary">
          <div>
            <span>全部任务</span>
            <strong>{{ loginSummary.total }}</strong>
          </div>
          <div>
            <span>等待扫码</span>
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
            <div class="service-login-request-head">
              <div>
                <h2>登录任务</h2>
                <span>只保存任务状态、二维码 payload 和脱敏提示，不与监控项目共享数据</span>
              </div>
              <el-tag v-if="autoRefreshing" type="success">自动刷新中</el-tag>
            </div>
          </div>

          <div v-if="loading" class="service-login-empty">加载中...</div>
          <div v-else-if="!requests.length" class="service-login-empty">暂无登录任务。</div>
          <div v-else class="service-login-list">
            <article
              v-for="request in requests"
              :key="request.request_id"
              class="service-login-request"
              :class="[
                `platform-${request.platform || 'unknown'}`,
                `status-${request.status || 'unknown'}`,
              ]"
            >
              <div class="service-login-account">
                <div class="service-login-status" :class="statusClass(request.status)">
                  {{ statusText(request.status) }}
                </div>
                <div class="service-login-avatar" :class="request.platform === 'tg' ? 'tg' : 'wa'">
                  {{ platformIcon(request) }}
                </div>
                <strong>{{ request.display_name || request.account }}</strong>
                <span>{{ platformText(request.platform) }} · {{ request.account }}</span>
                <small>{{ loginModeText(request.login_mode) }}</small>
              </div>

              <div class="service-login-request-main">
                <div class="service-login-assessment">
                  <div>
                    <span>运行评估:</span>
                    <strong :class="assessmentClass(request.status)">{{ assessmentText(request) }}</strong>
                  </div>
                  <div>
                    <span>过期时间:</span>
                    <strong>{{ timeText(request.expires_at) }}</strong>
                  </div>
                </div>

                <div class="service-login-runtime-grid">
                  <div>
                    <span>请求人</span>
                    <strong>{{ request.requested_by || '-' }}</strong>
                  </div>
                  <div>
                    <span>凭据提示</span>
                    <strong>{{ request.credential_hint || '-' }}</strong>
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
                  <span v-if="qrMatrices[request.request_id]">打开 WhatsApp 扫描二维码完成登录</span>
                </div>

                <div v-else class="service-login-credential-card">
                  <strong>{{ request.login_mode === 'tg_bot_token' ? 'TG Bot 校验任务' : 'TG 用户 Session 校验任务' }}</strong>
                  <span>{{ tgCredentialHint(request) }}</span>
                </div>

                <p v-if="request.worker_message" class="service-login-worker-message">
                  {{ request.worker_message }}
                </p>
                <p v-if="request.error_message" class="service-login-error">{{ request.error_message }}</p>
              </div>
            </article>
          </div>
        </section>
      </section>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import QRCodeModel from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import {
  createServiceAccountLoginRequest,
  fetchServiceAccountLoginRequests,
} from '../api';

defineEmits(['back']);

const platformOptions = [
  { label: 'WA', value: 'wa' },
  { label: 'TG', value: 'tg' },
];
const modeLabels = {
  wa_qr: 'WA 扫码登录',
  tg_bot_token: 'TG Bot Token',
  tg_user_session: 'TG 用户 Session',
};
const form = reactive({
  platform: 'wa',
  login_mode: 'wa_qr',
  account: '',
  display_name: '',
  credential: '',
});
const requests = ref([]);
const loading = ref(false);
const submitting = ref(false);
const showCredential = ref(false);
const qrMatrices = reactive({});
let refreshTimer = null;

const activeStatuses = new Set(['requested', 'waiting_qr', 'waiting_verification']);

const modeOptions = computed(() => (
  form.platform === 'wa'
    ? [{ label: modeLabels.wa_qr, value: 'wa_qr' }]
    : [
      { label: modeLabels.tg_bot_token, value: 'tg_bot_token' },
      { label: modeLabels.tg_user_session, value: 'tg_user_session' },
    ]
));

const needsCredential = computed(() => form.login_mode !== 'wa_qr');
const credentialLabel = computed(() => (
  form.login_mode === 'tg_user_session' ? 'TG 用户 Session' : 'TG Bot Token'
));
const credentialPlaceholder = computed(() => (
  form.login_mode === 'tg_user_session'
    ? '粘贴由工作台 TG worker 生成或导出的 session'
    : '粘贴 BotFather 生成的 token'
));
const createPanelHint = computed(() => (
  form.platform === 'wa'
    ? 'WA 任务提交后等待工作台 worker 生成二维码'
    : 'TG 登录由工作台 worker 校验，不在前端保存 token/session'
));
const submitHint = computed(() => {
  if (form.login_mode === 'wa_qr') return '提交后等待 WA worker 回写二维码，页面会自动刷新。';
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
  if (form.login_mode === 'tg_user_session') {
    return [
      { label: '1', text: '提交 TG 用户 Session', active: true },
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

onMounted(async () => {
  await loadRequests();
});

onUnmounted(() => {
  stopAutoRefresh();
});

function handlePlatformChange() {
  form.login_mode = form.platform === 'wa' ? 'wa_qr' : 'tg_bot_token';
  form.credential = '';
}

async function loadRequests() {
  loading.value = true;
  try {
    requests.value = await fetchServiceAccountLoginRequests();
    renderQrMatrices();
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
  submitting.value = true;
  try {
    await createServiceAccountLoginRequest({
      platform: form.platform,
      account: form.account,
      display_name: form.display_name || form.account,
      login_mode: form.login_mode,
      credential: needsCredential.value ? form.credential : undefined,
    });
    form.credential = '';
    await loadRequests();
    ElMessage.success('登录任务已创建');
  } catch (err) {
    ElMessage.error(err.response?.data?.error || '登录任务创建失败');
  } finally {
    submitting.value = false;
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
  if (request.login_mode === 'tg_user_session') return 'TG';
  return 'BOT';
}

function loginModeText(mode) {
  return modeLabels[mode] || mode || '-';
}

function statusText(status) {
  if (status === 'waiting_qr') return '等待二维码';
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
  if (status === 'waiting_qr' || status === 'waiting_verification') return 'warning';
  if (status === 'failed' || status === 'expired') return 'danger';
  return 'neutral';
}

function assessmentText(request) {
  if (request.status === 'authenticated') return '已接入工作台';
  if (request.status === 'waiting_qr' && request.qr_payload) return '二维码已生成';
  if (request.status === 'waiting_qr') return '等待 worker 回写二维码';
  if (request.status === 'requested') return '等待 worker 领取任务';
  if (request.status === 'waiting_verification') return '等待渠道验证';
  if (request.status === 'expired') return '任务已过期';
  if (request.status === 'failed') return '登录失败';
  if (request.status === 'canceled') return '任务已取消';
  return request.status || '未知';
}

function assessmentClass(status) {
  if (status === 'authenticated') return 'ok';
  if (status === 'waiting_qr' || status === 'waiting_verification' || status === 'requested') return 'pending';
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
  if (request.status === 'waiting_verification') return '正在等待 Telegram 返回验证结果。';
  return '凭据已提交给工作台 worker，前端只保留脱敏提示。';
}

function timeText(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}
</script>
