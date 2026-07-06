<template>
  <div class="portal-entry">
    <section class="entry-panel">
      <div class="entry-head">
        <p>Access Portal</p>
        <h1>选择工作入口</h1>
        <span>{{ authStore.username }}，请选择本次要进入的系统。</span>
      </div>

      <div v-if="loading" class="entry-loading">正在读取入口权限...</div>
      <div v-else class="entry-options">
        <button
          v-if="portalAccess.can_monitor"
          type="button"
          class="entry-card monitor"
          @click="goMonitor"
        >
          <span>监</span>
          <strong>监控系统</strong>
          <em>采集、分析、告警、知识资产和账号管理</em>
        </button>

        <button
          v-if="portalAccess.can_workbench"
          type="button"
          class="entry-card workbench"
          @click="goWorkbench"
        >
          <span>客</span>
          <strong>客服工作台</strong>
          <em>服务账号、分组会话、消息回复和坐席协作</em>
        </button>

        <button
          v-if="portalAccess.can_admin"
          type="button"
          class="entry-card admin"
          @click="goAdmin"
        >
          <span>管</span>
          <strong>管理后台</strong>
          <em>用户、角色、权限、数据范围和系统配置</em>
        </button>

        <div v-if="!portalAccess.can_monitor && !portalAccess.can_workbench && !portalAccess.can_admin" class="entry-denied">
          当前账号还没有配置可访问入口，请联系 1469 超级管理员配置权限。
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/store/auth'

const router = useRouter()
const authStore = useAuthStore()
const loading = ref(true)
const portalAccess = computed(() => authStore.portalAccess)

onMounted(async () => {
  await authStore.hydrateWorkbenchAccess().catch(() => {})
  loading.value = false
})

function goMonitor() {
  authStore.setPortalChoice('monitor')
  router.replace('/')
}

function goWorkbench() {
  authStore.setPortalChoice('workbench')
  window.location.assign('/workbench/')
}

function goAdmin() {
  authStore.setPortalChoice('admin')
  router.replace('/admin/users')
}
</script>

<style scoped>
.portal-entry {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background:
    linear-gradient(180deg, rgba(15, 118, 110, 0.08), rgba(255, 255, 255, 0)),
    #f8fafc;
}

.entry-panel {
  width: min(860px, 100%);
  border: 1px solid #dbe7e3;
  border-radius: 8px;
  background: #fff;
  padding: 28px;
  box-shadow: 0 18px 60px rgba(15, 23, 42, 0.12);
}

.entry-head {
  margin-bottom: 24px;
}

.entry-head p {
  margin: 0 0 6px;
  color: #0f766e;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.entry-head h1 {
  margin: 0 0 8px;
  color: #0f172a;
  font-size: 28px;
}

.entry-head span,
.entry-card em,
.entry-loading {
  color: #64748b;
  font-style: normal;
}

.entry-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.entry-card {
  min-height: 172px;
  border: 1px solid #dbe7e3;
  border-radius: 8px;
  background: #fff;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 20px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
}

.entry-card:hover {
  border-color: #10b981;
  box-shadow: 0 16px 40px rgba(15, 118, 110, 0.15);
  transform: translateY(-1px);
}

.entry-card span {
  width: 42px;
  height: 42px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 900;
}

.entry-card.monitor span {
  background: #2563eb;
}

.entry-card.workbench span {
  background: #0f766e;
}

.entry-card.admin span {
  background: #7c3aed;
}

.entry-card strong {
  color: #0f172a;
  font-size: 20px;
}

.entry-card em {
  line-height: 1.6;
}

.entry-denied {
  grid-column: 1 / -1;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  background: #fff7ed;
  color: #9a3412;
  padding: 16px;
}
</style>
