/**
 * lib/env-config.js
 * .env 文件读写统一模块
 *
 * 合并了 server.js 和 tg-session-store.js 中重复的 readEnvFile / writeEnvKeys 实现。
 * 所有 .env 读写操作必须通过此模块，确保原子性和一致性。
 */

const path = require('path');
const fs = require('fs');

const ENV_PATH = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), '.env');

function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return {};
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    const map = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        map[key] = val;
    }
    return map;
}

function writeEnvKeys(updates) {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (value === '') {
            if (regex.test(content)) {
                content = content.replace(new RegExp(`^${key}=.*\\n?`, 'm'), '');
            }
        } else {
            if (regex.test(content)) {
                content = content.replace(regex, `${key}=${value}`);
            } else {
                content = content.trimEnd() + '\n' + `${key}=${value}` + '\n';
            }
        }
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    for (const [key, value] of Object.entries(updates)) {
        if (value === '') delete process.env[key];
        else process.env[key] = value;
    }
}

module.exports = { ENV_PATH, readEnvFile, writeEnvKeys };
