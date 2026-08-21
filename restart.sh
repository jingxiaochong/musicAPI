#!/usr/bin/env bash
set -Eeuo pipefail

readonly PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${PROJECT_DIR}"

command -v pm2 >/dev/null 2>&1 || {
  echo "未找到 pm2，请先执行：npm install -g pm2" >&2
  exit 1
}

pm2 restart musicAPI --update-env
pm2 save
pm2 status musicAPI
