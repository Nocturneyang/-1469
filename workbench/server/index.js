const path = require('path');
const express = require('express');
const cors = require('cors');
const { DEFAULT_RAW_DB_PATH } = require('../db/raw-messages');
const { DEFAULT_WORKBENCH_DB_PATH, openWorkbenchDb } = require('../db/workbench-db');
const { createWorkbenchRouter } = require('./routes/workbench');

function createApp(options = {}) {
  const app = express();
  const workbenchDb = options.workbenchDb || openWorkbenchDb(options.workbenchDbPath || DEFAULT_WORKBENCH_DB_PATH);
  const rawDbPath = options.rawDbPath || DEFAULT_RAW_DB_PATH;
  const outboxDir = options.outboxDir || process.env.WORKBENCH_OUTBOX_DIR || path.join(__dirname, '..', 'outbox');

  app.locals.workbenchDb = workbenchDb;
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '18mb' }));
  app.use('/api/workbench', createWorkbenchRouter({ workbenchDb, rawDbPath, outboxDir }));

  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(distDir));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.WORKBENCH_PORT || process.env.PORT || 3310);
  const app = createApp();
  app.listen(port, () => {
    console.log(`[workbench] API/UI listening on http://localhost:${port}`);
    console.log(`[workbench] raw messages DB: ${process.env.RAW_MESSAGES_DB_PATH || DEFAULT_RAW_DB_PATH}`);
    console.log(`[workbench] workbench DB: ${process.env.WORKBENCH_DB_PATH || DEFAULT_WORKBENCH_DB_PATH}`);
  });
}

module.exports = {
  createApp,
};
