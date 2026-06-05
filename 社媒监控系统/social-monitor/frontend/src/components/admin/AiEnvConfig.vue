<template>
  <div class="panel">
    <div class="panel-title">
      <span class="title-text"><span class="panel-icon">🤖</span> AI 分析引擎配置</span>
    </div>
    <p style="font-size:13px;color:var(--t3);margin-bottom:24px;line-height:1.8">
      所有 AI 模型通过 <strong>one-api 中转接口</strong>统一调用，支持 OpenAI 兼容模型和 Gemini。<br>
      <strong>分层模型：</strong>FAST（高频轻量）→ DEFAULT（中等任务）→ PRO（高质量长文）。<br>
      降级策略：主接口失败时自动降级为纯关键词匹配模式。
    </p>

    <section v-for="group in configGroups" :key="group.title" class="config-section">
      <div class="section-title">{{ group.title }}</div>
      <div class="config-grid">
        <div v-for="item in group.items" :key="item.key" class="config-card">
          <div class="config-icon" :class="{ configured: isSet(item.key) }">
            {{ isSet(item.key) ? '✓' : '○' }}
          </div>
          <div class="config-content">
            <div class="config-label">{{ item.label }}</div>
            <div class="config-status" :class="{ configured: isSet(item.key) }">
              {{ isSet(item.key) ? '已配置' : '未配置' }}
            </div>
            <div v-if="editingKey !== item.key">
              <div v-if="isSet(item.key)" class="config-value">
                {{ item.sensitive ? envConfig[item.key] : envConfig[item.key] }}
              </div>
              <div v-else class="config-empty">{{ item.placeholder || '暂无配置' }}</div>
            </div>
            <div v-else class="edit-box">
              <input
                v-model="draftValues[item.key]"
                class="config-input"
                :type="item.inputType || (item.sensitive ? 'password' : 'text')"
                :placeholder="item.sensitive && isSet(item.key) ? '留空表示不修改当前密钥' : item.placeholder"
                :list="item.options ? `options-${item.key}` : undefined"
                @keyup.enter="saveItem(item)"
              />
              <datalist v-if="item.options" :id="`options-${item.key}`">
                <option v-for="option in item.options" :key="option" :value="option" />
              </datalist>
              <div v-if="item.sensitive && isSet(item.key)" class="edit-hint">密钥已脱敏展示，输入新值才会覆盖。</div>
            </div>
            <div class="config-actions">
              <button
                v-if="editingKey !== item.key"
                class="mini-btn"
                :disabled="readonly || loading"
                @click="startEdit(item)"
              >
                编辑
              </button>
              <button
                v-else
                class="mini-btn primary"
                :disabled="readonly || loading"
                @click="saveItem(item)"
              >
                保存
              </button>
              <button
                v-if="editingKey === item.key"
                class="mini-btn"
                :disabled="loading"
                @click="cancelEdit"
              >
                取消
              </button>
              <button
                class="mini-btn danger"
                :disabled="readonly || loading || !isSet(item.key)"
                @click="$emit('delete-env', item.key)"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <div style="margin-top:24px;padding-top:16px;border-top:1px dashed var(--border);display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <button class="btn-primary" style="background:linear-gradient(135deg,#5a67d8,#6b46c1)" :disabled="readonly || loading" @click="$emit('test-ai')">
        🧪 测试 AI 接口
      </button>
      <span style="font-size:12px;color:var(--t3)">保存或删除会同步写入后端 .env，运行中进程需重启后完整生效。</span>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'

const props = defineProps({
  envConfig: { type: Object, required: true },
  loading: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false }
})

const emit = defineEmits(['save-env', 'delete-env', 'test-ai'])

const modelOptions = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5',
  'gemini-2.5-pro'
]

const configGroups = [
  {
    title: '基础连接',
    items: [
      { key: 'OPENAI_BASE_URL', label: '接口地址 (Base URL)', sensitive: false, placeholder: 'https://oneapi.itniotech.cn/v1' },
      { key: 'OPENAI_MODEL', label: '默认模型 (DEFAULT)', sensitive: false, placeholder: 'deepseek-v4-pro', options: modelOptions },
      { key: 'OPENAI_MODEL_FAST', label: '快速模型 (FAST)', sensitive: false, placeholder: 'deepseek-v4-flash', options: modelOptions },
      { key: 'OPENAI_MODEL_PRO', label: '专业模型 (PRO)', sensitive: false, placeholder: 'claude-sonnet-4.5', options: modelOptions },
      { key: 'OPENAI_API_KEY', label: '主密钥 (OpenAI Key)', sensitive: true, placeholder: '请输入 OpenAI 兼容接口密钥' },
      { key: 'GEMINI_API_KEY', label: '备用密钥 (Gemini Key)', sensitive: true, placeholder: '请输入 Gemini API Key' },
    ]
  },
  {
    title: '场景模型',
    items: [
      { key: 'ALERT_AI_MODEL', label: '告警分析', sensitive: false, placeholder: 'deepseek-v4-flash', options: modelOptions },
      { key: 'EXTRACTION_AI_MODEL', label: '抽取审核', sensitive: false, placeholder: 'deepseek-v4-flash', options: modelOptions },
      { key: 'KNOWLEDGE_AI_MODEL', label: '知识库提取', sensitive: false, placeholder: 'deepseek-v4-pro', options: modelOptions },
      { key: 'DAILY_DIGEST_AI_MODEL', label: '每日日报', sensitive: false, placeholder: 'deepseek-v4-pro', options: modelOptions },
      { key: 'WEEKLY_RELIABILITY_AI_MODEL', label: '每周可靠性', sensitive: false, placeholder: 'claude-sonnet-4.5', options: modelOptions },
      { key: 'SUPPLIER_PROFILE_AI_MODEL', label: '供应商画像', sensitive: false, placeholder: 'deepseek-v4-pro', options: modelOptions },
    ]
  },
  {
    title: '供应商画像参数',
    items: [
      { key: 'SUPPLIER_PROFILE_AI_CONCURRENCY', label: '画像并发数', sensitive: false, placeholder: '1', inputType: 'number' },
      { key: 'SUPPLIER_PROFILE_AI_MAX_TOKENS', label: '画像输出 Token', sensitive: false, placeholder: '1200', inputType: 'number' },
      { key: 'SUPPLIER_PROFILE_AI_TIMEOUT_MS', label: '画像超时毫秒', sensitive: false, placeholder: '60000', inputType: 'number' },
    ]
  },
]

const editingKey = ref('')
const draftValues = reactive({})

const isSet = (key) => {
  const v = props.envConfig?.[key]
  return !!(v && !String(v).includes('YOUR_') && !String(v).includes('your_') && v !== '未配置' && v !== '')
}

const startEdit = (item) => {
  editingKey.value = item.key
  draftValues[item.key] = item.sensitive ? '' : (props.envConfig?.[item.key] || '')
}

const cancelEdit = () => {
  editingKey.value = ''
}

const saveItem = (item) => {
  const value = String(draftValues[item.key] || '').trim()
  if (item.sensitive && !value && isSet(item.key)) {
    editingKey.value = ''
    return
  }
  emit('save-env', { key: item.key, value })
  editingKey.value = ''
}
</script>

<style scoped>
.config-section + .config-section {
  margin-top: 24px;
}

.section-title {
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 800;
  color: var(--t);
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.config-card {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 20px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--rs);
  transition: all 0.2s ease;
  box-shadow: var(--out-shadow);
}

.config-card:hover {
  border-color: #cbd5e0;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
  transform: translateY(-2px);
}

.config-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--bg-tint);
  color: #a0aec0;
  font-size: 20px;
  font-weight: 700;
  flex-shrink: 0;
}

.config-icon.configured {
  background: rgba(56, 161, 105, 0.1);
  color: #276749;
}

.config-content {
  flex: 1;
  min-width: 0;
}

.config-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--t);
  margin-bottom: 6px;
}

.config-status {
  font-size: 12px;
  font-weight: 600;
  color: #a0aec0;
  margin-bottom: 8px;
}

.config-status.configured {
  color: #276749;
}

.config-value {
  font-size: 12px;
  color: var(--t3);
  font-family: monospace;
  word-break: break-all;
  background: var(--bg-tint);
  padding: 6px 10px;
  border-radius: 6px;
}

.config-empty {
  font-size: 12px;
  color: #a0aec0;
  background: var(--bg-tint);
  padding: 6px 10px;
  border-radius: 6px;
}

.edit-box {
  display: grid;
  gap: 6px;
}

.config-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--t);
  background: #fff;
}

.edit-hint {
  font-size: 12px;
  color: var(--t3);
}

.config-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.mini-btn {
  border: 1px solid var(--border);
  background: #fff;
  color: var(--t2);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.mini-btn.primary {
  border-color: #5a67d8;
  color: #5a67d8;
}

.mini-btn.danger {
  border-color: rgba(229, 62, 62, 0.35);
  color: #c53030;
}

.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
