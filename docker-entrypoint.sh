#!/bin/bash
set -e

export DATA_DIR="${DATA_DIR:-/data}"
APP_DIR="/app/social-monitor"

mkdir -p "$DATA_DIR/db" "$DATA_DIR/media" "$DATA_DIR/config"

for file in account-regions.json webhooks.json internal-staff.json; do
  if [ -f "$APP_DIR/config/$file" ] && [ ! -f "$DATA_DIR/config/$file" ]; then
    cp "$APP_DIR/config/$file" "$DATA_DIR/config/$file"
  fi
done

if [ ! -f "$DATA_DIR/.env" ]; then
  touch "$DATA_DIR/.env"
fi

if [ -f "$APP_DIR/ecosystem.cloud.config.js" ] && [ ! -f "$DATA_DIR/.cloud-ecosystem-version" ]; then
  if [ -f "$DATA_DIR/ecosystem.config.js" ]; then
    cp "$DATA_DIR/ecosystem.config.js" "$DATA_DIR/ecosystem.config.js.bak.$(date +%Y%m%d%H%M%S)"
  fi
  cp "$APP_DIR/ecosystem.cloud.config.js" "$DATA_DIR/ecosystem.config.js"
  echo "1" > "$DATA_DIR/.cloud-ecosystem-version"
elif [ ! -f "$DATA_DIR/ecosystem.config.js" ]; then
  if [ -f "$APP_DIR/ecosystem.cloud.config.js" ]; then
    cp "$APP_DIR/ecosystem.cloud.config.js" "$DATA_DIR/ecosystem.config.js"
    echo "1" > "$DATA_DIR/.cloud-ecosystem-version"
  else
    cp "$APP_DIR/ecosystem.config.js" "$DATA_DIR/ecosystem.config.js"
  fi
fi

rm -f "$APP_DIR/.env" "$APP_DIR/ecosystem.config.js"
ln -s "$DATA_DIR/.env" "$APP_DIR/.env"
ln -s "$DATA_DIR/ecosystem.config.js" "$APP_DIR/ecosystem.config.js"

cd "$APP_DIR"
node scripts/init-analytics-db.js

exec pm2-runtime start ecosystem.config.js
