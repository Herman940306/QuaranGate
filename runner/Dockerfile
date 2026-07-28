# A3 runner/stager sandbox image — trusted Executor-selected infrastructure.
#
# This image is NOT the executor image and NOT a caller-selectable image. It is
# used for two trusted, tightly confined roles in the A3 runner sandbox:
#   * the staging helper (needs `git` to produce a tracked-committed snapshot of
#     a trusted source project via `git archive HEAD`);
#   * the deterministic sandbox probe runner (needs `node` + `sh`).
#
# Design notes:
#   * pinned to the same base as the bridge image policy (node:24-alpine) so the
#     `node` user is uid/gid 1000 and node/sh are present;
#   * the ONLY added package is git (minimal; required for tracked-only staging);
#   * /workspace is pre-created owned by node(1000) so that a FRESH empty Docker
#     volume first mounted there inherits node ownership — both the non-root
#     stager and the non-root runner can then write to the workspace without any
#     capability (no CAP_CHOWN, no root). See docs/audits/PHASE_A3_RUNNER_SANDBOX.md.
FROM node:24-alpine
RUN apk add --no-cache git \
 && mkdir -p /workspace \
 && chown node:node /workspace \
 && chmod 0755 /workspace
USER node
WORKDIR /workspace
# No default network use, no secrets, no entrypoint work: the executor supplies a
# deterministic, bounded command per invocation.
CMD ["node", "--version"]
