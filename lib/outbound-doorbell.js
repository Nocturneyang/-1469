'use strict';

const fs = require('fs');
const path = require('path');

const { sanitizeAccountSegment } = require('../db/account-db');

function outboundDoorbellDir(outboxDir, platform, account) {
  return path.join(path.resolve(outboxDir), `worker-${platform}-${sanitizeAccountSegment(account)}`);
}

function channelActionDoorbellDir(outboxDir, platform, account) {
  return path.join(path.resolve(outboxDir), `action-worker-${platform}-${sanitizeAccountSegment(account)}`);
}

function createOutboundDoorbellWatcher({ directory, onWake, onError = () => {}, fsModule = fs } = {}) {
  if (!directory) throw new Error('directory is required');
  if (typeof onWake !== 'function') throw new Error('onWake is required');
  fsModule.mkdirSync(directory, { recursive: true });
  const watcher = fsModule.watch(directory, { persistent: false }, (eventType, filename) => {
    const name = String(filename || '');
    if (name && !name.endsWith('.json')) return;
    const event = { eventType, filename: name };
    if (name) {
      const payload = readOutboundDoorbell(directory, name, fsModule);
      if (payload.ok) {
        event.payload = payload.value;
      } else {
        event.error = payload.error;
      }
    }
    onWake(event);
  });
  watcher.on('error', onError);
  return watcher;
}

function readOutboundDoorbell(directory, filename, fsModule = fs) {
  try {
    const filePath = path.join(directory, filename);
    const payload = JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
    return { ok: true, value: payload && typeof payload === 'object' ? payload : null };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, value: null };
    return { ok: false, error: err };
  }
}

function clearResolvedOutboundDoorbells({ directory, db, fsModule = fs } = {}) {
  if (!directory || !db || !fsModule.existsSync(directory)) return 0;
  const selectStatus = db.prepare('SELECT status FROM outbound_messages WHERE id = ?');
  let removed = 0;
  for (const entry of fsModule.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(\d+)\.json$/.exec(entry.name);
    if (!match) continue;
    const row = selectStatus.get(Number(match[1]));
    if (row && row.status === 'pending') continue;
    try {
      fsModule.unlinkSync(path.join(directory, entry.name));
      removed += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

function clearResolvedChannelActionDoorbells({ directory, db, fsModule = fs } = {}) {
  if (!directory || !db || !fsModule.existsSync(directory)) return 0;
  const selectStatus = db.prepare('SELECT status FROM channel_action_tasks WHERE id = ?');
  let removed = 0;
  for (const entry of fsModule.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^(\d+)\.json$/.exec(entry.name);
    if (!match) continue;
    const row = selectStatus.get(Number(match[1]));
    if (row && ['pending', 'executing'].includes(row.status)) continue;
    try {
      fsModule.unlinkSync(path.join(directory, entry.name));
      removed += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

module.exports = {
  channelActionDoorbellDir,
  clearResolvedChannelActionDoorbells,
  clearResolvedOutboundDoorbells,
  createOutboundDoorbellWatcher,
  outboundDoorbellDir,
  readOutboundDoorbell,
};
