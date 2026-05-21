<template>
  <div class="panel">
    <div class="panel-title">
      <span class="title-text"><span class="panel-icon">🤖</span> AI 分析引擎配置</span>
    </div>
    <p style="font-size:13px;color:var(--t3);margin-bottom:24px;line-height:1.8">
      支持 <strong>OpenAI 兼容接口</strong>（one-api 中转／官方 OpenAI 均可），也可配置 <strong>Gemini</strong> 作为备用。<br>
      调用优先级：OpenAI 兼容接口 → Gemini → 纯关键词降级。
    </p>

    <div class="config-grid">
      <div v-for="item in configItems" :key="item.key" class="config-card">
        <div class="config-icon" :class="{ configured: isSet(item.key) }">
          {{ isSet(item.key) ? '✓' : '○' }}
        </div>
        <div class="config-content">
          <div class="config-label">{{ item.label }}</div>
          <div class="config-status" :class="{ configured: isSet(item.key) }">
            {{ isSet(item.key) ? '已配置' : '未配置' }}
          </div>
          <div v-if="isSet(item.key) && !item.sensitive" class="config-value">
            {{ envConfig[item.key] }}
          </div>
        </div>
      </div>
    </div>

    <div style="margin-top:24px;padding-top:16px;border-top:1px dashed var(--border);display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <button class="btn-primary" style="background:linear-gradient(135deg,#5a67d8,#6b46c1)" @click="$emit('save')">
        💾 保存环境变量至 .env
      </button>
      <span style="font-size:12px;color:var(--t3)">保存后系统将自动重启生效。</span>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  envConfig: { type: Object, required: true },
  loading: { type: Boolean, default: false }
})

defineEmits(['save'])

const configItems = [
  { key: 'OPENAI_BASE_URL', label: '接口地址 (Base URL)', sensitive: false },
  { key: 'OPENAI_MODEL', label: '调用模型 (Model)', sensitive: false },
  { key: 'OPENAI_API_KEY', label: '主密钥 (OpenAI Key)', sensitive: true },
  { key: 'GEMINI_API_KEY', label: '备用密钥 (Gemini Key)', sensitive: true },
]

const isSet = (key) => {
  const v = props.envConfig?.[key]
  return !!(v && !String(v).includes('YOUR_') && !String(v).includes('your_') && v !== '未配置' && v !== '')
}
</script>

<style scoped>
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
</style>
