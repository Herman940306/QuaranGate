# Single image, two entrypoints (gateway / executor) selected by compose command.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/npm-offline-bundle.mjs ./scripts/npm-offline-bundle.mjs
COPY build/npm-dependencies.json ./build/npm-dependencies.json
RUN --network=none \
    --mount=type=bind,from=npm_deps,source=.,target=/npm-deps,readonly \
    --mount=type=tmpfs,target=/tmp \
    set -eu; \
    npm_cache=/tmp/quarangate-npm-cache; \
    verified_tarballs=/tmp/quarangate-verified-tarballs; \
    export npm_config_audit=false npm_config_fund=false npm_config_ignore_scripts=true \
      npm_config_offline=true npm_config_update_notifier=false; \
    node scripts/npm-offline-bundle.mjs materialize \
      --bundle /npm-deps \
      --lockfile package-lock.json \
      --descriptor build/npm-dependencies.json \
      --destination "$verified_tarballs"; \
    mkdir -p "$npm_cache"; \
    for artifact in "$verified_tarballs"/sha512-*.tgz; do \
      npm cache add "$artifact" --cache="$npm_cache" --offline --ignore-scripts; \
    done; \
    npm ci --cache="$npm_cache" --offline --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN --network=none \
    --mount=type=tmpfs,target=/tmp \
    npm run build \
    && npm prune --omit=dev --offline --ignore-scripts --no-audit --no-fund \
      --cache=/tmp/quarangate-npm-prune-cache

FROM node:24-alpine AS runtime
# G4 build-time provenance. Supplied per build and never baked into source, so
# every production image records the exact commit it was built from:
#   docker build --build-arg GIT_REVISION="$(git rev-parse HEAD)" ...
ARG GIT_REVISION=unknown
ARG SOURCE_URL=https://github.com/Herman940306/QuaranGate
LABEL org.opencontainers.image.title="QuaranGate" \
      org.opencontainers.image.revision="${GIT_REVISION}" \
      org.opencontainers.image.source="${SOURCE_URL}"
WORKDIR /app
ENV NODE_ENV=production
# tini for correct signal handling / zombie reaping (vendored for offline builds)
COPY third_party/tini/0.19.0/tini /sbin/tini
RUN echo "1358f1be32dc2a0dd8084dbda675c3b3dde8352b519b7b8a65573262551ad0fc  /sbin/tini" \
      | sha256sum -c - \
    && chmod 0755 /sbin/tini \
    && mkdir -p /data /jobs \
    && chown node:node /data /jobs \
    && chmod 0700 /data /jobs
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/gateway/index.js"]
