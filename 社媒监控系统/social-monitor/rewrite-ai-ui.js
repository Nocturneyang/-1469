const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Add AI Modal
const aiModalHtml = `
  <!-- Modal：编辑 AI 配置 -->
  <div class="modal-overlay" id="ai-modal">
    <div class="modal" style="width:480px;max-width:95vw">
      <div class="modal-close" onclick="closeAiModal()">&times;</div>
      <div class="modal-title" id="ai-modal-title">编辑 AI 配置</div>
      <input type="hidden" id="ai-modal-key" />
      <div class="form-group">
        <label id="ai-modal-label">配置值</label>
        <input type="text" id="ai-val-input" class="form-control" autocomplete="off" />
      </div>
      <div class="form-group" id="ai-model-presets" style="display:none; margin-top:-10px; margin-bottom:16px;">
        <span style="font-size:11px;color:var(--t3);font-weight:700;">快捷选择 →</span>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
          <button class="btn-sm" style="font-size:11px;padding:5px 10px" onclick="pickModelModal('openai/gpt-5.2')">gpt-5.2</button>
          <button class="btn-sm" style="font-size:11px;padding:5px 10px" onclick="pickModelModal('anthropic/claude-sonnet-4.6')">claude-sonnet-4.6</button>
          <button class="btn-sm" style="font-size:11px;padding:5px 10px" onclick="pickModelModal('google/gemini-3-flash-preview')">gemini-3-flash</button>
          <button class="btn-sm" style="font-size:11px;padding:5px 10px" onclick="pickModelModal('google/gemini-3.1-flash-lite-preview')">gemini-3.1-lite</button>
        </div>
      </div>
      <button class="btn-primary" onclick="submitAiConfig()">保存配置</button>
    </div>
  </div>
`;
html = html.replace('<!-- Modal：编辑 Webhook -->', aiModalHtml + '\n  <!-- Modal：编辑 Webhook -->');

// 2. Replace the AI panel body
const aiPanelRegex = /<!-- AI Key 配置 -->\s*<div class="panel">[\s\S]*?(?=<!-- 区域账号映射 -->)/;
const newAiPanelHtml = `<!-- AI Key 配置 -->
          <div class="panel" style="background:#ffffff; border:1px solid #edf2f7; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
            <div class="panel-title" style="margin-bottom:16px;">🤖 AI 分析引擎配置</div>
            <p style="font-size:13px;color:var(--t3);margin-bottom:24px;line-height:1.8">
              支持 <strong>OpenAI 兼容接口</strong>（one-api 中转／官方 OpenAI 均可），也可配置 <strong>Gemini</strong> 作为备用。<br>
              调用优先级：OpenAI 兼容接口 → Gemini → 纯关键词降级。
            </p>

            <div class="config-list">
              <!-- BASE URL -->
              <div class="config-list-item">
                <div class="cli-left">
                  <div class="cli-title">接口地址 (Base URL)</div>
                  <span class="badge" id="badge-OPENAI_BASE_URL">未配置</span>
                  <div class="cli-preview" id="preview-OPENAI_BASE_URL" style="display:none"></div>
                </div>
                <div class="cli-actions">
                  <button class="btn-text edit" onclick="openAiModal('OPENAI_BASE_URL', '接口地址 (Base URL)', 'https://api.openai.com/v1')">编辑</button>
                  <button class="btn-text danger" onclick="deleteEnvKey('OPENAI_BASE_URL')">清空</button>
                </div>
              </div>
              
              <!-- MODEL -->
              <div class="config-list-item">
                <div class="cli-left">
                  <div class="cli-title">调用模型 (Model)</div>
                  <span class="badge" id="badge-OPENAI_MODEL">未配置</span>
                  <div class="cli-preview" id="preview-OPENAI_MODEL" style="display:none"></div>
                </div>
                <div class="cli-actions">
                  <button class="btn-text edit" onclick="openAiModal('OPENAI_MODEL', '调用模型 (Model)', '如 openai/gpt-4')">编辑</button>
                  <button class="btn-text danger" onclick="deleteEnvKey('OPENAI_MODEL')">清空</button>
                </div>
              </div>

              <!-- OPENAI KEY -->
              <div class="config-list-item">
                <div class="cli-left">
                  <div class="cli-title">主密钥 (OpenAI Key)</div>
                  <span class="badge" id="badge-OPENAI_API_KEY">未配置</span>
                  <div class="cli-preview" id="preview-OPENAI_API_KEY" style="display:none"></div>
                </div>
                <div class="cli-actions">
                  <button class="btn-text edit" onclick="openAiModal('OPENAI_API_KEY', '主密钥 (OpenAI API Key)', 'sk-...', true)">编辑</button>
                  <button class="btn-text danger" onclick="deleteEnvKey('OPENAI_API_KEY')">清空</button>
                </div>
              </div>

              <!-- GEMINI KEY -->
              <div class="config-list-item">
                <div class="cli-left">
                  <div class="cli-title">备用密钥 (Gemini Key)</div>
                  <span class="badge" id="badge-GEMINI_API_KEY">未配置</span>
                  <div class="cli-preview" id="preview-GEMINI_API_KEY" style="display:none"></div>
                </div>
                <div class="cli-actions">
                  <button class="btn-text edit" onclick="openAiModal('GEMINI_API_KEY', '备用密钥 (Gemini API Key)', 'AIza...', true)">编辑</button>
                  <button class="btn-text danger" onclick="deleteEnvKey('GEMINI_API_KEY')">清空</button>
                </div>
              </div>
            </div>

            <!-- 连通性测试 -->
            <div style="margin-top:24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding-top:16px;border-top:1px dashed #edf2f7;">
              <button class="btn-primary" style="background:linear-gradient(135deg,#5a67d8,#6b46c1)"
                      id="btn-ai-test" onclick="testAIConnection()">⚡ 测试连通性</button>
              <div id="ai-test-result" style="font-size:13px;font-weight:700;color:var(--t3)"></div>
            </div>
          </div>

          `;
html = html.replace(aiPanelRegex, newAiPanelHtml);

// 3. Add Javascript for AI Modal
const jsUpdates = `
    // AI Modal Logic
    function openAiModal(key, titleName, placeholderText, isPassword = false) {
      document.getElementById('ai-modal-title').textContent = '编辑 ' + titleName;
      document.getElementById('ai-modal-label').textContent = titleName;
      document.getElementById('ai-modal-key').value = key;
      
      const input = document.getElementById('ai-val-input');
      input.type = isPassword ? 'password' : 'text';
      input.placeholder = placeholderText;
      
      // For API keys, don't show the real value directly in the input field to prevent shoulder-surfing, unless it's a non-password field.
      // Wait, actually showing it is fine since it's just an edit modal and they can clear it.
      // But envData[key] for API keys might be fully redacted. Let's show empty string if it's redacted, or show the masked value.
      input.value = envData[key] || '';
      
      document.getElementById('ai-model-presets').style.display = (key === 'OPENAI_MODEL') ? 'block' : 'none';
      
      document.getElementById('ai-modal').style.display = 'flex';
      input.focus();
    }
    function closeAiModal() {
      document.getElementById('ai-modal').style.display = 'none';
    }
    function pickModelModal(name) {
      document.getElementById('ai-val-input').value = name;
    }
    async function submitAiConfig() {
      const key = document.getElementById('ai-modal-key').value;
      const val = document.getElementById('ai-val-input').value.trim();
      
      try {
        const res = await fetch(API_BASE + '/config/env', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: val })
        });
        const data = await res.json();
        if (data.success) {
          showToast('保存成功');
          closeAiModal();
          fetchEnvStatus();
        } else {
          showToast(data.error, 'error');
        }
      } catch (e) { showToast('保存失败，网络错误', 'error'); }
    }
`;
html = html.replace('// 一键填入模型名称', jsUpdates + '\n    // 一键填入模型名称');

// 4. Update fetchEnvStatus to mask API keys safely
html = html.replace(
    /preview\.innerHTML = \(data\.data\[k\] \|\| '已隐藏'\) \+ secretIcon;/g,
    `let maskVal = data.data[k] || '已隐藏';
                 if (k.endsWith('_API_KEY') && maskVal !== '已隐藏') {
                     maskVal = maskVal.substring(0, 3) + '***' + maskVal.substring(maskVal.length - 4);
                 }
                 preview.innerHTML = maskVal + secretIcon;`
);

fs.writeFileSync('public/index.html', html, 'utf8');
