<template>
  <div class="panel" style="margin-bottom:20px">
    <div class="panel-title">
      <span class="title-text"><span class="panel-icon">🏷️</span> 价值标签管控 (Value Labels)</span>
      <button class="btn-primary" @click="showOverrideDialog">+ 新增群组覆盖 (Group Override)</button>
    </div>

    <div class="tab-buttons">
      <button :class="{ active: activeTab === 'base' }" @click="activeTab = 'base'">基础群组标签 (Base Labels)</button>
      <button :class="{ active: activeTab === 'overrides' }" @click="activeTab = 'overrides'">群级人工覆盖 (Label Overrides)</button>
    </div>

    <div v-if="activeTab === 'base'" class="table-container" style="max-height:400px">
      <table style="width:100%">
        <thead>
          <tr>
            <th style="width:150px">Account ID</th>
            <th style="width:100px">平台</th>
            <th style="width:100px">板块</th>
            <th style="width:100px">区域</th>
            <th style="width:100px">价值标签</th>
            <th style="width:120px">负责人</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in valueLabels" :key="row.account_id">
            <td style="padding:12px 16px">{{ row.account_id }}</td>
            <td style="padding:12px 16px">{{ row.platform }}</td>
            <td style="padding:12px 16px">{{ row.sector }}</td>
            <td style="padding:12px 16px">{{ row.region }}</td>
            <td style="padding:12px 16px">
              <span :class="'tag ' + getLabelClass(row.label)">{{ row.label || '未定' }}</span>
            </td>
            <td style="padding:12px 16px">{{ row.owner }}</td>
            <td style="padding:12px 16px">{{ row.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="activeTab === 'overrides'" class="table-container" style="max-height:400px">
      <table style="width:100%">
        <thead>
          <tr>
            <th style="min-width:200px">群组名称</th>
            <th style="width:120px">覆盖标签</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in labelOverrides" :key="row.group_name">
            <td style="padding:12px 16px">{{ row.group_name }}</td>
            <td style="padding:12px 16px">
              <span :class="'tag ' + getLabelClass(row.label)">{{ row.label }}</span>
            </td>
            <td style="padding:12px 16px">{{ row.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Override Dialog -->
  <div v-if="overrideDialogVisible" class="modal-backdrop" @click.self="overrideDialogVisible = false">
    <div class="modal">
      <h3>新增群组覆盖标签</h3>
      <div class="field-group">
        <label class="field-label">群组名称 <span style="color:var(--color-danger);font-size:12px">* 必填</span></label>
        <select class="field-input" v-model="overrideForm.group_name">
          <option value="">-- 选择或手动输入 --</option>
          <option v-for="gn in groupOptions" :key="gn.group_name" :value="gn.group_name">{{ gn.group_name }}</option>
        </select>
      </div>
      <div class="field-group">
        <label class="field-label">覆盖标签 <span style="color:var(--color-danger);font-size:12px">* 必填</span></label>
        <select class="field-input" v-model="overrideForm.label">
          <option value="">-- 选择标签层级 --</option>
          <option value="L0">L0 (红·最高)</option>
          <option value="L1">L1 (黄·重要)</option>
          <option value="L2">L2 (蓝·普通)</option>
          <option value="L3">L3 (灰·外部)</option>
        </select>
      </div>
      <div class="field-group">
        <label class="field-label">覆盖原因</label>
        <textarea class="field-input" v-model="overrideForm.reason" placeholder="请简要说明调整原因..." rows="3"></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" @click="overrideDialogVisible = false">取消</button>
        <button class="btn-primary" @click="submitOverride" :disabled="savingOverride">
          {{ savingOverride ? '保存中...' : '确认覆盖' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import api from '@/utils/request'

const props = defineProps({
  valueLabels: { type: Array, default: () => [] },
  labelOverrides: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false }
})

const emit = defineEmits(['refresh'])

const activeTab = ref('base')
const groupOptions = ref([])
const overrideDialogVisible = ref(false)
const savingOverride = ref(false)
const overrideForm = ref({
  group_name: '',
  label: '',
  reason: ''
})

const getLabelClass = (label) => {
  if (label === 'L0') return 'p0'
  if (label === 'L1') return 'p1'
  if (label === 'L2') return 'slate'
  if (label === 'L3') return 'slate'
  return 'slate'
}

const showOverrideDialog = async () => {
  overrideForm.value = { group_name: '', label: '', reason: '' }
  overrideDialogVisible.value = true
  
  try {
    const res = await api.get('/api/groups')
    if (res.success && res.data) {
      groupOptions.value = res.data
    }
  } catch (e) {
    console.error('Failed to fetch groups', e)
  }
}

const submitOverride = async () => {
  if (!overrideForm.value.group_name || !overrideForm.value.label) {
    ElMessage.warning('请选择群组和标签层级')
    return
  }

  savingOverride.value = true
  try {
    const res = await api.post('/api/config/value-labels/override', overrideForm.value)
    if (res.success) {
      ElMessage.success('覆盖标签保存成功')
      overrideDialogVisible.value = false
      emit('refresh')
      activeTab.value = 'overrides'
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (e) {
    ElMessage.error('保存覆盖标签请求失败')
  } finally {
    savingOverride.value = false
  }
}
</script>

<style scoped>
.tab-buttons {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  border-bottom: 2px solid var(--border);
  padding-bottom: 8px;
}

.tab-buttons button {
  padding: 8px 16px;
  border: none;
  background: none;
  color: var(--t3);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.tab-buttons button:hover {
  background: var(--bg-tint);
}

.tab-buttons button.active {
  background: var(--p);
  color: white;
}

.table-container {
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--rs);
}

table {
  border-collapse: collapse;
}

thead {
  position: sticky;
  top: 0;
  background: var(--bg-tint);
  z-index: 1;
}

th {
  padding: 12px 16px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  color: var(--t);
  border-bottom: 1px solid var(--border);
}

tbody tr {
  border-bottom: 1px solid #f7fafc;
}

tbody tr:hover {
  background: var(--bg-tint);
}

tbody tr:last-child {
  border-bottom: none;
}
</style>
