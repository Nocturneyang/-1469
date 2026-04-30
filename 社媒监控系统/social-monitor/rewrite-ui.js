const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Add the Modal for Editing Webhook at the top (near other modals)
const webhookModalHtml = `
  <!-- Modal：编辑 Webhook -->
  <div class="modal-overlay" id="webhook-modal">
    <div class="modal" style="width:480px;max-width:95vw">
      <div class="modal-close" onclick="closeWebhookModal()">&times;</div>
      <div class="modal-title" id="webhook-modal-title">编辑 Webhook</div>
      <input type="hidden" id="webhook-modal-key" />
      <div class="form-group">
        <label>Webhook URL</label>
        <input type="text" id="webhook-url-input" class="form-control" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." autocomplete="off" />
      </div>
      <div class="form-group">
        <label>加签秘钥 (Secret) <span style="color:var(--t3);font-size:12px;font-weight:normal">（可选）</span></label>
        <input type="text" id="webhook-secret-input" class="form-control" placeholder="SEC... (留空则不加签)" autocomplete="off" />
      </div>
      <button class="btn-primary" onclick="submitWebhook()">保存配置</button>
    </div>
  </div>
`;
html = html.replace('<!-- Modal：新增采集账号 -->', webhookModalHtml + '\n  <!-- Modal：新增采集账号 -->');

// 2. Add some specific styles for the new list design
const newStyles = `
    /* ── 新版配置列表样式 ── */
    .config-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .config-list-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      background: #ffffff;
      border: 1px solid rgba(0,0,0,0.06);
      border-radius: 12px;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.02);
    }
    .config-list-item:hover {
      box-shadow: 0 4px 12px rgba(0,0,0,0.05);
      border-color: rgba(107,70,193,0.2);
    }
    .cli-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .cli-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--t);
      min-width: 140px;
    }
    .cli-preview {
      font-size: 13px;
      color: var(--t3);
      font-family: monospace;
      background: #f8fafc;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid #edf2f7;
    }
    .cli-actions {
      display: flex;
      gap: 8px;
    }
    .btn-text {
      background: transparent;
      border: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 6px 12px;
      border-radius: 6px;
      transition: all 0.2s;
    }
    .btn-text.edit {
      color: var(--p);
    }
    .btn-text.edit:hover {
      background: rgba(107,70,193,0.1);
    }
    .btn-text.danger {
      color: var(--red);
    }
    .btn-text.danger:hover {
      background: rgba(252,129,129,0.1);
    }
`;
html = html.replace('/* ── 配置中心样式 ── */', newStyles + '\n    /* ── 配置中心样式 ── */');

// Modify Neumorphism variables to be flatter globally to "de-grease" the UI
html = html.replace('--out-shadow: 9px 9px 16px var(--shadow-dark), -9px -9px 16px var(--shadow-light);', '--out-shadow: 0 4px 16px rgba(0,0,0,0.06);');
html = html.replace('--out-shadow-hover: 12px 12px 20px var(--shadow-dark), -12px -12px 20px var(--shadow-light);', '--out-shadow-hover: 0 8px 24px rgba(0,0,0,0.1);');
html = html.replace('--in-shadow: inset 6px 6px 12px var(--shadow-dark), inset -6px -6px 12px var(--shadow-light);', '--in-shadow: inset 0 2px 4px rgba(0,0,0,0.04);');
html = html.replace('--in-shadow-active: inset 4px 4px 8px var(--shadow-dark), inset -4px -4px 8px var(--shadow-light);', '--in-shadow-active: inset 0 2px 6px rgba(0,0,0,0.08);');
html = html.replace('--bg: #e0e5ec;', '--bg: #f4f7f9;');
html = html.replace('--bg-gradient: linear-gradient(145deg, #f0f5fd, #caccd4);', '--bg-gradient: #ffffff;');

// 3. Replace the entire "钉钉推送配置" panel
const oldPanelRegex = /<div class="panel">\s*<div class="panel-title">🔔 钉钉机器人 Webhook<\/div>[\s\S]*?(?=<!-- AI Key 配置 -->)/;

const newPanelHtml = `
          <!-- 钉钉推送配置 -->
          <div class="panel" style="background:#ffffff; border:1px solid #edf2f7; box-shadow:0 4px 16px rgba(0,0,0,0.04);">
            <div class="panel-title" style="margin-bottom:16px;">🔔 钉钉机器人 Webhook</div>
            <p style="font-size:13px;color:var(--t3);margin-bottom:24px;">使用收纳式列表管理 Webhook，点击“编辑”配置对应频道的机器人和加签秘钥。留空专线则自动回退至全局缺省配置。</p>

            <div class="config-section">
              <div class="config-section-title">🚨 告警群机器人 <span style="font-size:11px;color:var(--t3);font-weight:600;text-transform:none;letter-spacing:0;margin-left:8px">(维度1+2：P0/P1实时告警 + 问题超时升级)</span></div>
              <div class="config-list">
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">全局缺省 (Global)</div>
                    <span class="badge" id="badge-DINGTALK_ALERT">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_ALERT" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_ALERT', '告警群机器人 (全局缺省)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_ALERT')">清空</button>
                  </div>
                </div>
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">WhatsApp 专线</div>
                    <span class="badge" id="badge-DINGTALK_ALERT_WA">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_ALERT_WA" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_ALERT_WA', '告警群机器人 (WhatsApp专线)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_ALERT_WA')">清空</button>
                  </div>
                </div>
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">Telegram 专线</div>
                    <span class="badge" id="badge-DINGTALK_ALERT_TG">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_ALERT_TG" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_ALERT_TG', '告警群机器人 (Telegram专线)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_ALERT_TG')">清空</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="config-section">
              <div class="config-section-title">📋 日报群机器人 <span style="font-size:11px;color:var(--t3);font-weight:600;text-transform:none;letter-spacing:0;margin-left:8px">(维度3：每天09:00推送群汇总)</span></div>
              <div class="config-list">
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">全局缺省 (Global)</div>
                    <span class="badge" id="badge-DINGTALK_DIGEST">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_DIGEST" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_DIGEST', '日报群机器人 (全局缺省)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_DIGEST')">清空</button>
                  </div>
                </div>
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">WhatsApp 专线</div>
                    <span class="badge" id="badge-DINGTALK_DIGEST_WA">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_DIGEST_WA" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_DIGEST_WA', '日报群机器人 (WhatsApp专线)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_DIGEST_WA')">清空</button>
                  </div>
                </div>
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">Telegram 专线</div>
                    <span class="badge" id="badge-DINGTALK_DIGEST_TG">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_DIGEST_TG" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_DIGEST_TG', '日报群机器人 (Telegram专线)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_DIGEST_TG')">清空</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="config-section" style="margin-bottom:0">
              <div class="config-section-title">📊 周报群机器人 <span style="font-size:11px;color:var(--t3);font-weight:600;text-transform:none;letter-spacing:0;margin-left:8px">(维度4：每周一09:00供应商评分报告)</span></div>
              <div class="config-list">
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">全局缺省 (Global)</div>
                    <span class="badge" id="badge-DINGTALK_WEEKLY">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_WEEKLY" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_WEEKLY', '周报群机器人 (全局缺省)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_WEEKLY')">清空</button>
                  </div>
                </div>
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">WhatsApp 专线</div>
                    <span class="badge" id="badge-DINGTALK_WEEKLY_WA">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_WEEKLY_WA" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_WEEKLY_WA', '周报群机器人 (WhatsApp专线)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_WEEKLY_WA')">清空</button>
                  </div>
                </div>
                <div class="config-list-item">
                  <div class="cli-left">
                    <div class="cli-title">Telegram 专线</div>
                    <span class="badge" id="badge-DINGTALK_WEEKLY_TG">未配置</span>
                    <div class="cli-preview" id="preview-DINGTALK_WEEKLY_TG" style="display:none"></div>
                  </div>
                  <div class="cli-actions">
                    <button class="btn-text edit" onclick="openWebhookModal('DINGTALK_WEEKLY_TG', '周报群机器人 (Telegram专线)')">编辑</button>
                    <button class="btn-text danger" onclick="deleteEnvKey('DINGTALK_WEEKLY_TG')">清空</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          `;

html = html.replace(oldPanelRegex, newPanelHtml);

// 4. Update the Javascript logic
// We need to hold the raw values from fetchEnvStatus to populate the modal
// We also update fetchEnvStatus to set previews instead of input hints
const jsUpdates = `
    let envData = {}; // Global store for env values
    
    // Updated Webhook Modal Logic
    function openWebhookModal(key, titleName) {
      document.getElementById('webhook-modal-title').textContent = '编辑 ' + titleName;
      document.getElementById('webhook-modal-key').value = key;
      document.getElementById('webhook-url-input').value = envData[key] || '';
      document.getElementById('webhook-secret-input').value = envData[key + '_SECRET'] || '';
      document.getElementById('webhook-modal').style.display = 'flex';
    }
    function closeWebhookModal() {
      document.getElementById('webhook-modal').style.display = 'none';
    }
    async function submitWebhook() {
      const key = document.getElementById('webhook-modal-key').value;
      const url = document.getElementById('webhook-url-input').value.trim();
      const secret = document.getElementById('webhook-secret-input').value.trim();
      
      const payload = {};
      payload[key] = url; // Empty url clears it
      payload[key + '_SECRET'] = secret; // Empty secret clears it
      
      try {
        const res = await fetch(API_BASE + '/config/env', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
          showToast('Webhook 保存成功');
          closeWebhookModal();
          fetchEnvStatus();
        } else {
          showToast(data.error, 'error');
        }
      } catch (e) { showToast('保存失败，网络错误', 'error'); }
    }
    
    // Override fetchEnvStatus to work with new preview elements
    async function fetchEnvStatus() {
      try {
        const res = await fetch(API_BASE + '/config/env');
        const data = await res.json();
        if (!data.success) return;
        envData = data.data; // Store globally
        
        const KEYS = [
          'DINGTALK_ALERT','DINGTALK_ALERT_WA','DINGTALK_ALERT_TG',
          'DINGTALK_DIGEST','DINGTALK_DIGEST_WA','DINGTALK_DIGEST_TG',
          'DINGTALK_WEEKLY','DINGTALK_WEEKLY_WA','DINGTALK_WEEKLY_TG',
          'GEMINI_API_KEY','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL'
        ];
        
        for (const k of KEYS) {
          const badge = document.getElementById('badge-' + k);
          const isSet = data.data[k + '_set'];
          if (badge) {
            badge.textContent = isSet ? '🟢 已配置' : '⚪ 未配置';
            badge.className = 'badge ' + (isSet ? 'badge-set' : 'badge-unset');
          }
          
          // For AI config inputs (still using inputs)
          const input = document.getElementById('input-' + k);
          if (input) {
             input.placeholder = isSet ? '(已配置，输入新值可覆盖)' : (input.getAttribute('data-placeholder') || input.placeholder);
          }
          const hint = document.getElementById('hint-' + k);
          if (hint) {
            if (isSet) {
              const val = data.data[k] || '';
              hint.textContent = '当前：' + val;
              hint.style.display = 'block';
            } else {
              hint.style.display = 'none';
            }
          }
          
          // For Webhook list preview
          const preview = document.getElementById('preview-' + k);
          if (preview) {
             if (isSet) {
                 const hasSecret = data.data[k + '_SECRET_set'];
                 const secretIcon = hasSecret ? ' <span title="已配置加签秘钥">🔐</span>' : '';
                 preview.innerHTML = (data.data[k] || '已隐藏') + secretIcon;
                 preview.style.display = 'block';
             } else {
                 preview.style.display = 'none';
             }
          }
        }
      } catch (e) { console.error('fetchEnvStatus', e); }
    }
    
    // Clean up old deleteEnvKey to work with both webhook list and ai configs
    async function deleteEnvKey(key) {
      if (!confirm('确定要清空此项的所有配置吗？')) return;
      try {
        const payload = {};
        payload[key] = '';
        // If it's a dingtalk key, also clear the secret
        if (key.startsWith('DINGTALK_')) {
             payload[key + '_SECRET'] = '';
        }
        
        const res = await fetch(API_BASE + '/config/env', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
          showToast('已成功清空');
          // Clear any associated inputs just in case (for AI config)
          const input = document.getElementById('input-' + key);
          if (input) input.value = '';
          fetchEnvStatus();
        } else {
          showToast(data.error, 'error');
        }
      } catch (e) { showToast('清空失败', 'error'); }
    }
`;

// Replace the old fetchEnvStatus and deleteEnvKey completely
html = html.replace(/async function fetchEnvStatus\(\) \{[\s\S]*?\}\s*function toggleSecretInput[\s\S]*?\}\s*async function deleteEnvKey[\s\S]*?\}\s*async function saveEnvKey/m, jsUpdates + '\n    async function saveEnvKey');

fs.writeFileSync('public/index.html', html, 'utf8');
