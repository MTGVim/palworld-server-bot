#!/bin/bash

set -euo pipefail

BUILD_COMMIT_AT=$(git log -1 --format=%cI 2>/dev/null || echo "unknown")
docker build \
  --build-arg BUILD_COMMIT_AT="${BUILD_COMMIT_AT}" \
  -t palworld-monitor:latest .
