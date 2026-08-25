#!/bin/sh
set -eu

APP_DIR="/home/container/brixhub"
REPO="https://github.com/Noxo123/brixhub.git"

if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "$APP_DIR"
  git clone "$REPO" "$APP_DIR"
else
  git -C "$APP_DIR" fetch --depth=1 origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

cd "$APP_DIR"

if [ -z "${BRIXHUB_API_KEY:-}" ]; then
  echo "ERROR: BRIXHUB_API_KEY is not configured in Pterodactyl."
  exit 1
fi

npm install --omit=dev
npm run build
exec npm start
