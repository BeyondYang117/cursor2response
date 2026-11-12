ARG NODE_IMAGE=node:24-bookworm-slim
# JS output is architecture-independent; run TypeScript/Vite natively once.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN --mount=type=cache,id=cursor2response-npm,target=/root/.npm \
    npm ci --no-audit --no-fund --prefer-offline \
    --registry="$NPM_REGISTRY" --replace-registry-host=always \
    --fetch-retries=4 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=10000
COPY tsconfig.runtime.json tsconfig.json ./
COPY sidecar ./sidecar
COPY core ./core
COPY scripts/validate-api-fallback.ts scripts/validate-responses-phases.ts ./scripts/
COPY tools/trace-viewer ./tools/trace-viewer
RUN npm run build

# The SDK contains native binaries, so install production deps per target.
FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN --mount=type=cache,id=cursor2response-npm,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --prefer-offline \
    --registry="$NPM_REGISTRY" --replace-registry-host=always \
    --fetch-retries=4 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=10000 \
    && node -e 'require("node:fs").accessSync("node_modules/@cursor/sdk-linux-" + process.arch)'

FROM ${NODE_IMAGE} AS runtime
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|${APT_MIRROR%/}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/tools/trace-viewer/dist ./tools/trace-viewer/dist
COPY --from=build /app/dist/runtime ./dist/runtime
COPY --chown=node:node package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node bridge ./bridge
COPY --chown=node:node scripts/structured-log-runner.mjs ./scripts/structured-log-runner.mjs
COPY --chown=node:node tools/trace-viewer/*.mjs ./tools/trace-viewer/
RUN mkdir -p /workspace /home/node/.cursor /data/state /data/logs /data/traces \
    && chown -R node:node /workspace /home/node/.cursor /data
USER node
CMD ["node", "scripts/structured-log-runner.mjs", "bridge", "--", "node", "bridge/server.mjs"]
