#!/bin/sh
set -eu

export DATA_DIR="${DATA_DIR:-/data}"
export WORKBENCH_DB_DIR="${WORKBENCH_DB_DIR:-$DATA_DIR/db}"
export WORKBENCH_AUTH_DB_PATH="${WORKBENCH_AUTH_DB_PATH:-$WORKBENCH_DB_DIR/auth.sqlite}"
export WORKBENCH_RAW_DB_PATH="${WORKBENCH_RAW_DB_PATH:-$WORKBENCH_DB_DIR/raw.sqlite}"
export WORKBENCH_DB_PATH="${WORKBENCH_DB_PATH:-$WORKBENCH_DB_DIR/workbench.sqlite}"
export WORKBENCH_RUNTIME_DB_PATH="${WORKBENCH_RUNTIME_DB_PATH:-$WORKBENCH_DB_DIR/runtime.sqlite}"
export WORKBENCH_OUTBOX_DIR="${WORKBENCH_OUTBOX_DIR:-$DATA_DIR/outbox}"
export WORKBENCH_ACCOUNT_DB_MODE="${WORKBENCH_ACCOUNT_DB_MODE:-isolated}"
export WORKBENCH_ACCOUNT_DATA_DIR="${WORKBENCH_ACCOUNT_DATA_DIR:-$DATA_DIR/accounts}"
export WORKBENCH_CHROME_STATE_DIR="${WORKBENCH_CHROME_STATE_DIR:-/tmp/workbench-chrome}"
export WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB="${WORKBENCH_WA_CHROME_MIN_AVAILABLE_MB:-384}"
export WORKBENCH_WA_CHROME_PREFLIGHT="${WORKBENCH_WA_CHROME_PREFLIGHT:-1}"

unset DBUS_SESSION_BUS_ADDRESS DBUS_SYSTEM_BUS_ADDRESS

mkdir -p "$WORKBENCH_DB_DIR" "$WORKBENCH_OUTBOX_DIR" "$WORKBENCH_ACCOUNT_DATA_DIR" "$DATA_DIR/sessions/wa" "$DATA_DIR/sessions/tg" "$WORKBENCH_CHROME_STATE_DIR"
chmod 700 "$WORKBENCH_CHROME_STATE_DIR" 2>/dev/null || true

if command -v dbus-daemon >/dev/null 2>&1; then
  mkdir -p /run/dbus
  if command -v dbus-uuidgen >/dev/null 2>&1; then
    dbus-uuidgen --ensure=/etc/machine-id 2>/dev/null || true
  fi
  if [ ! -S /run/dbus/system_bus_socket ]; then
    dbus-daemon --system --fork --nopidfile 2>/dev/null || echo "[workbench] warning: failed to start system D-Bus"
  fi
  if [ -S /run/dbus/system_bus_socket ]; then
    export DBUS_SYSTEM_BUS_ADDRESS="unix:path=/run/dbus/system_bus_socket"
  fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [ "$DBUS_SESSION_BUS_ADDRESS" = "autolaunch:" ]; then
    SESSION_BUS_ADDRESS="$(dbus-daemon --session --fork --print-address=1 --nopidfile 2>/dev/null || true)"
    if [ -n "$SESSION_BUS_ADDRESS" ]; then
      export DBUS_SESSION_BUS_ADDRESS="$SESSION_BUS_ADDRESS"
    else
      echo "[workbench] warning: failed to start session D-Bus"
    fi
  fi
fi

node scripts/init-db.js

exec pm2-runtime start ecosystem.cloud.config.js
