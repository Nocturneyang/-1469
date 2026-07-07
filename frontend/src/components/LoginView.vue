<template>
  <main class="login-screen">
    <section class="login-panel">
      <div class="login-brand">
        <div class="brand-mark large">客</div>
        <div>
          <h1>客服工作台</h1>
          <p>使用工作台账号登录</p>
        </div>
      </div>

      <el-form class="login-form" label-position="top" @submit.prevent="submit">
        <el-form-item label="账号">
          <el-input
            v-model.trim="form.username"
            autocomplete="username"
            placeholder="请输入工作台账号"
            size="large"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            autocomplete="current-password"
            placeholder="请输入密码"
            show-password
            size="large"
            type="password"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
        <el-button class="login-submit" type="primary" size="large" :loading="loading" @click="submit">
          登录工作台
        </el-button>
        <el-button class="login-sso" text bg size="large" @click="ssoLogin">
          使用统一登录
        </el-button>
      </el-form>
    </section>
  </main>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { loginLocal, startSsoLogin } from '../api';

const emit = defineEmits(['logged-in']);

const form = reactive({
  username: '',
  password: '',
});
const loading = ref(false);
const error = ref('');

async function submit() {
  if (!form.username || !form.password) {
    error.value = '请输入账号和密码';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const result = await loginLocal(form.username, form.password);
    if (!result || !result.success) {
      error.value = result?.error || '登录失败';
      return;
    }
    emit('logged-in', result.user);
  } catch (err) {
    error.value = err.response?.data?.error || '账号或密码不正确';
  } finally {
    loading.value = false;
  }
}

async function ssoLogin() {
  await startSsoLogin();
}
</script>
