# syntax=docker/dockerfile:1.7
#
# AgentHorizon images (build context: the agenthorizon/ directory).
#   app    API + built UI, and the trusted worker (ingest, index, materialize, score, export). No harnesses, no
#          provider credentials.
#   judge  app + Node 22 + the five harness CLIs at the exact versions verified against their --help output
#          (evidence/harness_cli/): Claude Code 2.1.295, Codex 0.162.1, Gemini CLI 0.63.0, OpenCode 1.18.35,
#          OpenHands 1.16.0. Runs the judge worker; each attempt runs in a per-task namespace sandbox.
#   test   the judge base + PostgreSQL 16 + the dev dependency group + tests/, to run the suite inside the image.
#
# Behind a TLS-intercepting proxy, pass its CA bundle as a build secret (it never lands in an image layer) and
# the proxy as a build arg, e.g.:
#   docker build --network host --secret id=build_ca,src=/path/ca.pem --build-arg HTTPS_PROXY=http://... \
#                -f docker/Dockerfile --target judge .
#
# Ubuntu 24.04 is used because OpenHands 1.16.0 requires Python 3.12 exactly and the harness CLIs were verified on
# it; the app runs on the same system interpreter (/usr/bin/python3.12), which lives under /usr and is therefore
# visible read-only inside the judge sandbox.

ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

# ---------------------------------------------------------------------------------------------------------------
FROM ${UBUNTU_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 python3.12 util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 ah \
 && useradd --uid 10001 --gid ah --home-dir /home/ah --create-home --shell /usr/sbin/nologin ah

# --- uv from its PyPI wheel, hash-pinned ------------------------------------------------------------------------
FROM base AS uv
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/*
COPY docker/requirements-uv.txt /tmp/requirements-uv.txt
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; if [ -s /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip download --no-deps --only-binary=:all: --require-hashes -r /tmp/requirements-uv.txt -d /tmp/uv; \
    python3 -m zipfile -e /tmp/uv/uv-*.whl /tmp/uvx; \
    install -m 0755 /tmp/uvx/uv-*.data/scripts/uv /usr/local/bin/uv; \
    uv --version

# --- Node.js 22 from nodejs.org, checksum-pinned, at /opt/node22 (the path the harness adapters expect) ----------
FROM base AS node
ARG NODE_VERSION=22.22.0
ARG NODE_SHA256_AMD64=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37
ARG NODE_SHA256_ARM64=1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; if [ -s /run/secrets/build_ca ]; then export CURL_CA_BUNDLE=/run/secrets/build_ca; fi; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; sum="$NODE_SHA256_AMD64" ;; \
      arm64) arch=arm64; sum="$NODE_SHA256_ARM64" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
    echo "${sum}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node22; \
    tar -xJf /tmp/node.tar.xz -C /opt/node22 --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    /opt/node22/bin/node --version

# --- frontend build ---------------------------------------------------------------------------------------------
FROM node AS frontend
ENV PATH=/opt/node22/bin:$PATH PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- harness CLIs (exact versions; npm lockfile with integrity hashes; OpenHands with its frozen dependency set) --
FROM node AS harnesses
COPY --from=uv /usr/local/bin/uv /usr/local/bin/uv
ENV PATH=/opt/node22/bin:$PATH
WORKDIR /app/var/tools/npm
COPY docker/harnesses/package.json docker/harnesses/package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund; \
    npm cache clean --force
COPY docker/harnesses/openhands-constraints.txt /tmp/openhands-constraints.txt
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    UV_TOOL_DIR=/app/var/tools/uv/tools UV_TOOL_BIN_DIR=/app/var/tools/uv/bin UV_PYTHON_DOWNLOADS=never \
    UV_CACHE_DIR=/tmp/uv-cache uv tool install --python /usr/bin/python3.12 \
        --constraints /tmp/openhands-constraints.txt openhands==1.16.0; \
    rm -rf /tmp/uv-cache

# --- Python environment (uv.lock, frozen) -------------------------------------------------------------------------
FROM base AS pydeps
COPY --from=uv /usr/local/bin/uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON=/usr/bin/python3.12 UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy UV_CACHE_DIR=/tmp/uv-cache
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --no-install-project --extra anthropic --extra gemini
COPY src/ ./src/
# editable install: the package resolves PROJECT_ROOT=/app (frontend/dist, evidence/, var/tools)
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --no-dev --extra anthropic --extra gemini; \
    rm -rf /tmp/uv-cache

# --- Python environment with the dev group (test image only) --------------------------------------------------------
FROM pydeps AS pydeps-dev
RUN --mount=type=secret,id=build_ca,required=false \
    set -eu; if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    uv sync --frozen --extra anthropic --extra gemini; \
    rm -rf /tmp/uv-cache

# --- runtime bases: the large, rarely changing layers first, so a code change never re-copies them ---------------
FROM base AS judge-base
COPY --from=node /opt/node22 /opt/node22
COPY --from=harnesses /app/var/tools /app/var/tools
# Fail the build unless every harness starts and reports the pinned version.
RUN set -eu; cd /tmp; export HOME=/tmp/h PATH=/opt/node22/bin:$PATH; mkdir -p "$HOME"; \
    t=/app/var/tools; \
    "$t/npm/node_modules/.bin/claude" --version | grep -q '^2\.1\.295'; \
    "$t/npm/node_modules/.bin/codex" --version | grep -q '0\.162\.1'; \
    "$t/npm/node_modules/.bin/gemini" --version | grep -q '0\.63\.0'; \
    "$t/npm/node_modules/.bin/opencode" --version | grep -q '1\.18\.35'; \
    OPENHANDS_SUPPRESS_BANNER=1 "$t/uv/bin/openhands" --version 2>&1 | grep -q '1\.16\.0'; \
    rm -rf "$HOME"

FROM judge-base AS test-base
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-16 && rm -rf /var/lib/apt/lists/*

# --- service images ------------------------------------------------------------------------------------------------
# The same application layer (venv, source, evidence, built UI, /data mount points) goes on each base.
FROM base AS app
ARG AH_BUILD_GIT_COMMIT=""
ENV PATH=/opt/venv/bin:$PATH VIRTUAL_ENV=/opt/venv AH_MODE=hosted AH_VAR_DIR=/data \
    AH_BUILD_GIT_COMMIT=${AH_BUILD_GIT_COMMIT}
WORKDIR /app
COPY --from=pydeps /opt/venv /opt/venv
COPY --from=pydeps /app /app
COPY evidence/ /app/evidence/
COPY --from=frontend /src/frontend/dist /app/frontend/dist
# Mount points owned by the service user, so fresh named volumes inherit that ownership. private/ is scorer-only.
RUN set -eu; for d in sources datasets media runs exports supplemental reports cache private imports; do \
      mkdir -p "/data/$d"; done; \
    chown -R ah:ah /data; chmod 0700 /data/private
USER ah
EXPOSE 8765
ENTRYPOINT ["agenthorizon"]
CMD ["api", "--host", "0.0.0.0", "--port", "8765"]

FROM judge-base AS judge
ARG AH_BUILD_GIT_COMMIT=""
ENV PATH=/opt/venv/bin:/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    VIRTUAL_ENV=/opt/venv AH_MODE=hosted AH_VAR_DIR=/data AH_BUILD_GIT_COMMIT=${AH_BUILD_GIT_COMMIT}
WORKDIR /app
COPY --from=pydeps /opt/venv /opt/venv
COPY --from=pydeps /app /app
COPY evidence/ /app/evidence/
COPY --from=frontend /src/frontend/dist /app/frontend/dist
RUN set -eu; for d in sources datasets media runs exports supplemental reports cache private imports; do \
      mkdir -p "/data/$d"; done; \
    chown -R ah:ah /data; chmod 0700 /data/private
USER ah
ENTRYPOINT ["agenthorizon"]
CMD ["worker", "--queue", "judge"]

FROM test-base AS test
ARG AH_BUILD_GIT_COMMIT=""
ENV PATH=/opt/venv/bin:/opt/node22/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    VIRTUAL_ENV=/opt/venv AH_MODE=hosted AH_VAR_DIR=/data AH_BUILD_GIT_COMMIT=${AH_BUILD_GIT_COMMIT} \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*
WORKDIR /app
COPY --from=pydeps-dev /opt/venv /opt/venv
COPY --from=pydeps-dev /app /app
COPY evidence/ /app/evidence/
COPY tests/ /app/tests/
RUN set -eu; for d in sources datasets media runs exports supplemental reports cache private imports; do \
      mkdir -p "/data/$d"; done; \
    chown -R ah:ah /data; chmod 0700 /data/private
USER ah
CMD ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"]
