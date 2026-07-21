'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

async function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-share-preview-'));
  const app = createApp({
    authDbPath: path.join(dataDir, 'auth.sqlite'),
    rawDbPath: path.join(dataDir, 'raw.sqlite'),
    workbenchDbPath: path.join(dataDir, 'workbench.sqlite'),
    runtimeDbPath: path.join(dataDir, 'runtime.sqlite'),
    outboxDir: path.join(dataDir, 'outbox'),
  });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const headers = { 'x-forwarded-host': 'social-workbench.tyhark.com', 'x-forwarded-proto': 'https' };
    const page = await request(port, '/', headers);
    assert.strictEqual(page.status, 200);
    const html = page.body.toString('utf8');
    assert.ok(html.includes('property="og:image" content="https://social-workbench.tyhark.com/share-preview.png"'));
    assert.ok(html.includes('property="og:url" content="https://social-workbench.tyhark.com/"'));

    const image = await request(port, '/share-preview.png');
    assert.strictEqual(image.status, 200);
    assert.match(String(image.headers['content-type']), /^image\/png/);
    assert.ok(image.body.length > 10_000, 'share image must be a non-trivial PNG asset');
    console.log('[share-preview] Open Graph image and absolute URLs verified');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const name of ['authDb', 'rawDb', 'workbenchDb', 'runtimeDb']) app.locals[name]?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
