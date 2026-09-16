# Read-only review target for the QuaranGate repository.
#
# Use the Debian/glibc Node image deliberately. The host development tree is
# WSL/Ubuntu and its npm optional native dependencies are therefore glibc
# builds (for example Rollup's linux-x64-gnu package). Matching libc lets the
# read-only target reuse the host node_modules tree without reinstalling or
# writing package artifacts into the reviewed workspace.
#
# Node/npm/npx, git, bash and python3 are baked in at build time so normal
# review/test work needs no runtime package installation.
#
# No secrets, no credentials, no build context beyond this file.
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Keep the container alive; the bridge drives it via docker exec.
CMD ["sh", "-c", "while true; do sleep 3600; done"]
