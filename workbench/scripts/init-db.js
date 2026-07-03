const { DEFAULT_WORKBENCH_DB_PATH, openWorkbenchDb } = require('../db/workbench-db');

const dbPath = process.env.WORKBENCH_DB_PATH || DEFAULT_WORKBENCH_DB_PATH;
const db = openWorkbenchDb(dbPath);
db.close();

console.log(`[workbench] initialized ${dbPath}`);
