<template>
  <div class="view-enter">
    <div class="panel">
      <div class="panel-title">
        <span class="title-text"><span class="panel-icon">📈</span> 系统数据分析</span>
        <button class="btn-primary" @click="fetchAnalytics" :disabled="loading">
          🔄 刷新数据
        </button>
      </div>

      <!-- Alert / Issue Analytics -->
      <div v-if="loading" class="empty-state loading-pulse">加载中...</div>
      <div v-else>
        <div style="margin-bottom: 24px">
          <h3 style="font-size: 16px; font-weight: 700; color: var(--t); margin-bottom: 16px">故障警告指标 (P0/P1)</h3>
          <div v-if="!analyticsSummary.alerts || analyticsSummary.alerts.length === 0" class="empty-state">当前未侦测到警告信息</div>
          <div v-else style="overflow-x: auto">
            <table style="width: 100%; border-collapse: separate; border-spacing: 0 10px">
              <thead>
                <tr style="font-size: 12px; font-weight: 800; color: var(--t3); text-transform: uppercase; letter-spacing: 1px">
                  <th style="padding: 0 16px 4px; text-align: left">等级</th>
                  <th style="padding: 0 16px 4px; text-align: left">警告数量</th>
                  <th style="padding: 0 16px 4px; text-align: left">平台</th>
                  <th style="padding: 0 16px 4px; text-align: center">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="alert in analyticsSummary.alerts" :key="alert.level" style="background: #fff">
                  <td style="padding: 14px 16px">
                    <span :class="'tag ' + (alert.level === 'P0' ? 'p0' : 'p1')">{{ alert.level }}</span>
                  </td>
                  <td style="padding: 14px 16px">{{ alert.count }}</td>
                  <td style="padding: 14px 16px">{{ alert.platforms }}</td>
                  <td style="padding: 14px 16px; text-align: center">
                    <button class="el-btn">查看详情</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Supplier Scores Analysis -->
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px">
          <div class="panel" style="margin-bottom: 0">
            <div class="panel-title">
              <span class="title-text"><span class="panel-icon">📊</span> 近期工单统计 (Issue Lifecycle)</span>
            </div>
            <div style="text-align: center; padding: 32px">
              <div style="font-size: 48px; font-weight: 800; color: var(--p); margin-bottom: 8px">{{ analyticsSummary.issueResolveRate || 0 }}%</div>
              <div style="font-size: 13px; color: var(--t3); font-weight: 600">闭环完成率</div>
            </div>
          </div>

          <div class="panel" style="margin-bottom: 0">
            <div class="panel-title">
              <span class="title-text"><span class="panel-icon">📋</span> 每日摘要与周报</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 16px; padding: 16px 0">
              <div style="display: flex; justify-content: space-between; padding: 12px 16px; background: var(--bg-tint); border-radius: 8px">
                <span style="font-size: 13px; color: var(--t3)">已生成日报册数</span>
                <span style="font-size: 16px; font-weight: 700; color: var(--t)">{{ analyticsSummary.digestCount || 0 }}</span>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 12px 16px; background: var(--bg-tint); border-radius: 8px">
                <span style="font-size: 13px; color: var(--t3)">监控群组覆盖面</span>
                <span style="font-size: 16px; font-weight: 700; color: var(--t)">{{ analyticsSummary.groupsCovered || 0 }}</span>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 12px 16px; background: var(--bg-tint); border-radius: 8px">
                <span style="font-size: 13px; color: var(--t3)">上周质检供应商</span>
                <span style="font-size: 16px; font-weight: 700; color: var(--t)">{{ analyticsSummary.assessedSuppliers || 0 }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import api from '@/utils/request'

const loading = ref(true)
const analyticsSummary = ref({
  alerts: [],
  issueResolveRate: 0,
  digestCount: 0,
  groupsCovered: 0,
  assessedSuppliers: 0
})

const fetchAnalytics = async () => {
  loading.value = true
  try {
    const res = await api.get('/api/analytics/summary')
    if (res.success && res.data) {
      analyticsSummary.value = res.data
    }
  } catch (error) {
    console.error('Failed to load analytics', error)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchAnalytics()
})
</script>

<style scoped>
/* Styles now use global style.css */
</style>
