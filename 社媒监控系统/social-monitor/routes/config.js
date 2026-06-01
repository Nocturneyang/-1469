const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { readEnvFile, writeEnvKeys } = require('../lib/env-config');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
const ACCOUNT_REGIONS_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'account-regions.json');
const WEBHOOKS_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'webhooks.json');
const STAFF_CONFIG_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'config', 'internal-staff.json');

function readWebhooksFile() {
    if (!fs.existsSync(WEBHOOKS_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(WEBHOOKS_PATH, 'utf8'));
    } catch(e) { return {}; }
}

function writeWebhooksFile(data) {
    fs.writeFileSync(WEBHOOKS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

const ENV_KEYS = ['DINGTALK_ALERT', 'DINGTALK_DIGEST', 'DINGTALK_WEEKLY',
                  'DINGTALK_ALERT_WA', 'DINGTALK_DIGEST_WA', 'DINGTALK_WEEKLY_WA',
                  'DINGTALK_ALERT_TG', 'DINGTALK_DIGEST_TG', 'DINGTALK_WEEKLY_TG',
                  'DINGTALK_ALERT_TGU', 'DINGTALK_DIGEST_TGU', 'DINGTALK_WEEKLY_TGU',
                  'DINGTALK_ALERT_TEAMS', 'DINGTALK_DIGEST_TEAMS', 'DINGTALK_WEEKLY_TEAMS',
                  'DINGTALK_SYSTEM_OPS',
                  'DINGTALK_ALERT_SECRET', 'DINGTALK_DIGEST_SECRET', 'DINGTALK_WEEKLY_SECRET',
                  'DINGTALK_ALERT_WA_SECRET', 'DINGTALK_DIGEST_WA_SECRET', 'DINGTALK_WEEKLY_WA_SECRET',
                  'DINGTALK_ALERT_TG_SECRET', 'DINGTALK_DIGEST_TG_SECRET', 'DINGTALK_WEEKLY_TG_SECRET',
                  'DINGTALK_ALERT_TGU_SECRET', 'DINGTALK_DIGEST_TGU_SECRET', 'DINGTALK_WEEKLY_TGU_SECRET',
                  'DINGTALK_ALERT_TEAMS_SECRET', 'DINGTALK_DIGEST_TEAMS_SECRET', 'DINGTALK_WEEKLY_TEAMS_SECRET',
                  'DINGTALK_SYSTEM_OPS_SECRET',
                  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_MODEL_FAST', 'OPENAI_MODEL_PRO', 'GEMINI_API_KEY'];

router.get('/config/webhooks', (req, res) => {
    try {
        const hooks = readWebhooksFile();
        res.json({ success: true, data: hooks });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/config/webhooks', requireAdmin, (req, res) => {
    const { type, platform, regions, url, secret } = req.body;
    if (!type || !platform || !regions || !Array.isArray(regions) || regions.length === 0 || !url) {
        return res.status(400).json({ success: false, error: '缺少必填参数或区域列表为空' });
    }
    try {
        const hooks = readWebhooksFile();
        regions.forEach(region => {
            const key = `${type.toUpperCase()}_${platform.toLowerCase()}_${region}`;
            hooks[key] = { url, secret: secret || '' };
        });
        writeWebhooksFile(hooks);
        res.json({ success: true, message: '区域 Webhook 保存成功' });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/config/webhooks/:key', requireAdmin, (req, res) => {
    const { key } = req.params;
    if (!/^[\w\u4e00-\u9fa5]+$/.test(key)) return res.status(400).json({ success: false, error: 'Invalid webhook key format' });
    try {
        const hooks = readWebhooksFile();
        if (hooks[req.params.key]) {
            delete hooks[req.params.key];
            writeWebhooksFile(hooks);
        }
        res.json({ success: true, message: '已删除' });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/config/env', (req, res) => {
    try {
        const env = readEnvFile();
        const result = {};
        for (const k of ENV_KEYS) {
            const v = env[k] || '';
            const isPlaceholder = v.includes('YOUR_') || v.includes('your_');
            const isSet = !!(v && !isPlaceholder);
            const isSensitive = k.includes('KEY') || k.includes('DINGTALK');
            result[k] = isSet
                ? (isSensitive ? (v.length > 16 ? v.slice(0, 12) + '****' + v.slice(-4) : '****') : v)
                : '';
            result[k + '_set'] = isSet;
        }
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/config/env', requireAdmin, (req, res) => {
    try {
        const updates = {};
        for (const key of ENV_KEYS) {
            const val = req.body[key];
            if (val !== undefined && typeof val === 'string') {
                updates[key] = val.trim();
            }
        }
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ success: false, error: '没有提供任何有效配置项' });
        }
        writeEnvKeys(updates);
        res.json({ success: true, message: `已更新 ${Object.keys(updates).join(', ')}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/ai/test', requireAdmin, async (req, res) => {
    const env    = readEnvFile();
    const apiKey = env['OPENAI_API_KEY'] || '';
    const base   = (env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1').replace(/\/$/, '');
    const model  = env['OPENAI_MODEL'] || 'gpt-4o-mini';
    if (!apiKey || apiKey.includes('your_')) {
        return res.json({ success: false, error: 'OPENAI_API_KEY 未配置' });
    }
    try {
        const start = Date.now();
        const r = await axios.post(
            `${base}/chat/completions`,
            { model, messages: [{ role: 'user', content: 'Reply with the single word: OK' }], max_tokens: 16 },
            { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        const reply = r.data?.choices?.[0]?.message?.content?.trim() || '(empty)';
        res.json({ success: true, model, baseUrl: base, reply, latencyMs: Date.now() - start });
    } catch (err) {
        res.json({
            success: false,
            status: err?.response?.status,
            error:  err?.response?.data?.error?.message || err.message,
            model, baseUrl: base
        });
    }
});

router.get('/config/regions', (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        res.json({ success: true, data: config.accounts || [] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/config/regions', requireAdmin, (req, res) => {
    const { account, region, business_sector, platform, owner, owner_dingtalk_id, description } = req.body;
    if (!account || !region || !platform) {
        return res.status(400).json({ success: false, error: '缺少 account / region / platform 字段' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(account)) {
        return res.status(400).json({ success: false, error: 'account 只允许英文数字下划线中划线（支持驼峰命名）' });
    }
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        const accounts = config.accounts || [];
        const idx = accounts.findIndex(a => a.account === account);
        const entry = { account, region, business_sector: business_sector || '', platform, owner: owner || '', owner_dingtalk_id: owner_dingtalk_id || '', description: description || '' };
        if (idx >= 0) {
            accounts[idx] = entry;
        } else {
            accounts.push(entry);
        }
        config.accounts = accounts;
        fs.writeFileSync(ACCOUNT_REGIONS_PATH, JSON.stringify(config, null, 2), 'utf8');
        res.json({ success: true, message: `${idx >= 0 ? '更新' : '新增'}成功：${account}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/config/regions/:account', requireAdmin, (req, res) => {
    const { account } = req.params;
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        config.accounts = (config.accounts || []).filter(a => a.account !== account);
        fs.writeFileSync(ACCOUNT_REGIONS_PATH, JSON.stringify(config, null, 2), 'utf8');
        res.json({ success: true, message: `已删除：${account}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/config/staff', (req, res) => {
    try {
        if (!fs.existsSync(STAFF_CONFIG_PATH)) {
             return res.json({ success: true, data: { whitelist: ['ITNIO~ DJ', 'ITNIO Support', 'Routing'], keywords: ['itnio', 'support', 'routing'] } });
        }
        const config = JSON.parse(fs.readFileSync(STAFF_CONFIG_PATH, 'utf8'));
        res.json({ success: true, data: config });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/config/staff', requireAdmin, (req, res) => {
    try {
        const { whitelist, keywords } = req.body;
        const config = {
            whitelist: Array.isArray(whitelist) ? whitelist : [],
            keywords: Array.isArray(keywords) ? keywords : []
        };
        fs.writeFileSync(STAFF_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        res.json({ success: true, message: '内部员工配置已更新' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/config/test-webhook', requireAdmin, async (req, res) => {
    let { key, url, secret, isRegionWebhook } = req.body;
    
    if (!url && key) {
        if (isRegionWebhook) {
            const hooks = readWebhooksFile();
            if (hooks[key]) {
                url = hooks[key].url;
                secret = hooks[key].secret;
            }
        } else {
            url = process.env[key];
            if (!secret) {
                secret = process.env[`${key}_SECRET`];
            }
        }
    }

    if (!url || !url.startsWith('http')) {
        return res.json({ success: false, error: '未提供有效的 Webhook URL，且系统未配置此项' });
    }
    
    let targetUrl = url;
    if (secret) {
        const timestamp = Date.now();
        const stringToSign = `${timestamp}\n${secret}`;
        const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
        targetUrl = `${url}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    }

    try {
        const payload = {
            msgtype: "markdown",
            markdown: {
                title: "✅ 连通性测试成功",
                text: "### ✅ ITNIO 社媒监控系统\n\n您已成功配置并联通了此通道机器人的 Webhook！\n\n> *This is an automated test message.*"
            }
        };
        const start = Date.now();
        const r = await axios.post(targetUrl, payload, { timeout: 10000 });
        if (r.data && r.data.errcode !== 0 && r.data.errcode !== undefined) {
            return res.json({ success: false, error: r.data.errmsg || 'Unknown DingTalk Error' });
        }
        res.json({ success: true, latencyMs: Date.now() - start });
    } catch (err) {
        res.json({ success: false, error: err?.response?.data?.errmsg || err?.response?.data?.description || err.message });
    }
});

router.get('/config/value-labels', (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        const accounts = (config.accounts || []).map(a => ({
            account: a.account,
            region: a.region,
            business_sector: a.business_sector || '',
            platform: a.platform,
            value_label: a.value_label || 'L1',
            description: a.description || '',
        }));
        const groupOverrides = config._group_overrides || {};
        const guide = config._value_label_guide || {};
        res.json({ success: true, data: { accounts, group_overrides: groupOverrides, guide } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/config/value-labels', requireAdmin, (req, res) => {
    const { type, key, value_label, reason } = req.body;
    if (!type || !key || !value_label) {
        return res.status(400).json({ success: false, error: '缺少 type / key / value_label 字段' });
    }
    if (!['account', 'group'].includes(type)) {
        return res.status(400).json({ success: false, error: 'type 必须是 account 或 group' });
    }
    if (!/^L[0-3]$/.test(value_label)) {
        return res.status(400).json({ success: false, error: 'value_label 必须是 L0/L1/L2/L3' });
    }
    console.log('[value-labels] POST body:', JSON.stringify(req.body));
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        if (type === 'account') {
            const accounts = config.accounts || [];
            const idx = accounts.findIndex(a => a.account === key);
            if (idx < 0) {
                console.warn('[value-labels] 账号 %s 不存在', key);
                return res.status(404).json({ success: false, error: `账号 ${key} 不存在` });
            }
            accounts[idx].value_label = value_label;
            config.accounts = accounts;
        } else {
            if (!config._group_overrides) config._group_overrides = {};
            config._group_overrides[key] = { value_label, reason: reason || '' };
        }
        fs.writeFileSync(ACCOUNT_REGIONS_PATH, JSON.stringify(config, null, 2), 'utf8');
        console.log('[value-labels] ✅ 已更新 %s=%s → %s', type, key, value_label);
        res.json({ success: true, message: `已更新 ${type}=${key} → ${value_label}` });
    } catch (err) {
        console.error('[value-labels] 写入失败:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/config/value-labels', requireAdmin, (req, res) => {
    const { type, key } = req.body;
    if (type !== 'group' || !key) {
        return res.status(400).json({ success: false, error: '当前仅支持删除群覆盖标签 (type=group)' });
    }
    try {
        const config = JSON.parse(fs.readFileSync(ACCOUNT_REGIONS_PATH, 'utf8'));
        if (config._group_overrides?.[key]) {
            delete config._group_overrides[key];
            fs.writeFileSync(ACCOUNT_REGIONS_PATH, JSON.stringify(config, null, 2), 'utf8');
            res.json({ success: true, message: `已删除群覆盖标签：${key}` });
        } else {
            res.status(404).json({ success: false, error: `群覆盖标签 ${key} 不存在` });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
