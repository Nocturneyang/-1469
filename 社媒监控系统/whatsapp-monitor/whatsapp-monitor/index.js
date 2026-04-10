require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeterminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

// =============================================
// .env 文件 运行时读写
// =============================================
const ENV_FILE = path.join(__dirname, '.env');

const ENV_KEYS = ['AI_API_URL', 'AI_API_KEY', 'AI_MODEL_NAME', 'DINGTALK_WEBHOOK', 'DINGTALK_SECRET'];
const MASK_KEYS = new Set(['AI_API_KEY']);

function readEnvFile() {
    const result = {};
    ENV_KEYS.forEach(k => { result[k] = process.env[k] || ''; });
    if (!fs.existsSync(ENV_FILE)) return result;
    try {
        fs.readFileSync(ENV_FILE, 'utf8').split('\n').forEach(line => {
            const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"]*)"?/);
            if (m && ENV_KEYS.includes(m[1])) result[m[1]] = m[2];
        });
    } catch (e) {}
    return result;
}

function writeEnvFile(updates) {
    // 先读现有内容（保留不在 ENV_KEYS 里的行）
    let lines = [];
    if (fs.existsSync(ENV_FILE)) {
        lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    }
    const touched = new Set();
    // 更新已有行
    lines = lines.map(line => {
        const m = line.match(/^([A-Z_]+)\s*=/);
        if (m && ENV_KEYS.includes(m[1]) && updates[m[1]] !== undefined) {
            touched.add(m[1]);
            return `${m[1]}="${updates[m[1]]}"`;
        }
        return line;
    });
    // 追加新 key
    ENV_KEYS.forEach(k => {
        if (!touched.has(k) && updates[k] !== undefined) {
            lines.push(`${k}="${updates[k]}"`);
        }
    });
    fs.writeFileSync(ENV_FILE, lines.join('\n'), 'utf8');
    // 同步到 process.env（运行时热更新）
    Object.entries(updates).forEach(([k, v]) => { process.env[k] = v; });
}

// =============================================
// 配置管理
// =============================================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const DEFAULT_CONFIG = require('./config');
const MAX_RECORDS = 500;

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE))
            return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    } catch (e) { console.error('⚠️ settings.json 读取失败，使用默认配置'); }
    return { ...DEFAULT_CONFIG };
}

function saveSettings(s) {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8'); }
    catch (e) { console.error('❌ 配置保存失败:', e.message); }
}

let currentConfig = loadSettings();

// =============================================
// 推送记录管理
// =============================================
const RECORDS_FILE = path.join(__dirname, 'records.json');
let records = [];
let stats = { total: 0, high: 0, medium: 0, low: 0, pushed: 0, filtered: 0 };

try {
    if (fs.existsSync(RECORDS_FILE)) {
        records = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
        records.forEach(r => {
            stats.total++;
            if (r.urgency === '高') stats.high++;
            else if (r.urgency === '中') stats.medium++;
            else stats.low++;
            if (r.pushed) stats.pushed++; else stats.filtered++;
        });
        console.log(`📂 已加载 ${records.length} 条历史记录`);
    }
} catch (e) { console.error('⚠️ records.json 读取失败:', e.message); }

function addRecord(record) {
    records.unshift(record);
    if (records.length > MAX_RECORDS) records.splice(MAX_RECORDS);
    stats.total++;
    if (record.urgency === '高') stats.high++;
    else if (record.urgency === '中') stats.medium++;
    else stats.low++;
    if (record.pushed) stats.pushed++; else stats.filtered++;
    try { fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2), 'utf8'); } catch (e) {}
    broadcastEvent('record', record);
    broadcastEvent('stats', stats);
}

// =============================================
// Express + SSE 服务
// =============================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sseClients = new Set();

function broadcastEvent(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(res => {
        try { res.write(payload); } catch (e) { sseClients.delete(res); }
    });
}

let waStatus = { connected: false, phone: null, name: null, qr: null, startedAt: new Date().toISOString() };

// SSE 实时事件流
app.get('/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    // 立即推送当前状态
    res.write(`event: status\ndata: ${JSON.stringify(waStatus)}\n\n`);
    res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
    res.write(`event: config\ndata: ${JSON.stringify(currentConfig)}\n\n`);
    req.on('close', () => sseClients.delete(res));
});

// 心跳，防止连接超时
setInterval(() => sseClients.forEach(res => { try { res.write(': ping\n\n'); } catch (e) { sseClients.delete(res); } }), 25000);

app.get('/api/status', (req, res) => res.json(waStatus));

app.get('/api/config', (req, res) => res.json(currentConfig));

app.post('/api/config', (req, res) => {
    currentConfig = { ...currentConfig, ...req.body };
    saveSettings(currentConfig);
    broadcastEvent('config', currentConfig);
    res.json({ success: true, config: currentConfig });
});

app.get('/api/records', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const urgency = req.query.urgency;
    let filtered = urgency && urgency !== 'all' ? records.filter(r => r.urgency === urgency) : records;
    const start = (page - 1) * limit;
    res.json({ total: filtered.length, page, pages: Math.ceil(filtered.length / limit), data: filtered.slice(start, start + limit) });
});

app.get('/api/stats', (req, res) => res.json(stats));

// 退出登录：登出 WhatsApp 并清除本地会话
app.post('/api/logout', async (req, res) => {
    try {
        await client.logout();
        waStatus = { connected: false, phone: null, name: null, qr: null, startedAt: waStatus.startedAt };
        broadcastEvent('status', waStatus);
        res.json({ success: true });
    } catch (e) {
        console.error('❌ 退出登录失败:', e.message);
        // 即便 logout() 抛错，也强制重置状态
        waStatus = { connected: false, phone: null, name: null, qr: null, startedAt: waStatus.startedAt };
        broadcastEvent('status', waStatus);
        res.json({ success: true, warn: e.message });
    }
});

// ── 获取所有已加入的 WhatsApp 群组 ──
app.get('/api/groups', async (req, res) => {
    if (!waStatus.connected) {
        return res.status(403).json({ success: false, error: 'WhatsApp 未连接，请先扫码登录' });
    }
    try {
        const chats = await client.getChats();
        const groups = chats
            .filter(c => c.isGroup)
            .map(c => ({
                id: c.id._serialized,
                name: c.name,
                participants: c.participants?.length ?? 0
            }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        res.json({ success: true, groups });
    } catch (e) {
        console.error('❌ 获取群组列表失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── 获取指定群组的成员列表 ──
app.get('/api/groups/members', async (req, res) => {
    if (!waStatus.connected) {
        return res.status(403).json({ success: false, error: 'WhatsApp 未连接，请先扫码登录' });
    }
    const groupId = req.query.id;   // 群 serialized id
    const groupName = req.query.name; // 群名（备用匹配）
    if (!groupId && !groupName) {
        return res.status(400).json({ success: false, error: '缺少 id 或 name 参数' });
    }
    try {
        const chats = await client.getChats();
        const group = chats.find(c =>
            c.isGroup && (groupId ? c.id._serialized === groupId : c.name === groupName)
        );
        if (!group) {
            return res.status(404).json({ success: false, error: '未找到该群组' });
        }
        const members = (group.participants || []).map(p => ({
            id: p.id._serialized,
            number: p.id.user,
            isAdmin: p.isAdmin || p.isSuperAdmin || false,
        }));
        res.json({ success: true, groupName: group.name, members });
    } catch (e) {
        console.error('❌ 获取群成员失败:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ──────────────────────────────────────────
// ENV CONFIG API
// ──────────────────────────────────────────
app.get('/api/env', (req, res) => {
    const env = readEnvFile();
    const safe = {};
    ENV_KEYS.forEach(k => {
        safe[k] = MASK_KEYS.has(k) && env[k] ? '•'.repeat(16) : (env[k] || '');
    });
    res.json(safe);
});

app.post('/api/env', (req, res) => {
    const updates = {};
    ENV_KEYS.forEach(k => {
        if (req.body[k] !== undefined) {
            // 若前端传来的是掩码（全是•），跳过不更新
            if (/^•+$/.test(req.body[k])) return;
            updates[k] = req.body[k];
        }
    });
    try {
        writeEnvFile(updates);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 测试钉钉 Webhook
app.post('/api/env/test-dingtalk', async (req, res) => {
    const { DINGTALK_WEBHOOK: webhook, DINGTALK_SECRET: secret } = req.body;
    if (!webhook || webhook.includes('xxxxxxxx')) {
        return res.json({ success: false, error: 'Webhook 地址无效或未填写' });
    }
    let url = webhook;
    if (secret?.trim()) {
        const ts = Date.now();
        const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
        url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
    }
    try {
        const r = await axios.post(url, {
            msgtype: 'text',
            text: { content: '✅ WhatsApp Monitor 钉钉 Webhook 连接测试成功！' }
        });
        if (r.data?.errcode === 0) return res.json({ success: true });
        return res.json({ success: false, error: `钉钉返回错误码 ${r.data?.errcode}: ${r.data?.errmsg}` });
    } catch (e) {
        return res.json({ success: false, error: e.message });
    }
});

app.delete('/api/records', (req, res) => {
    records = [];
    stats = { total: 0, high: 0, medium: 0, low: 0, pushed: 0, filtered: 0 };
    try { fs.writeFileSync(RECORDS_FILE, '[]', 'utf8'); } catch (e) {}
    broadcastEvent('stats', stats);
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🌐 控制面板已启动：http://localhost:${PORT}\n`));

// =============================================
// 消息防抖（单条模式用）
// =============================================
const lastTriggerTime = {};

// =============================================
// 对话窗口缓冲区（窗口模式用）
// =============================================
const msgBuffer      = {};   // { groupName: [{senderName, content, time, isKeyPerson}] }
const slidingTimer   = {};   // 滑动窗口定时器（最后一条消息后 N 秒触发）
const maxTimer       = {};   // 最大等待定时器（防止对话无限持续）

// =============================================
// 获取消息的有效监控配置（个人 > 群组 > 全局）
// =============================================
function getEffectiveGroupConfig(groupName, senderName, cfg) {
    // 1. 个人级别（最高优先级）
    const personKey = `${groupName}/${senderName}`;
    const pc = (cfg.personConfigs || {})[personKey];
    if (pc && pc.mode) {
        return {
            mode:            pc.mode,
            windowSec:       pc.windowSec       ?? cfg.windowSec       ?? 60,
            windowMaxSec:    pc.windowMaxSec     ?? cfg.windowMaxSec    ?? 300,
            debounceTimeSec: pc.debounceTimeSec  ?? cfg.debounceTimeSec ?? 30,
            _level: 'person',
        };
    }
    // 2. 群组级别
    const gc = (cfg.groupConfigs || {})[groupName];
    if (gc && gc.mode) {
        return {
            mode:            gc.mode,
            windowSec:       gc.windowSec       ?? cfg.windowSec       ?? 60,
            windowMaxSec:    gc.windowMaxSec     ?? cfg.windowMaxSec    ?? 300,
            debounceTimeSec: gc.debounceTimeSec  ?? cfg.debounceTimeSec ?? 30,
            _level: 'group',
        };
    }
    // 3. 全局默认
    return {
        mode:            cfg.windowMode ? 'window' : 'single',
        windowSec:       cfg.windowSec       ?? 60,
        windowMaxSec:    cfg.windowMaxSec     ?? 300,
        debounceTimeSec: cfg.debounceTimeSec  ?? 30,
        _level: 'global',
    };
}

// =============================================
// AI 分析 - 共用系统提示词构建
// =============================================
function buildSystemPrompt(extraRule) {
    const base = `你是Itnio Tech的WhatsApp群聊监控AI助手，专门分析与国际运营商合作伙伴的业务通信。

【业务背景】
Itnio是国际SMS通道运营商，核心业务是为客户提供短信发送路由。主要角色：
- A-Support / Itnio：己方支持团队；合作方NOC：对方网络运营中心
- 运营商合作伙伴（Vinoc、Sinch、Telecommerce、Chinasky、Gazeti、THEJE等）：路由提供方
- 各群组对话均为商业B2B运营沟通

【核心术语】
CR(Conversion/Click Rate)=短信投递成功率，0%=彻底失败；SID=发送方通道ID；VNL=虚拟号码列表（定期例行更新）；Route/路由=短信传输通道；Spam=消息被过滤到垃圾箱

【紧急度判断树】

🔴 高（分钟级响应，当前业务受损）——满足任一即为高：
· CR=0% 或 "no delivery" / "not delivering" / "0% CR" / "zero CR"
· 路由不可用："don't have that route" / "no route" / "route down" / "route not found"
· 消息全部被拦截/垃圾箱："all spam" / "blocked" / "blacklisted" / "not received"
· 账号暂停/封禁："suspended" / "account blocked" / "stopped"
· 明确标注紧急："urgent" / "ASAP" / "emergency" / "critical"
· 财务/计费重大异常

🟡 中（小时级响应，需要跟进操作）——满足任一即为中：
· CR下降但>0：提及CR但非0%，或"low CR" / "CR dropped" / "CR is X%"
· 路由切换且需确认/测试："changed the routing" / "new route, please test" / "please test this route"
· 新SID测试邀请："let's test new SID" / "test new SID" / "new SID ready"
· 需要配合提供信息："please share content" / "share examples" / "provide test data"
· 价格/配置变更请求："update price" / "new price" / "please update"
· 容量/流量询问（影响业务规划）："how many traffic" / "capacity" / "how much volume"
· SID账号资源调整："return SIDs" / "return old SIDs" / "SID list"
· 消息部分过滤/性能问题："some not delivered" / "partial" / "delay"
· 需要人工决策或确认操作的任何事项

🟢 低（留档参考，无需紧急响应）——以下情况为低：
· 例行系统通知（无需操作）："has been updated" / "VNL updated" / "numbering updated"
· 测试完成无异常汇报："received in main inbox" / "links opened correctly" / "tests passed"
· 简单确认或礼貌回复："sure" / "ok" / "noted" / "thank you" / "will do" / "understood"
· 普通问候或收尾语："hello team" / "good day" / "good morning" / "best regards"
· FYI同步无需操作："for your reference" / "just FYI" / "sharing update"

【few-shot 示例校准】
"we got 0% CR" → 高，CR归零路由完全失效
"we don't have that route, please check again" → 高，路由不存在紧急排查
"CR is only 0.51%" → 高，投递率骤降接近完全失败
"messages were not delivered to spam; received in main inbox" → 低，测试通过无问题
"We have changed the routing, please test this route, same price" → 中，路由切换需测试
"please share the message content so we can investigate" → 中，需要配合提供信息
"Let's test New SID?" → 中，测试邀请需响应
"we need to return some old SIDs you aren't using" → 中，需确认SID资源调整
"numbering in ITNIO_MKT has been updated" → 低，例行更新通知
"Hi team" / "sure" / "Good day" → 低，问候或简单确认

【判断原则】
1. 窗口模式多条对话：以最严重的单条内容定级
2. 内容模糊时优先考虑业务影响：有实质业务影响→中，无实质影响→低
3. 无论消息是英文/西班牙文/马来文，reason和summary必须翻译为简体中文
4. 只返回纯JSON，不加任何解释文字或Markdown`;

    if (extraRule && extraRule.trim()) {
        return base + `\n\n【用户自定义补充场景】
以下规则用于覆盖上述内置规则未能精确描述的特殊场景。
如与内置判断树存在分歧，应结合实际业务影响综合判断，不可机械套用：
${extraRule.trim()}`;
    }
    return base;
}

// =============================================
// AI 分析 - 单条消息
// =============================================
async function analyzeMessageWithAI({ groupName, senderName, content }) {
    const systemMsg = buildSystemPrompt(currentConfig.urgencyRule);
    const prompt = `分析下方WhatsApp群聊消息，按判断树确定紧急度并生成中文摘要。

【群聊】${groupName}
【发言人】${senderName}
【消息内容】
${content}

输出格式（纯JSON，无其他内容）：
{"urgency":"高/中/低","reason":"15字内中文理由","summary":"一句话中文摘要"}`;

    try {
        const apiUrl   = process.env.AI_API_URL   || 'https://api.moonshot.cn/v1/chat/completions';
        const apiKey   = process.env.AI_API_KEY   || process.env.KIMI_API_KEY || '';
        const modelName= process.env.AI_MODEL_NAME|| 'moonshot-v1-8k';

        const res = await axios.post(apiUrl, {
            model: modelName,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user',   content: prompt   },
            ],
            temperature: 0.1,
        }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });

        const raw = res.data.choices[0].message.content || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('No JSON in response: ' + raw.substring(0, 100));
        return JSON.parse(match[0]);
    } catch (e) {
        console.error('❌ AI 单条分析失败:', e.message);
        return { urgency: '未知', reason: 'API 异常', summary: '无法分析' };
    }
}

// =============================================
// AI 分析 - 对话窗口（批量）
// =============================================
async function analyzeWindowWithAI(groupName, messages) {
    const dialogue = messages.map((m, i) =>
        `[${i + 1}] ${m.senderName}${m.isKeyPerson ? '🎯' : ''}：${m.content}`
    ).join('\n');

    const systemMsg = buildSystemPrompt(currentConfig.urgencyRule);
    const prompt = `分析下方WhatsApp群聊对话（${messages.length}条），按判断树确定整体紧急度并生成中文摘要。

【群聊】${groupName}
【时间段】${messages[0].time} ~ ${messages[messages.length - 1].time}

【对话内容】
${dialogue}

判断原则：以对话中最严重的内容定级；summary需概括本段对话的核心事项。

输出格式（纯JSON，无其他内容）：
{"urgency":"高/中/低","reason":"15字内中文理由","summary":"整段对话一句话中文摘要"}`;

    try {
        const apiUrl   = process.env.AI_API_URL   || 'https://api.moonshot.cn/v1/chat/completions';
        const apiKey   = process.env.AI_API_KEY   || '';
        const modelName= process.env.AI_MODEL_NAME|| 'moonshot-v1-8k';

        const res = await axios.post(apiUrl, {
            model: modelName,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user',   content: prompt   },
            ],
            temperature: 0.1,
        }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });

        const raw = res.data.choices[0].message.content || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('No JSON in response: ' + raw.substring(0, 100));
        return JSON.parse(match[0]);
    } catch (e) {
        console.error('❌ AI 窗口分析失败:', e.message);
        return { urgency: '未知', reason: 'API 异常', summary: '无法分析' };
    }
}


// =============================================
// 窗口模式：冲刷缓冲区 → 批量分析 → 推送
// =============================================
async function flushBuffer(groupName) {
    // 清理定时器
    clearTimeout(slidingTimer[groupName]);
    clearTimeout(maxTimer[groupName]);
    delete slidingTimer[groupName];
    delete maxTimer[groupName];

    const messages = msgBuffer[groupName] || [];
    delete msgBuffer[groupName];
    if (!messages.length) return;

    const cfg = currentConfig;
    const hasKeyPerson = messages.some(m => m.isKeyPerson);
    const timeStr = messages[messages.length - 1].time;
    const groupLabel = groupName;

    console.log(`\n🪟 [${groupName}] 窗口关闭，共 ${messages.length} 条消息，开始批量分析...`);
    const aiAnalysis = await analyzeWindowWithAI(groupName, messages);
    console.log(`📊 [${aiAnalysis.urgency}] ${aiAnalysis.reason}`);

    let pushed = false;
    if (!cfg.pushOnlyImportant || aiAnalysis.urgency !== '低' || hasKeyPerson) {
        pushed = await sendWindowAlert(groupName, messages, aiAnalysis, hasKeyPerson);
    } else {
        console.log('🛡️ 低优先级窗口已过滤');
    }

    // 记录为一条聚合记录
    addRecord({
        id: Date.now(),
        time: timeStr,
        group: groupLabel,
        sender: `${messages.length} 条对话`,
        content: messages.map(m => `[${m.senderName}] ${m.content}`).join(' | ').substring(0, 500),
        urgency: aiAnalysis.urgency,
        reason: aiAnalysis.reason || '',
        summary: aiAnalysis.summary || '',
        isKeyPerson: hasKeyPerson,
        pushed,
        windowMode: true,
        messageCount: messages.length
    });
}

// =============================================
// 钉钉推送
// =============================================

async function sendDingTalkAlert({ groupName, senderName, content, time }, { urgency, reason, summary }, isKeyPerson) {
    if (!process.env.DINGTALK_WEBHOOK || process.env.DINGTALK_WEBHOOK.includes('xxxxxxxx')) return false;

    const levelIcon  = urgency === '高' ? '🚨' : urgency === '中' ? '⚠️' : 'ℹ️';
    const levelLabel = urgency === '高' ? '高紧急' : urgency === '中' ? '中紧急' : '低优先';
    const keyTag     = isKeyPerson ? ' 　🎯 **关键人**' : '';

    // 原始消息：多行时每行加引用符
    const rawLines = String(content).trim().split('\n').map(l => `> ${l}`).join('\n');

    const text = [
      `### ${levelIcon} 群聊监控预警`,
      ``,
      `**📌 群　聊**　${groupName}`,
      `**👤 发言人**　${senderName}${keyTag}`,
      `**🕐 时　间**　${time}`,
      ``,
      `**📊 紧急度**　${levelLabel}　｜　${reason}`,
      ``,
      `**📝 AI 摘要**`,
      `> ${summary || '（无摘要）'}`,
      ``,
      `**💬 原始消息**`,
      rawLines,
      ``,
      `---`,
      `*🤖 由 WhatsApp\-Monitor 自动推送*`
    ].join('\n');

    let url = process.env.DINGTALK_WEBHOOK;
    const secret = process.env.DINGTALK_SECRET;
    if (secret?.trim()) {
        const ts = Date.now();
        const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
        url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
    }

    const title = `${levelIcon} ${levelLabel} · ${groupName} · ${senderName}`;
    try {
        await axios.post(url, { msgtype: 'markdown', markdown: { title, text } });
        console.log('🔔 钉钉推送成功');
        return true;
    } catch (e) {
        console.error('❌ 钉钉推送失败:', e.message);
        return false;
    }
}

// 窗口模式钉钉推送（聚合多条消息）
async function sendWindowAlert(groupName, messages, { urgency, reason, summary }, hasKeyPerson) {
    if (!process.env.DINGTALK_WEBHOOK || process.env.DINGTALK_WEBHOOK.includes('xxxxxxxx')) return false;

    const levelIcon  = urgency === '高' ? '🚨' : urgency === '中' ? '⚠️' : 'ℹ️';
    const levelLabel = urgency === '高' ? '高紧急' : urgency === '中' ? '中紧急' : '低优先';
    const keyTag     = hasKeyPerson ? '　🎯 含关键人' : '';
    const startTime  = messages[0].time;
    const endTime    = messages[messages.length - 1].time;

    // 对话摘录（最多显示 10 条，超出截断）
    const shown = messages.slice(0, 10);
    const dialogLines = shown.map(m =>
        `> **${m.senderName}**${m.isKeyPerson ? '🎯' : ''}：${m.content.replace(/\n/g, ' ').substring(0, 80)}`
    ).join('\n');
    const moreHint = messages.length > 10 ? `\n> ···（另有 ${messages.length - 10} 条）` : '';

    const text = [
      `### ${levelIcon} 群聊对话摘要（${messages.length} 条）`,
      ``,
      `**📌 群　聊**　${groupName}${keyTag}`,
      `**🕐 时间段**　${startTime}`,
      `　　　　　　～ ${endTime}`,
      ``,
      `**📊 紧急度**　${levelLabel}　｜　${reason}`,
      ``,
      `**📝 AI 摘要**`,
      `> ${summary || '（无摘要）'}`,
      ``,
      `**💬 对话摘录**`,
      dialogLines + moreHint,
      ``,
      `---`,
      `*🤖 由 WhatsApp\\-Monitor 自动推送（对话窗口模式）*`
    ].join('\n');

    let url = process.env.DINGTALK_WEBHOOK;
    const secret = process.env.DINGTALK_SECRET;
    if (secret?.trim()) {
        const ts = Date.now();
        const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
        url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
    }

    const title = `${levelIcon} ${levelLabel} · ${groupName} · ${messages.length}条对话`;
    try {
        await axios.post(url, { msgtype: 'markdown', markdown: { title, text } });
        console.log('🔔 钉钉窗口推送成功');
        return true;
    } catch (e) {
        console.error('❌ 钉钉窗口推送失败:', e.message);
        return false;
    }
}

// =============================================
// WhatsApp 客户端
// =============================================

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run']
    }
});

client.on('qr', async (qr) => {
    console.log('\n📌 请扫描二维码登录...');
    qrcodeterminal.generate(qr, { small: true });
    try {
        waStatus.qr = await QRCode.toDataURL(qr, { width: 300, margin: 2, color: { dark: '#000', light: '#fff' } });
        waStatus.connected = false;
        broadcastEvent('status', waStatus);
    } catch (e) { console.error('QR 生成失败:', e.message); }
});

client.on('ready', () => {
    const info = client.info;
    waStatus = { connected: true, phone: info?.wid?.user || null, name: info?.pushname || null, qr: null, startedAt: waStatus.startedAt };
    console.log(`✅ WhatsApp 已登录：${waStatus.name} (+${waStatus.phone})`);
    console.log('👀 监控机器人运行中...');
    broadcastEvent('status', waStatus);
});

client.on('disconnected', (reason) => {
    console.log('⚠️ 断开连接:', reason);
    waStatus.connected = false;
    broadcastEvent('status', waStatus);
});

client.on('message_create', async (message) => {
    try {
        const chat = await message.getChat();
        if (!chat.isGroup) return;

        const cfg = currentConfig;

        // 自己发送的消息：根据开关决定是否跳过
        if (message.fromMe && !cfg.monitorOwnMessages) return;

        if (cfg.targetGroups?.length > 0 && !cfg.targetGroups.includes(chat.name)) return;

        if (message.type !== 'chat' && message.type !== 'extended_text') return;
        const content = message.body;
        if (!content?.trim()) return;

        const contact = await message.getContact();
        const senderName = contact.pushname || contact.name || contact.number;
        const groupName  = chat.name;
        const timeStr    = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const isKeyPerson = cfg.keyPersons?.some(n => senderName.includes(n)) || false;

        console.log(`\n[${timeStr}] 📩 [${groupName}] -> [${senderName}]`);

        // 获取该消息的有效监控配置（个人 > 群组 > 全局）
        const egc = getEffectiveGroupConfig(groupName, senderName, cfg);
        if (egc._level !== 'global') console.log(`⚙️ 使用${egc._level === 'person' ? '个人' : '群组'}级别配置`);

        // ── 对话窗口模式 ──────────────────────────────
        if (egc.mode === 'window') {
            if (!msgBuffer[groupName]) msgBuffer[groupName] = [];
            msgBuffer[groupName].push({ senderName, content, time: timeStr, isKeyPerson });
            console.log(`🪟 [${groupName}] 缓冲 ${msgBuffer[groupName].length} 条`);

            // 如果是关键人，立即冲刷（无需等待）
            if (isKeyPerson) {
                console.log(`🎯 关键人消息，立即触发窗口分析`);
                clearTimeout(slidingTimer[groupName]);
                clearTimeout(maxTimer[groupName]);
                delete slidingTimer[groupName];
                delete maxTimer[groupName];
                flushBuffer(groupName);
                return;
            }

            // 重置滑动窗口定时器
            clearTimeout(slidingTimer[groupName]);
            slidingTimer[groupName] = setTimeout(
                () => flushBuffer(groupName),
                egc.windowSec * 1000
            );

            // 首条消息时设置最大等待定时器
            if (!maxTimer[groupName]) {
                maxTimer[groupName] = setTimeout(
                    () => flushBuffer(groupName),
                    egc.windowMaxSec * 1000
                );
            }
            return;
        }

        // ── 单条消息模式 ──────────────────────────────
        const debounceMs = egc.debounceTimeSec * 1000;
        if (debounceMs > 0) {
            const now = Date.now();
            if (now - (lastTriggerTime[groupName] || 0) < debounceMs) {
                console.log(`⏳ [${groupName}] 防抖拦截`);
                return;
            }
            lastTriggerTime[groupName] = now;
        }

        let aiAnalysis;
        if (content.length <= 4 && !isKeyPerson) {
            aiAnalysis = { urgency: '低', reason: '极短消息', summary: '无意义' };
            console.log('💨 跳过 AI 分析（极短消息）');
        } else {
            console.log('🤖 AI 分析中...');
            aiAnalysis = await analyzeMessageWithAI({ groupName, senderName, content });
            console.log(`📊 [${aiAnalysis.urgency}] ${aiAnalysis.reason}`);
        }

        let pushed = false;
        if (!cfg.pushOnlyImportant || aiAnalysis.urgency !== '低' || isKeyPerson) {
            pushed = await sendDingTalkAlert({ groupName, senderName, content, time: timeStr }, aiAnalysis, isKeyPerson);
        } else {
            console.log('🛡️ 低优先级已过滤');
        }

        addRecord({
            id: Date.now(),
            time: timeStr,
            group: groupName,
            sender: senderName,
            content: content.substring(0, 500),
            urgency: aiAnalysis.urgency,
            reason: aiAnalysis.reason || '',
            summary: aiAnalysis.summary || '',
            isKeyPerson,
            pushed
        });

    } catch (err) {
        console.error('❌ 消息处理异常:', err.message);
    }
});


console.log('🚀 正在启动引擎...');
client.initialize();
