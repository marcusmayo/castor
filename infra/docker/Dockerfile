# check=skip=InvalidDefaultArgInFrom
# ^ MUST be line 1. BuildKit stops looking for parser directives after the first comment,
#   blank line or instruction, so an explanation placed above it silently disables it.
#   BASE_IMAGE is defaultless on purpose: the pin lives in infra/versions.lock and
#   build-image.sh passes it. A default here would be a second copy of that pin, and the
#   copy that drifts is the one nobody reads. The check is skipped; the discipline is not.
#
# Castor runtime image. Build via infra/scripts/build-image.sh (passes pins
# from infra/versions.lock). Image = code, immutable; state = volumes.
#
# Differs from Keel: three npm install locations (repo root, gate, webchat),
# and the runtime adds poppler-utils + tesseract-ocr + gzip that Castor's
# intake and log-rotate actually use. No Python pip deps (sunday-maintenance.py
# is stdlib-only).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG NODE_VERSION
ARG NODE_SHA256_X64
ARG NODE_SHA256_ARM64
ARG CLAUDE_CODE_VERSION
ARG TARGETARCH

# Runtime system deps. poppler-utils=pdftotext, tesseract-ocr=image OCR (both
# used by the intake extraction lane), gzip=log-rotate. xz-utils extracts the
# Node tarball.
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils python3 poppler-utils tesseract-ocr gzip \
    && rm -rf /var/lib/apt/lists/*

# Node: official tarball, SHA256-verified against versions.lock (fail-loud).
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) A=x64;   H="${NODE_SHA256_X64}";; \
      arm64) A=arm64; H="${NODE_SHA256_ARM64}";; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1;; \
    esac; \
    T="node-v${NODE_VERSION}-linux-${A}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${T}"; \
    echo "${H}  ${T}" | sha256sum -c -; \
    tar -xJf "${T}" -C /usr/local --strip-components=1; rm "${T}"

# claude CLI: exact version; npm enforces registry sha512 integrity.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

RUN useradd -m -u 10001 castor
WORKDIR /app

# Node deps from lockfiles only, in all three locations Castor resolves from.
# Scaffold root: intake/register/model-routing/notify deps (xlsx, mammoth,
# mailparser, msgreader, js-yaml). gate: compromise. webchat: express/ws/etc.
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev
COPY gate/package.json gate/package-lock.json /app/gate/
RUN cd /app/gate && npm ci --omit=dev
COPY webchat/package.json webchat/package-lock.json /app/webchat/
RUN cd /app/webchat && npm ci --omit=dev

# Code whitelist — code only, no state/knowledge data.
COPY gate/ /app/gate/

# Fleet-core drift gate (gate/): vendored gate modules must byte-match agent-fleet-iac/core/gate.
RUN bash /app/gate/verify-core.sh /app/gate
COPY scripts/ /app/scripts/

# Fleet-core drift gate: vendored shared module must byte-match agent-fleet-iac/core.
RUN bash /app/scripts/verify-core.sh /app/scripts
COPY .claude/ /app/.claude/
COPY webchat/ /app/webchat/
COPY system/ /app/system/
COPY CLAUDE.md MEMORY.md /app/
COPY crontab.template /app/

# Tripwire config: ship the example so the gate does not fail closed on a fresh
# container. bootstrap.sh replaces it with the real per-engagement config.
RUN cp /app/gate/never-egress.example.json /app/gate/never-egress.json

# Test harness (fixture tests for the intake/skill lanes; run via docker exec).
COPY tests/ /app/tests/

# Acceptance oracle + demo reset (run via docker exec). Copied before the chown
# below so they land owned by castor with their +x bit from git preserved.
COPY run_e2e.sh clean_demo.sh /app/

# Runtime state mount points, writable by castor whether or not volumes mount.
# These stay EMPTY in the image (generic twin) — data arrives at runtime.
# Toolset gate: every tools/*.py the image carries must be named in system/toolset.yaml, and
# every name there must exist. A skill can name a tool the image does not contain, and today that
# fails at invocation, to whoever invoked it. This moves the failure to the build.
RUN node /app/scripts/toolset.js /app --check

# Build provenance: the commit this image was built from, supplied by infra/scripts/build-image.sh.
# A FILE, not an ENV -- `environment:` in compose overrides env_file and overrides a Dockerfile ENV
# the same way, so a container could be made to misreport what it is running. system/ carries no
# mount, so a volume cannot mask it either. Placed here so the chown below covers it, and this late
# so a new commit invalidates only the last few cheap layers.
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision="${SOURCE_COMMIT}"
RUN printf '%s\n' "${SOURCE_COMMIT}" > /app/system/build-commit

RUN mkdir -p /app/state /app/knowledge /app/logs /app/inbox/drop \
      /app/inbox/archive /app/inbox/quarantine /app/state/pipeline \
      /app/state/draft-queue /app/state/weekly-reports /app/knowledge/people \
      /home/castor/.claude \
    && chown -R castor:castor /app /home/castor/.claude

USER castor
# NODE_PATH so vendored scripts/ modules resolve the webchat deps (js-yaml, express) the same
# way keel's image does. Compose sets it too; keel set it in both places and castor only in
# compose, so a bare docker run of this image behaved differently from keel's.
ENV NODE_PATH=/app/webchat/node_modules
ENV NODE_ENV=production PYTHONUNBUFFERED=1 AGENT_ROOT=/app
EXPOSE 8443
# Liveness on the intake/webchat health endpoint (200 only), not docker status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:8443/health/liveliness >/dev/null || exit 1
CMD ["node", "webchat/server.js"]
