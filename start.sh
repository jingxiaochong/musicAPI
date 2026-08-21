#!/usr/bin/env bash
set -Eeuo pipefail

readonly PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${PROJECT_DIR}"

command -v pm2 >/dev/null 2>&1 || {
  echo "未找到 pm2，请先执行：npm install -g pm2" >&2
  exit 1
}

mkdir -p log

if pm2 describe musicAPI >/dev/null 2>&1; then
  pm2 restart musicAPI --update-env
else
  pm2 start ecosystem.config.cjs --only musicAPI
fi

pm2 save
pm2 status musicAPI
