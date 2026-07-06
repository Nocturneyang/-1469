#!/bin/bash
set -e

export DATA_DIR="${DATA_DIR:-/data}"
APP_DIR="/app/social-monitor"
CLOUD_ECOSYSTEM_VERSION="${CLOUD_ECOSYSTEM_VERSION:-21}"

mkdir -p "$DATA_DIR/db" "$DATA_DIR/media" "$DATA_DIR/config"

if [ "${PURGE_MEDIA_ON_START:-}" = "1" ] || [ "${PURGE_MEDIA_ON_START:-}" = "true" ]; then
  echo "PURGE_MEDIA_ON_START enabled; deleting files under $DATA_DIR/media"
  find "$DATA_DIR/media" -type f -delete || true
  find "$DATA_DIR/media" -mindepth 1 -type d -empty -delete || true
fi

for file in account-regions.json webhooks.json internal-staff.json; do
  if [ -f "$APP_DIR/config/$file" ] && [ ! -f "$DATA_DIR/config/$file" ]; then
    cp "$APP_DIR/config/$file" "$DATA_DIR/config/$file"
  fi
done

if [ ! -f "$DATA_DIR/.env" ]; then
  touch "$DATA_DIR/.env"
fi

if [ "${ENSURE_RUNTIME_SECRETS:-1}" != "0" ] && [ -f "$APP_DIR/scripts/ensure-runtime-secrets.js" ]; then
  node "$APP_DIR/scripts/ensure-runtime-secrets.js" || true
fi

if [ -n "${COLLECTOR_PLATFORM:-}" ]; then
  cd "$APP_DIR"
  case "$COLLECTOR_PLATFORM" in
    whatsapp)
      exec node scripts/start-wa-collector.js
      ;;
    telegram-bot)
      export TG_COLLECTOR_TYPE=bot
      exec node scripts/start-tg-collector.js
      ;;
    telegram-user)
      export TG_COLLECTOR_TYPE=user
      exec node scripts/start-tg-collector.js
      ;;
    teams-graph)
      exec node workers/worker-teams-graph.js
      ;;
    *)
      echo "Unsupported COLLECTOR_PLATFORM: $COLLECTOR_PLATFORM" >&2
      exit 1
      ;;
  esac
fi

if [ -n "${TG_ACCOUNT_NAME:-}" ]; then
  cd "$APP_DIR"
  exec node scripts/start-tg-collector.js
fi

if [ -n "${ACCOUNT_NAME:-}" ]; then
  cd "$APP_DIR"
  exec node scripts/start-wa-collector.js
fi

CURRENT_CLOUD_ECOSYSTEM_VERSION=""
if [ -f "$DATA_DIR/.cloud-ecosystem-version" ]; then
  CURRENT_CLOUD_ECOSYSTEM_VERSION="$(cat "$DATA_DIR/.cloud-ecosystem-version" 2>/dev/null || true)"
fi

if [ -f "$APP_DIR/ecosystem.cloud.config.js" ] && [ "$CURRENT_CLOUD_ECOSYSTEM_VERSION" != "$CLOUD_ECOSYSTEM_VERSION" ]; then
  if [ -f "$DATA_DIR/ecosystem.config.js" ]; then
    cp "$DATA_DIR/ecosystem.config.js" "$DATA_DIR/ecosystem.config.js.bak.$(date +%Y%m%d%H%M%S)"
  fi
  cp "$APP_DIR/ecosystem.cloud.config.js" "$DATA_DIR/ecosystem.config.js"
  echo "$CLOUD_ECOSYSTEM_VERSION" > "$DATA_DIR/.cloud-ecosystem-version"
elif [ ! -f "$DATA_DIR/ecosystem.config.js" ]; then
  if [ -f "$APP_DIR/ecosystem.cloud.config.js" ]; then
    cp "$APP_DIR/ecosystem.cloud.config.js" "$DATA_DIR/ecosystem.config.js"
    echo "$CLOUD_ECOSYSTEM_VERSION" > "$DATA_DIR/.cloud-ecosystem-version"
  else
    cp "$APP_DIR/ecosystem.config.js" "$DATA_DIR/ecosystem.config.js"
  fi
fi

rm -f "$APP_DIR/.env" "$APP_DIR/ecosystem.config.js"
ln -s "$DATA_DIR/.env" "$APP_DIR/.env"
ln -s "$DATA_DIR/ecosystem.config.js" "$APP_DIR/ecosystem.config.js"

cd "$APP_DIR"
if [ "${SQLITE_RECOVERY_ON_START:-}" = "1" ] || [ "${SQLITE_RECOVERY_ON_START:-}" = "true" ]; then
  RECOVERY_ENV="/tmp/social-monitor-recovery.env"
  rm -f "$RECOVERY_ENV"
  echo "SQLITE_RECOVERY_ON_START enabled; checking SQLite health and latest valid backups"
  if ! node scripts/restore-sqlite-from-backup.js --recovery-env-file "$RECOVERY_ENV"; then
    echo "SQLite recovery did not fully complete; maintenance mode will remain enabled where needed"
    export DB_MAINTENANCE_MODE=1
    export ANALYTICS_MAINTENANCE_MODE=1
  fi
  if [ -f "$RECOVERY_ENV" ]; then
    # shellcheck disable=SC1090
    . "$RECOVERY_ENV"
  fi
fi

if [ ! -f "$DATA_DIR/db/analytics.sqlite" ]; then
  if [ "${ANALYTICS_MAINTENANCE_MODE:-}" = "1" ] || [ "${ANALYTICS_MAINTENANCE_MODE:-}" = "true" ]; then
    echo "analytics.sqlite missing but analytics maintenance mode is enabled; skip startup schema init"
  else
    node scripts/init-analytics-db.js
  fi
else
  echo "analytics.sqlite exists, skip startup schema init; run scripts/init-analytics-db.js manually after DB health is restored"
fi

if [ "${SQLITE_STARTUP_CONFIGURE:-1}" != "0" ]; then
  node scripts/configure-sqlite-storage.js
fi

exec pm2-runtime start ecosystem.config.js
