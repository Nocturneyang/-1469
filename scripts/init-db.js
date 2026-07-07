const { DEFAULT_AUTH_DB_PATH, openAuthDb } = require('../db/auth-db');
const { DEFAULT_RAW_DB_PATH, ensureRawDb } = require('../db/raw-db');
const { DEFAULT_RUNTIME_DB_PATH, openRuntimeDb } = require('../db/runtime-db');
const { DEFAULT_WORKBENCH_DB_PATH, openWorkbenchDb } = require('../db/workbench-db');

const authDb = openAuthDb(DEFAULT_AUTH_DB_PATH);
authDb.close();

const rawDb = ensureRawDb(DEFAULT_RAW_DB_PATH);
rawDb.close();

const workbenchDb = openWorkbenchDb(DEFAULT_WORKBENCH_DB_PATH);
workbenchDb.close();

const runtimeDb = openRuntimeDb(DEFAULT_RUNTIME_DB_PATH);
runtimeDb.close();

console.log(`[workbench] initialized auth DB: ${DEFAULT_AUTH_DB_PATH}`);
console.log(`[workbench] initialized raw DB: ${DEFAULT_RAW_DB_PATH}`);
console.log(`[workbench] initialized workbench DB: ${DEFAULT_WORKBENCH_DB_PATH}`);
console.log(`[workbench] initialized runtime DB: ${DEFAULT_RUNTIME_DB_PATH}`);
