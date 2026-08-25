#!/bin/sh
set -eu

APP_DIR="/home/container/brixhub"
REPO="${REPO_URL:-https://github.com/Noxo123/brixhub.git}"
BRANCH="${BRANCH:-main}"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[BrixHub] Cloning $BRANCH..."
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
else
  echo "[BrixHub] Syncing latest commit..."
  git -C "$APP_DIR" fetch --depth=1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  git -C "$APP_DIR" clean -fd
fi

cd "$APP_DIR"

if [ -z "${BRIXHUB_API_KEY:-}" ]; then
  echo "ERROR: BRIXHUB_API_KEY is not configured in Pterodactyl."
  exit 1
fi

# server.js serves both the API and public/index.html.
exec node server.js
