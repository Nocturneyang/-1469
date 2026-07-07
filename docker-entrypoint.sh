#!/bin/sh
set -eu

export DATA_DIR="${DATA_DIR:-/data}"
export WORKBENCH_DB_DIR="${WORKBENCH_DB_DIR:-$DATA_DIR/db}"
export WORKBENCH_AUTH_DB_PATH="${WORKBENCH_AUTH_DB_PATH:-$WORKBENCH_DB_DIR/auth.sqlite}"
export WORKBENCH_RAW_DB_PATH="${WORKBENCH_RAW_DB_PATH:-$WORKBENCH_DB_DIR/raw.sqlite}"
export WORKBENCH_DB_PATH="${WORKBENCH_DB_PATH:-$WORKBENCH_DB_DIR/workbench.sqlite}"
export WORKBENCH_RUNTIME_DB_PATH="${WORKBENCH_RUNTIME_DB_PATH:-$WORKBENCH_DB_DIR/runtime.sqlite}"
export WORKBENCH_OUTBOX_DIR="${WORKBENCH_OUTBOX_DIR:-$DATA_DIR/outbox}"

mkdir -p "$WORKBENCH_DB_DIR" "$WORKBENCH_OUTBOX_DIR" "$DATA_DIR/sessions/wa" "$DATA_DIR/sessions/tg"

node scripts/init-db.js

exec pm2-runtime start ecosystem.cloud.config.js
