/**
 * lib/dingtalk.js
 * 钉钉机器人推送工具库
 *
 * 支持：
 *   - text 格式（普通文本，支持 @成员）
 *   - markdown 格式（富文本，支持 @成员）
 *   - 三路机器人（alert / digest / weekly），从 .env 读取 Webhook
 *   - 运维専用频道（SYSTEM_OPS），用于账号健康类告警（提醒/掉线）
 *
 * 用法示例：
 *   const dt = require('./lib/dingtalk');
 *   await dt.sendAlert({ title: '标题', content: '**内容**', atMobiles: ['1388138xxxx'] });
 *   await dt.sendDigest({ title: '日报', content: '...' });
 *   await dt.sendWeekly({ title: '周报', content: '...' });
 *   await dt.sendAccountAlert({ platform: 'wa', accountId: 'wa-xxx', region: '欧美区', status: 'disconnected', detail: '...' });
 */

'use strict';

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { formatShanghai } = require('./time');

// ─── 签名计算（加签模式）────────────────────────────────────────

/**
 * 根据 secret 生成钉钉加签 URL
 * @param {string} webhookUrl  原始 Webhook 地址
 * @param {string} [secret]    加签密钥（SEC...），可选
 * @returns {string} 带签名参数的 URL
 */
function signUrl(webhookUrl, secret) {
  if (!secret) return webhookUrl;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto.createHmac('sha256', secret)
    .update(stringToSign, 'utf8')
    .digest('base64');
  return `${webhookUrl}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}

// ─── 内部发送函数 ────────────────────────────────────────────────

/**
 * @param {string} webhookUrl
 * @param {string} secret
 * @param {object} payload
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, errcode?:number}>}
 */
async function _send(webhookUrl, secret, payload) {
  if (!webhookUrl || webhookUrl.includes('YOUR_')) {
    console.warn('[DingTalk] Webhook 未配置，跳过推送。payload:', JSON.stringify(payload).slice(0, 100));
    return { ok: false, skipped: true, reason: 'webhook_not_configured' };
  }
  const url = signUrl(webhookUrl, secret);
  try {
    const res = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    if (res.data && res.data.errcode !== 0) {
      console.error('[DingTalk] 推送失败:', res.data.errmsg, '| payload:', JSON.stringify(payload).slice(0, 120));
      return { ok: false, reason: res.data.errmsg || 'dingtalk_error', errcode: res.data.errcode };
    }
    return { ok: true, errcode: res.data?.errcode ?? 0 };
  } catch (err) {
    console.error('[DingTalk] 请求出错:', err.message);
    return { ok: false, reason: err.message || 'request_error' };
  }
}

// ─── 格式构建 ────────────────────────────────────────────────────

/**
 * 构建 Markdown 消息 payload
 * @param {string} title   - 消息标题（通知栏展示）
 * @param {string} content - Markdown 内容
 * @param {string[]} [atMobiles] - 被 @ 的手机号列表
 * @param {boolean} [atAll]
 */
function buildMarkdown(title, content, atMobiles = [], atAll = false) {
  return {
    msgtype: 'markdown',
    markdown: { title, text: content },
    at: { atMobiles, isAtAll: atAll },
  };
}

/**
 * 构建 Text 消息 payload
 */
function buildText(content, atMobiles = [], atAll = false) {
  return {
    msgtype: 'text',
    text: { content },
    at: { atMobiles, isAtAll: atAll },
  };
}

// ─── Webhook 解析 ────────────────────────────────────────────────
/**
 * 根据类型和平台解析 webhook URL 及 secret
 */
const WEBHOOKS_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'webhooks.json');
let warnedMissingWebhooks = false;

function getRegionWebhooks() {
  try {
    if (fs.existsSync(WEBHOOKS_PATH)) {
      return JSON.parse(fs.readFileSync(WEBHOOKS_PATH, 'utf8'));
    }
    if (!warnedMissingWebhooks) {
      console.warn('[DingTalk] 未找到 config/webhooks.json，将回退到环境变量 DINGTALK_* 路由');
      warnedMissingWebhooks = true;
    }
  } catch (err) {
    console.error('Error reading webhooks.json:', err.message);
  }
  return {};
}

function normalizeKeyPart(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function findHookByKeys(keys) {
  const hooks = getRegionWebhooks();
  for (const key of keys.filter(Boolean)) {
    if (hooks[key] && hooks[key].url) {
      return { url: hooks[key].url, secret: hooks[key].secret, matchedKey: key };
    }
  }
  return null;
}

function buildWebhookKeys(typeUpper, platform, region, businessSector) {
  const p = normalizeKeyPart(platform).toLowerCase();
  const r = normalizeKeyPart(region);
  const s = normalizeKeyPart(businessSector);
  const keys = [];
  if (p && r && s) keys.push(`${typeUpper}_${p}_${r}_${s}`);
  if (p && r) keys.push(`${typeUpper}_${p}_${r}`);
  if (p && s) keys.push(`${typeUpper}_${p}_${s}`);
  if (r && s) keys.push(`${typeUpper}_${r}_${s}`);
  if (r) keys.push(`${typeUpper}_${r}`);
  return keys;
}

function resolveConfig(type, platform, region, businessSector) {
  let url = null;
  let secret = null;
  const typeUpper = type.toUpperCase();

  // SYSTEM_OPS: 独立运维通道，不分平台/区域
  if (typeUpper === 'SYSTEM_OPS') {
    const hooks = getRegionWebhooks();
    if (hooks['SYSTEM_OPS'] && hooks['SYSTEM_OPS'].url) {
      return { url: hooks['SYSTEM_OPS'].url, secret: hooks['SYSTEM_OPS'].secret };
    }
    return { url: process.env.DINGTALK_SYSTEM_OPS, secret: process.env.DINGTALK_SYSTEM_OPS_SECRET };
  }

  // ALERT_P0 / ALERT_P1 / ALERT_P2 / ALERT_SID：分级告警，优先查分级专属配置，未命中回退至通用 ALERT
  const ALERT_SUB_TYPES = ['ALERT_P0', 'ALERT_P1', 'ALERT_P2', 'ALERT_SID'];
  if (ALERT_SUB_TYPES.includes(typeUpper)) {
    // 1. 查分级专属配置（ALERT_P1_wa_南亚区_直连供应商 → ALERT_P1_wa_南亚区）
    const matched = findHookByKeys(buildWebhookKeys(typeUpper, platform, region, businessSector));
    if (matched) return matched;
    // 2. 查分级平台兜底 ENV（DINGTALK_ALERT_P0_WA）
    if (platform) {
      const envKey = `DINGTALK_${typeUpper}_${platform.toUpperCase()}`;
      if (process.env[envKey]) {
        return { url: process.env[envKey], secret: process.env[envKey + '_SECRET'] || process.env.DINGTALK_SECRET, matchedKey: envKey };
      }
    }
    // 3. 回退至通用 ALERT 配置（向后兼容）
    return resolveConfig('ALERT', platform, region, businessSector);
  }

  // 1. Region/Sector + Platform specific (from JSON)
  const matched = findHookByKeys(buildWebhookKeys(typeUpper, platform, region, businessSector));
  if (matched) return matched;

  // 2. Platform specific fallback (from ENV)
  if (platform) {
    const platUpper = platform.toUpperCase();
    url = process.env[`DINGTALK_${typeUpper}_${platUpper}`];
    secret = process.env[`DINGTALK_${typeUpper}_${platUpper}_SECRET`];
    if (url) return { url, secret: secret || process.env[`DINGTALK_${typeUpper}_SECRET`] || process.env.DINGTALK_SECRET, matchedKey: `DINGTALK_${typeUpper}_${platUpper}` };
  }
  
  // 3. Global fallback (from ENV)
  if (!url) {
    url = process.env[`DINGTALK_${typeUpper}`];
    secret = secret || process.env[`DINGTALK_${typeUpper}_SECRET`] || process.env.DINGTALK_SECRET;
    if (url) return { url, secret, matchedKey: `DINGTALK_${typeUpper}` };
  } else {
    secret = secret || process.env[`DINGTALK_${typeUpper}_SECRET`] || process.env.DINGTALK_SECRET;
  }
  
  return { url, secret };
}

function hasRegionalWebhook(type, platform, region, businessSector) {
  if (!platform || (!region && !businessSector)) return false;
  return !!findHookByKeys(buildWebhookKeys(type.toUpperCase(), platform, region, businessSector));
}

// ─── 三路机器人公开接口 ──────────────────────────────────────────

/**
 * 🚨 告警群推送（维度1+2）
 * @param {object} opts
 * @param {string} opts.title    - 消息标题
 * @param {string} opts.content  - Markdown 内容
 * @param {string[]} [opts.atMobiles]
 * @param {boolean} [opts.atAll]
 * @param {string} [opts.platform]
 * @param {string} [opts.region]
 * @param {string} [opts.alertType]  - 'P0' | 'P1' | 'P2' | 'SID' | undefined（undefined=通用ALERT）
 */
async function sendAlert({ title, content, atMobiles = [], atAll = false, platform, region, businessSector, alertType }) {
  const type = alertType ? `ALERT_${alertType.toUpperCase()}` : 'ALERT';
  const { url, secret } = resolveConfig(type, platform, region, businessSector);
  return await _send(url, secret, buildMarkdown(title, content, atMobiles, atAll));
}

/**
 * 📋 日报群推送（维度3）
 */
async function sendDigest({ title, content, atMobiles = [], platform, region, businessSector }) {
  const { url, secret } = resolveConfig('DIGEST', platform, region, businessSector);
  return await _send(url, secret, buildMarkdown(title, content, atMobiles));
}

/**
 * 📊 周报群推送（维度4）
 */
async function sendWeekly({ title, content, atMobiles = [], platform, region, businessSector }) {
  const { url, secret } = resolveConfig('WEEKLY', platform, region, businessSector);
  return await _send(url, secret, buildMarkdown(title, content, atMobiles));
}

/**
 * 快捷：发送 SID 变更通知（使用告警机器人）
 */
async function sendSidChangeAlert({ groupName, region, senderName, sidList, platform, businessSector, alertType }) {
  const title = `[SID配置更新] ${region}-${groupName}`;
  const content = [
    `### 🔧 [SID配置更新] ${region} | ${groupName}`,
    '',
    `**发送人：** ${senderName}`,
    `**更新节点：** ${sidList.join(' / ')}（共${sidList.length}个）`,
    `**时间：** ${formatShanghai()}`,
  ].join('\n');
  return await sendAlert({ title, content, platform, region, businessSector, alertType: alertType || 'SID' });
}

/**
 * 快捷：发送问题升级告警
 */
async function sendEscalation({ groupName, region, issueType, openedAt, durationMins, atMobiles = [], platform, businessSector, alertType }) {
  const title = `[问题升级] ${region}-${groupName} 未解决`;
  const openedStr = formatShanghai(openedAt);
  const content = [
    `### ⏰ [问题升级] ${region} | ${groupName}`,
    '',
    `**问题类型：** ${issueType}`,
    `**开始时间：** ${openedStr}`,
    `**持续时长：** ${Math.round(durationMins)} 分钟`,
    `**状态：** 仍未收到闭环确认，请介入处理`,
  ].join('\n');
  return await sendAlert({ title, content, atMobiles, platform, region, businessSector, alertType: alertType || 'P1' });
}

/**
 * 🔧 系统运维层告警（账号健康类）
 * 推送到独立的 SYSTEM_OPS 通道，与业务告警隔离。
 * 适用于：WA/TG/Teams 账号掉线、Session 过期、进程崩溃等运维事件。
 *
 * @param {object} opts
 * @param {string} opts.platform   平台（wa / tg / teams）
 * @param {string} opts.accountId  账号 ID（如 wa-yatai-wa）
 * @param {string} [opts.region]   所属区域（如 亚太区）
 * @param {string} opts.status     状态：disconnected / session_expired / crashed / reconnected
 * @param {string} opts.detail     具体说明
 */
async function sendAccountAlert({ platform, accountId, region, status, detail }) {
  const statusIcon = {
    disconnected: '🔴',
    session_expired: '🟠',
    crashed: '💥',
    reconnected: '🟢',
  }[status] || '⚠️';

  const platformLabel = { wa: 'WhatsApp', tg: 'Telegram Bot', tgu: 'Telegram 用户账号', teams: 'Teams' }[platform] || platform;
  const title = `${statusIcon} [账号状态] ${platformLabel} | ${accountId}`;
  const content = [
    `### ${statusIcon} 采集账号状态变更`,
    `**平台：** ${platformLabel}`,
    `**账号：** ${accountId}`,
    `**区域：** ${region || '未配置'}`,
    `**状态：** ${detail}`,
    `**时间：** ${formatShanghai()}`,
  ].join('\n');

  const { url, secret } = resolveConfig('SYSTEM_OPS');
  return await _send(url, secret, buildMarkdown(title, content));
}

module.exports = {
  sendAlert,
  sendDigest,
  sendWeekly,
  sendSidChangeAlert,
  sendEscalation,
  sendAccountAlert,
  buildMarkdown,
  buildText,
  hasRegionalWebhook,
  resolveConfig,
  buildWebhookKeys,
};
