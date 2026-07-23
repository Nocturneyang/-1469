'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openRuntimeDb } = require('../db/runtime-db');
const {
  createNativeMessageDeduper,
  nextHistoryFetchLimit,
  historySyncOutcome,
} = require('../lib/wa-history-reconciliation');

async function main() {
  let now = 1000;
  const deduper = createNativeMessageDeduper({ ttlMs: 100, maxEntries: 3, now: () => now });
  let calls = 0;
  const first = deduper.run('native-message-1', async () => {
    calls += 1;
    return 'stored';
  });
  const second = deduper.run('native-message-1', async () => {
    calls += 1;
    return 'duplicate';
  });
  assert.strictEqual(await first, 'stored');
  assert.strictEqual(await second, 'stored');
  assert.strictEqual(calls, 1, 'message_create and message must share one persistence operation');
  assert.strictEqual(await deduper.run('native-message-1', async () => {
    calls += 1;
    return 'too-soon';
  }), 'stored');
  assert.strictEqual(calls, 1);
  now += 101;
  assert.strictEqual(await deduper.run('native-message-1', async () => {
    calls += 1;
    return 'resync';
  }), 'resync');
  assert.strictEqual(calls, 2);

  assert.strictEqual(nextHistoryFetchLimit(null, { batchSize: 100, maxMessages: 300 }), 100);
  assert.strictEqual(nextHistoryFetchLimit({ loaded_limit: 100 }, { batchSize: 100, maxMessages: 300 }), 200);
  assert.strictEqual(nextHistoryFetchLimit({ loaded_limit: 300 }, { batchSize: 100, maxMessages: 300 }), null);
  assert.strictEqual(nextHistoryFetchLimit({ completed: 1 }, { batchSize: 100, maxMessages: 300 }), null);
  assert.deepStrictEqual(historySyncOutcome({ requestedLimit: 100, receivedCount: 42, maxMessages: 300 }), {
    loaded_limit: 100, completed: true, capped: false,
  });
  assert.deepStrictEqual(historySyncOutcome({ requestedLimit: 300, receivedCount: 300, maxMessages: 300 }), {
    loaded_limit: 300, completed: true, capped: true,
  });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-wa-history-state-'));
  const db = openRuntimeDb(path.join(tempDir, 'runtime.sqlite'));
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(wa_history_sync_state)').all().map((column) => column.name));
    for (const column of ['group_id', 'loaded_limit', 'completed', 'capped', 'last_success_at', 'last_error']) {
      assert.ok(columns.has(column), `history sync state is missing ${column}`);
    }
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
