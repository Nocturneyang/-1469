<template>
  <main class="service-login-page">
    <header class="service-login-header">
      <div>
        <h1>服务账号登录</h1>
        <p>工作台独立 WA/TG 接入入口</p>
      </div>
      <div class="service-login-actions">
        <el-button @click="loadRequests">刷新</el-button>
        <el-button @click="$emit('back')">返回工作台</el-button>
      </div>
    </header>

    <section class="service-login-layout">
      <section class="service-login-panel">
        <div class="service-login-panel-head">
          <h2>新增登录任务</h2>
          <span>任务写入工作台运行态库，由工作台 worker 执行登录</span>
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

          <div class="service-login-submit">
            <span>{{ submitHint }}</span>
            <el-button type="primary" :loading="submitting" @click="submit">发起登录</el-button>
          </div>
        </el-form>
      </section>

      <section class="service-login-panel">
        <div class="service-login-panel-head">
          <h2>登录任务</h2>
          <span>只保存任务状态和脱敏提示，不与监控项目共享数据</span>
        </div>

        <div v-if="loading" class="service-login-empty">加载中...</div>
        <div v-else-if="!requests.length" class="service-login-empty">暂无登录任务。</div>
        <div v-else class="service-login-list">
          <article v-for="request in requests" :key="request.request_id" class="service-login-request">
            <div class="service-login-request-head">
              <div>
                <strong>{{ request.display_name || request.account }}</strong>
                <span>{{ platformText(request.platform) }} · {{ request.account }}</span>
              </div>
              <el-tag :type="statusType(request.status)">{{ statusText(request.status) }}</el-tag>
            </div>
            <dl>
              <div>
                <dt>登录方式</dt>
                <dd>{{ loginModeText(request.login_mode) }}</dd>
              </div>
              <div>
                <dt>凭据提示</dt>
                <dd>{{ request.credential_hint || '-' }}</dd>
              </div>
              <div>
                <dt>请求人</dt>
                <dd>{{ request.requested_by || '-' }}</dd>
              </div>
              <div>
                <dt>过期时间</dt>
                <dd>{{ timeText(request.expires_at) }}</dd>
              </div>
            </dl>
            <p v-if="request.worker_message">{{ request.worker_message }}</p>
            <p v-if="request.error_message" class="service-login-error">{{ request.error_message }}</p>
          </article>
        </div>
      </section>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
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
const submitHint = computed(() => {
  if (form.login_mode === 'wa_qr') return '提交后等待工作台 WA worker 回写二维码。';
  return '提交后由工作台 TG worker 校验并接管登录。';
});

onMounted(loadRequests);

function handlePlatformChange() {
  form.login_mode = form.platform === 'wa' ? 'wa_qr' : 'tg_bot_token';
  form.credential = '';
}

async function loadRequests() {
  loading.value = true;
  try {
    requests.value = await fetchServiceAccountLoginRequests();
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

function platformText(platform) {
  if (platform === 'wa') return 'WA';
  if (platform === 'tg') return 'TG';
  return String(platform || '').toUpperCase();
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

function statusType(status) {
  if (status === 'authenticated') return 'success';
  if (status === 'failed' || status === 'expired') return 'danger';
  if (status === 'waiting_qr' || status === 'waiting_verification') return 'warning';
  return 'info';
}

function timeText(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}
</script>
