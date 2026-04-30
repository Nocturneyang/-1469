const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Add "清空" buttons for DingTalk configurations
html = html.replace(/<button class="btn-save" onclick="saveEnvKey\('DINGTALK_([A-Z_]+)'\)">保存(?:秘钥)?<\/button>/g, (match, key) => {
    return match + `\n                    <button class="btn-danger" style="margin-left:4px" onclick="deleteEnvKey('DINGTALK_${key}')">清空</button>`;
});

// 2. Change r-account to select
html = html.replace(
    '<input type="text" id="r-account" class="form-control" placeholder="如：wa-oumei_wa 或 tg-account1" />\n        <div style="font-size:12px;color:var(--t3);margin-top:6px">对应数据库 receiver_account 字段值，前缀 wa- 或 tg-</div>',
    '<select id="r-account" class="form-control"><option value="">-- 请选择账号 --</option></select>\n        <div style="font-size:12px;color:var(--t3);margin-top:6px">对应数据库 receiver_account 字段值，需先在「帐号管理」中添加</div>'
);

// 3. Add editRegion button and store allRegions
html = html.replace(
    /<td><button class="btn-danger" onclick="deleteRegion\('\${escapeHtml\(a\.account\)}'\)">删除<\/button><\/td>/g,
    `<td>
              <button class="btn-sm" style="margin-right:6px" onclick="editRegion('\${escapeHtml(a.account)}')">编辑</button>
              <button class="btn-danger" onclick="deleteRegion('\${escapeHtml(a.account)}')">删除</button>
            </td>`
);

// Store global regions
html = html.replace('const tbody = document.getElementById(\'region-table-body\');', 'const tbody = document.getElementById(\'region-table-body\');\n        window.allRegions = data.data;');

// Modify openRegionModal
const newOpenRegion = `
    async function openRegionModal(editData = null) {
      regionModal.style.display = 'flex';
      const accSelect = document.getElementById('r-account');
      
      try {
        const res = await fetch(API_BASE + '/accounts');
        const data = await res.json();
        if (data.success) {
          accSelect.innerHTML = '<option value="">-- 请选择账号 --</option>';
          data.data.forEach(a => {
            accSelect.innerHTML += \`<option value="\${a.id}">\${a.id} (\${a.platform})</option>\`;
          });
        }
      } catch (e) { accSelect.innerHTML = '<option value="">获取账号失败</option>'; }

      if (editData) {
        // If editData.account is not in options, add it
        if (!Array.from(accSelect.options).find(o => o.value === editData.account)) {
            accSelect.innerHTML += \`<option value="\${editData.account}">\${editData.account} (保留)</option>\`;
        }
        document.getElementById('r-account').value = editData.account;
        document.getElementById('r-account').disabled = true;
        document.getElementById('r-platform').value = editData.platform;
        document.getElementById('r-region').value = editData.region;
        document.getElementById('r-owner').value = editData.owner;
        document.getElementById('r-dingtalk').value = editData.owner_dingtalk_id;
        document.getElementById('r-desc').value = editData.description;
      } else {
        document.getElementById('r-account').disabled = false;
        document.getElementById('r-account').value = '';
        document.getElementById('r-platform').value = 'wa';
        document.getElementById('r-region').value = '';
        document.getElementById('r-owner').value = '';
        document.getElementById('r-dingtalk').value = '';
        document.getElementById('r-desc').value = '';
      }
    }
    
    function editRegion(account) {
      const data = window.allRegions.find(a => a.account === account);
      if (data) openRegionModal(data);
    }
`;
html = html.replace('function openRegionModal() { regionModal.style.display = \'flex\'; }', newOpenRegion);

// Add deleteEnvKey function
const newDeleteEnvKey = `
    async function deleteEnvKey(key) {
      if (!confirm('确定要清空该配置吗？')) return;
      try {
        const res = await fetch(API_BASE + '/config/env', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: '' })
        });
        const data = await res.json();
        if (data.success) {
          const input = document.getElementById('input-' + key);
          if (input) input.value = '';
          showToast('已清空配置');
          fetchEnvStatus();
        } else {
          showToast(data.error, 'error');
        }
      } catch (e) { showToast('清空失败，网络错误', 'error'); }
    }
`;
html = html.replace('async function saveEnvKey(key) {', newDeleteEnvKey + '\n    async function saveEnvKey(key) {');

fs.writeFileSync('public/index.html', html, 'utf8');
