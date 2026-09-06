# Work-target base image for QuaranGate-authorized writable project targets.
#
# The host development environment is WSL/Ubuntu, so use a Debian/glibc Node
# image to match host-installed npm native dependencies. This also bakes the
# Node/npm/npx toolchain into the writable MCP target instead of requiring
# privileged runtime package installation.
#
# Runtime Compose still forces uid/gid 1000 and drops all capabilities. The
# Node image's built-in uid/gid 1000 identity therefore writes host-mounted
# project files through ordinary owner permissions, not elevated privilege.
#
# No secrets, no credentials, no build context beyond this file.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV HOME=/home/node
WORKDIR /workspace
USER node

# Keep the container alive; the bridge drives it via docker exec.
CMD ["sh", "-c", "while true; do sleep 3600; done"]
