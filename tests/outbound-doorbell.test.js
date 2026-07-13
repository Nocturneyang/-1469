'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openWorkbenchDb } = require('../db/workbench-db');
const {
  clearResolvedOutboundDoorbells,
  createOutboundDoorbellWatcher,
  outboundDoorbellDir,
} = require('../lib/outbound-doorbell');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-outbound-doorbell-'));
  const db = openWorkbenchDb(path.join(tmpDir, 'workbench.sqlite'));
  const directory = outboundDoorbellDir(path.join(tmpDir, 'outbox'), 'wa', 'wa-test');
  fs.mkdirSync(directory, { recursive: true });
  let wakeCount = 0;
  let watchCallback = null;
  const fakeWatcher = { on() {}, close() {} };
  const watcher = createOutboundDoorbellWatcher({
    directory,
    onWake: () => { wakeCount += 1; },
    fsModule: {
      mkdirSync: fs.mkdirSync,
      watch(_directory, _options, callback) {
        watchCallback = callback;
        return fakeWatcher;
      },
    },
  });
  try {
    db.prepare(`
      INSERT OR IGNORE INTO operators (id, username, display_name)
      VALUES ('operator-1', 'operator-1', '坐席')
    `).run();
    const pending = db.prepare(`
      INSERT INTO outbound_messages (client_msg_id, platform, account, group_id, text, status, created_by)
      VALUES ('pending-1', 'wa', 'wa-test', 'group-1', 'hello', 'pending', 'operator-1')
    `).run().lastInsertRowid;
    const sent = db.prepare(`
      INSERT INTO outbound_messages (client_msg_id, platform, account, group_id, text, status, created_by)
      VALUES ('sent-1', 'wa', 'wa-test', 'group-1', 'done', 'sent', 'operator-1')
    `).run().lastInsertRowid;
    fs.writeFileSync(path.join(directory, `${pending}.json`), '{}');
    fs.writeFileSync(path.join(directory, `${sent}.json`), '{}');
    watchCallback('rename', `${pending}.json`);
    assert.ok(wakeCount > 0, 'doorbell file must wake the account worker');
    assert.strictEqual(clearResolvedOutboundDoorbells({ directory, db }), 1);
    assert.ok(fs.existsSync(path.join(directory, `${pending}.json`)));
    assert.ok(!fs.existsSync(path.join(directory, `${sent}.json`)));
  } finally {
    watcher.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
