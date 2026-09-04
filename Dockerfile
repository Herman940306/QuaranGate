# Single image, two entrypoints (gateway / executor) selected by compose command.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

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
