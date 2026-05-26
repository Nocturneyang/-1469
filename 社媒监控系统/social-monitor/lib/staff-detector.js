/**
 * lib/staff-detector.js
 * 负责识别内部员工（ITNIO人员），支持动态读取 JSON 配置和内置规则
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'internal-staff.json');

// 初始化配置文件目录及文件
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    whitelist: ['ITNIO~ DJ', 'ITNIO Support', 'Routing'],
    keywords: ['itnio', 'support', 'routing']
  }, null, 2));
}


let cachedConfig = null;
let lastLoadTime = 0;

function loadConfig() {
  const now = Date.now();
  // 缓存 10 秒
  if (cachedConfig && (now - lastLoadTime < 10000)) {
    return cachedConfig;
  }
  
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cachedConfig = JSON.parse(raw);
    lastLoadTime = now;
  } catch (e) {
    console.error('[staff-detector] 加载白名单失败:', e.message);
    cachedConfig = { whitelist: [], keywords: ['itnio', 'support', 'routing'] };
  }
  return cachedConfig;
}

function isInternalStaff(senderName) {
  if (!senderName) return false;
  
  const config = loadConfig();
  const name = String(senderName).trim();
  const lowerName = name.toLowerCase();

  // 1. 完全匹配白名单（如特殊姓名 David, Jessica 等）
  if (config.whitelist && config.whitelist.includes(name)) {
    return true;
  }

  // 2. 匹配关键字（如前缀或包含特定字母）
  if (config.keywords && config.keywords.length > 0) {
    for (const kw of config.keywords) {
      if (lowerName.includes(kw.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

module.exports = {
  isInternalStaff,
  CONFIG_PATH
};
