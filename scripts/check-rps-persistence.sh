#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${1:-palbot}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_STATS_FILE="${ROOT_DIR}/data/rps-stats.json"

echo "[check] container: ${CONTAINER_NAME}"

if ! docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  echo "[check] container not found: ${CONTAINER_NAME}"
  exit 1
fi

echo "[check] mounts"
docker inspect "${CONTAINER_NAME}" --format '{{json .Mounts}}'

echo "[check] RPS env"
docker inspect "${CONTAINER_NAME}" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^RPS_STATS_PATH=' || true
docker inspect "${CONTAINER_NAME}" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^RPS_PERSIST_LOG_INTERVAL=' || true

echo "[check] host data file: ${HOST_STATS_FILE}"
if [[ -f "${HOST_STATS_FILE}" ]]; then
  ls -l "${HOST_STATS_FILE}"
  echo "[check] preview (first 40 lines)"
  sed -n '1,40p' "${HOST_STATS_FILE}"
else
  echo "[check] host stats file does not exist"
fi

echo "[check] in-container stats file"
RPS_PATH="$(docker inspect "${CONTAINER_NAME}" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^RPS_STATS_PATH=' | head -n 1 | cut -d= -f2-)"
if [[ -z "${RPS_PATH}" ]]; then
  RPS_PATH="/app/data/rps-stats.json"
fi
docker exec "${CONTAINER_NAME}" sh -lc "ls -l '${RPS_PATH}' 2>/dev/null || true; sed -n '1,40p' '${RPS_PATH}' 2>/dev/null || true"

echo "[check] done"
