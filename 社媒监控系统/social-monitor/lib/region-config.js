/**
 * lib/region-config.js
 * 区域配置共享模块 — 消除 4 个分析器中的 getRegionMap/getRegionLabel/getValueLabel 重复实现
 *
 * 用法：
 *   const { getRegionInfo, getValueLabel } = require('../lib/region-config');
 *   const info = getRegionInfo(receiverAccount);         // { region, business_sector, platform }
 *   const label = getValueLabel(receiverAccount, groupName); // 'L0'|'L1'|'L2'|'L3'
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'account-regions.json');

// 热加载缓存
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 60 * 1000;

function loadConfig() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return _cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const map = Object.fromEntries((raw.accounts || []).map(a => [a.account, a]));
    _cache = { map, overrides: raw._group_overrides || {} };
    _cacheAt = now;
  } catch (e) {
    console.error('[region-config] 重载失败:', e.message);
    if (!_cache) _cache = { map: {}, overrides: {} };
  }
  return _cache;
}

function getRegionInfo(receiverAccount) {
  const cfg = loadConfig();
  const info = cfg.map[receiverAccount];
  return info || { region: '未知区', business_sector: null, platform: 'wa' };
}

function getValueLabel(receiverAccount, groupName) {
  const cfg = loadConfig();
  if (groupName && cfg.overrides[groupName]?.value_label) {
    return cfg.overrides[groupName].value_label;
  }
  const info = cfg.map[receiverAccount];
  return (info && info.value_label) || 'L1';
}

function getAllAccounts() {
  return loadConfig().map;
}

module.exports = { getRegionInfo, getValueLabel, getAllAccounts };
