# Read-only review target for governed project workspaces.
#
# Match the WSL/Ubuntu host's glibc userspace so host-installed npm optional
# native dependencies remain usable through a read-only bind. Node/npm/npx,
# git, bash and python3 are baked in at build time; no runtime package install
# is required for normal review and test execution.
#
# No secrets, no credentials, no build context beyond this file.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Keep the container alive; the bridge drives it via docker exec.
CMD ["sh", "-c", "while true; do sleep 3600; done"]
