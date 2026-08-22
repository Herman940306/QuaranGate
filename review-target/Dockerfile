# Read-only review target for the QuaranGate repository.
#
# Derived from node:24-alpine to preserve the Node/npm toolchain already
# present in that image (used for npm ci, type-check, test runs against
# the workspace). git and python3 are baked in at build time so the
# container needs no network access or package manager at runtime.
#
# No secrets, no credentials, no build context beyond this file.
FROM node:24-alpine

RUN apk add --no-cache git python3

WORKDIR /workspace

# Keep the container alive; the bridge drives it via docker exec.
CMD ["sh", "-c", "while true; do sleep 3600; done"]
