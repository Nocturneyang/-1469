'use strict';

const fs = require('fs');
const path = require('path');

const { sanitizeAccountSegment } = require('../db/account-db');

function outboundDoorbellDir(outboxDir, platform, account) {
  return path.join(path.resolve(outboxDir), `worker-${platform}-${sanitizeAccountSegment(account)}`);
}

function createOutboundDoorbellWatcher({ directory, onWake, onError = () => {}, fsModule = fs } = {}) {
  if (!directory) throw new Error('directory is required');
  if (typeof onWake !== 'function') throw new Error('onWake is required');
  fsModule.mkdirSync(directory, { recursive: true });
  const watcher = fsModule.watch(directory, { persistent: false }, (eventType, filename) => {
    const name = String(filename || '');
    if (name && !name.endsWith('.json')) return;
    onWake({ eventType, filename: name });
  });
  watcher.on('error', onError);
  return watcher;
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

module.exports = {
  clearResolvedOutboundDoorbells,
  createOutboundDoorbellWatcher,
  outboundDoorbellDir,
};
