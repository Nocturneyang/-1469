'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.DATA_DIR || path.join(__dirname, '..');
const SESSION_ROOT = process.env.ACCOUNT_SESSION_DIR || path.join(ROOT, 'collector-sessions');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

function configuredSecret() {
    return process.env.ACCOUNT_SESSION_ENCRYPTION_KEY || process.env.TEAMS_TOKEN_ENCRYPTION_KEY || '';
}

function requireSecret() {
    const secret = configuredSecret();
    if (!secret || secret === 'your_encryption_key_here') {
        throw new Error('ACCOUNT_SESSION_ENCRYPTION_KEY is required for encrypted account sessions');
    }
    return secret;
}

function deriveKey(secret, salt) {
    return crypto.pbkdf2Sync(secret, salt, 120000, KEY_LENGTH, 'sha256');
}

function encryptString(plainText) {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = deriveKey(requireSecret(), salt);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
        v: 1,
        alg: ALGORITHM,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: encrypted.toString('base64')
    });
}

function decryptString(payload) {
    const envelope = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!envelope || envelope.v !== 1 || envelope.alg !== ALGORITHM) {
        throw new Error('Unsupported encrypted session payload');
    }
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const data = Buffer.from(envelope.data, 'base64');
    const key = deriveKey(requireSecret(), salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function safeName(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_.-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120);
}

function sessionDir(platform, accountName) {
    return path.join(SESSION_ROOT, safeName(platform), safeName(accountName));
}

function encryptedFilePath(platform, accountName, fileName) {
    return path.join(sessionDir(platform, accountName), safeName(fileName));
}

function writeEncryptedFile(platform, accountName, fileName, plainText) {
    const file = encryptedFilePath(platform, accountName, fileName);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, encryptString(plainText), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    return file;
}

function readEncryptedFile(platform, accountName, fileName) {
    const file = encryptedFilePath(platform, accountName, fileName);
    if (!fs.existsSync(file)) return null;
    return decryptString(fs.readFileSync(file, 'utf8'));
}

function deleteEncryptedFile(platform, accountName, fileName) {
    const file = encryptedFilePath(platform, accountName, fileName);
    try { fs.unlinkSync(file); } catch (_) {}
}

function hasEncryptedFile(platform, accountName, fileName) {
    return fs.existsSync(encryptedFilePath(platform, accountName, fileName));
}

module.exports = {
    SESSION_ROOT,
    encryptString,
    decryptString,
    sessionDir,
    encryptedFilePath,
    writeEncryptedFile,
    readEncryptedFile,
    deleteEncryptedFile,
    hasEncryptedFile
};
