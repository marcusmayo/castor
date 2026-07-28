#!/usr/bin/env bash
# Build the Castor image with every pin sourced from infra/versions.lock.
# Build context is the scaffold root (this script lives at infra/scripts/).
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source infra/versions.lock; set +a
# Tag from git if available; otherwise accept TAG=... or fall back to a date.
if TAG="$(git rev-parse --short HEAD 2>/dev/null)"; then :; else TAG="${TAG:-$(date -u +%Y%m%d%H%M)}"; fi
case "$(uname -m)" in
  x86_64) TARCH=amd64;;
  aarch64|arm64) TARCH=arm64;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1;;
esac
sudo docker build \
  --build-arg BASE_IMAGE="${UBUNTU_BASE_IMAGE}@${UBUNTU_BASE_DIGEST}" \
  --build-arg NODE_VERSION="${NODE_VERSION}" \
  --build-arg NODE_SHA256_X64="${NODE_SHA256_LINUX_X64}" \
  --build-arg NODE_SHA256_ARM64="${NODE_SHA256_LINUX_ARM64}" \
  --build-arg CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION}" \
  --build-arg TARGETARCH="${TARCH}" \
  -f infra/docker/Dockerfile \
  -t "castor:${TAG}" -t castor:latest .
echo "BUILT castor:${TAG}"
